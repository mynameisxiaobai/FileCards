'use strict';

// 注意：contextBridge 暴露的 bridge 已经占用了全局名，顶层再 const bridge 会
// 抛 "Identifier 'bridge' has already been declared"，所以这里换个名字。
const API = window.bridge;

const gridEl = document.getElementById('grid');
const pinBtn = document.getElementById('pin');
const addBtn = document.getElementById('add');
const hideBtn = document.getElementById('hide');
const collectBtn = document.getElementById('collect');
const detailEl = document.getElementById('detail');
const detailListEl = document.getElementById('detail-list');
const detailCloseBtn = document.getElementById('detail-close');
const scrimEl = document.getElementById('scrim');
const toastEl = document.getElementById('toast');

const MAX_CARDS = 6;

let state = { cards: [], alwaysOnTop: false };
/** cardId -> { text, kind, results } 重渲染时用来恢复状态行 */
const cardUI = new Map();
let toastTimer = null;

const ICON_FOLDER = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
     stroke-linecap="round" stroke-linejoin="round">
  <path d="M3.2 7.4A1.6 1.6 0 0 1 4.8 5.8h3.4l1.7 2.1h8.3A1.6 1.6 0 0 1 19.8 9.5v7.1a1.6 1.6 0 0 1-1.6 1.6H4.8a1.6 1.6 0 0 1-1.6-1.6z" />
  <path d="M12 11v4.6M10.1 13.7 12 15.6l1.9-1.9" />
</svg>`;

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

(async function boot() {
  bindGlobal();
  initResize();
  try {
    state = await API.init();
  } catch (e) {
    console.error('初始化失败', e);
  }
  render();
  // 卡片尺寸完全由网格单元决定，这里只按实测高度切换紧凑档位
  new ResizeObserver(() => syncCardMetrics()).observe(gridEl);
})();

// ---------------------------------------------------------------------------
// 布局档位：卡片吃满可用空间，只保证与窗口边缘的留白恒定
// ---------------------------------------------------------------------------

/**
 * 12 条等宽轨道上的分配方案 —— 每张卡跨几条轨道。
 * 一行的跨度之和永远是 12，所以最后一行也铺满，不会留豁口：
 *   2 张 6+6 / 3 张 4+4+4 / 4 张 6+6 两行 / 5 张 4+4+4 + 6+6 / 6 张 4×6
 */
function columnSpans(n) {
  switch (n) {
    case 1:
      return [12];
    case 2:
      return [6, 6];
    case 3:
      return [4, 4, 4];
    case 4:
      return [6, 6, 6, 6];
    case 5:
      return [4, 4, 4, 6, 6];
    default:
      return [4, 4, 4, 4, 4, 4];
  }
}

function rowCount(n) {
  return n <= 3 ? 1 : 2;
}

/**
 * 卡片被拖得很矮时让内容让位（隐藏图标、状态条收一行）。
 * 注意：这是「结构让位」，不是按卡片尺寸等比缩放字号。
 */
function syncCardMetrics() {
  const first = gridEl.querySelector('.card');
  const h = first ? first.getBoundingClientRect().height : 0;
  gridEl.classList.toggle('is-compact', h > 0 && h < 132);
  gridEl.classList.toggle('is-tiny', h > 0 && h < 104);
}

// ---------------------------------------------------------------------------
// 窗口边框缩放
// ---------------------------------------------------------------------------

function initResize() {
  const MIN_W = 240;
  const MIN_H = 200;

  /** drag = { dir, sx, sy, start, next } */
  let drag = null;
  let rafId = 0;

  const push = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (drag && drag.next) void API.setBounds(drag.next);
    });
  };

  const onMove = (e) => {
    if (!drag || !drag.start) return;

    const dx = e.screenX - drag.sx;
    const dy = e.screenY - drag.sy;
    const s = drag.start;
    const d = drag.dir;

    let x = s.x;
    let y = s.y;
    let width = s.width;
    let height = s.height;

    if (d.includes('e')) width = s.width + dx;
    if (d.includes('s')) height = s.height + dy;
    if (d.includes('w')) {
      width = s.width - dx;
      x = s.x + dx;
    }
    if (d.includes('n')) {
      height = s.height - dy;
      y = s.y + dy;
    }

    // 撞到最小尺寸时，钉住对面那条边，否则窗口会往反方向跑
    if (width < MIN_W) {
      if (d.includes('w')) x = s.x + s.width - MIN_W;
      width = MIN_W;
    }
    if (height < MIN_H) {
      if (d.includes('n')) y = s.y + s.height - MIN_H;
      height = MIN_H;
    }

    drag.next = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
    push();
  };

  const finish = (revert) => {
    if (!drag) return;
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    window.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('is-resizing');

    const target = revert ? drag.start : drag.next;
    drag = null;
    if (target) void API.setBounds(target);
  };

  const onUp = () => finish(false);
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      finish(true);
    }
  };

  for (const el of document.querySelectorAll('[data-rz]')) {
    el.addEventListener('mousedown', async (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      drag = { dir: el.dataset.rz, sx: e.screenX, sy: e.screenY, start: null, next: null };
      document.body.classList.add('is-resizing');
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
      window.addEventListener('keydown', onKey, true);

      const b = await API.getBounds();
      if (!drag) return;
      if (b) drag.start = b;
      else finish(true); // 拿不到窗口边界就放弃这次拖拽，别留下监听器
    });
  }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function render() {
  const n = Math.max(state.cards.length, 1);
  const spans = columnSpans(n);
  const rows = rowCount(n);

  gridEl.style.setProperty('--rows', rows);
  gridEl.innerHTML = '';

  state.cards.forEach((card, i) => {
    const el = buildCard(card);
    // 每张卡跨几条轨道，由总张数决定；行高由 --rows 均分
    el.style.gridColumn = `span ${spans[i] || 4}`;
    gridEl.appendChild(el);
  });

  pinBtn.classList.toggle('on', !!state.alwaysOnTop);
  pinBtn.title = state.alwaysOnTop ? '取消置顶' : '窗口置顶';
  addBtn.disabled = state.cards.length >= MAX_CARDS;

  syncCardMetrics();
}

function buildCard(card) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = card.id;
  el.dataset.dir = card.dir ? '1' : '';
  if (!card.dir) el.classList.add('is-unset');

  el.innerHTML = `
    <button class="card-remove" title="删除这张卡片" aria-label="删除这张卡片">
      <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
        <path d="M2 2l6 6M8 2l-6 6" />
      </svg>
    </button>
    <div class="card-body">
      <div class="card-main">
        <span class="card-icon">${ICON_FOLDER}</span>
        <div class="card-name"></div>
        <div class="card-path"></div>
      </div>
      <div class="card-status"></div>
    </div>
    <div class="card-hint">松开即移动</div>
  `;

  // 用户可控文本一律走 textContent
  el.querySelector('.card-name').textContent = card.label || '未命名';

  const pathEl = el.querySelector('.card-path');
  if (card.dir) {
    pathEl.textContent = shortenPath(card.dir);
    pathEl.title = card.dir;
  } else {
    pathEl.textContent = '点击选择文件夹';
  }

  // 恢复上一次的结果状态
  const saved = cardUI.get(card.id);
  if (saved && saved.text) applyStatus(el, saved.text, saved.kind, card.id);

  el.addEventListener('click', (e) => {
    if (e.target.closest('.card-remove')) return;
    if (!card.dir) void chooseDir(card.id);
  });

  el.addEventListener('dblclick', (e) => {
    if (e.target.closest('.card-remove')) return;
    void chooseDir(card.id);
  });

  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    void API.cardMenu(card.id);
  });

  el.querySelector('.card-remove').addEventListener('click', async (e) => {
    e.stopPropagation();
    const r = await API.removeCard(card.id);
    applyState(r && r.state);
  });

  bindDrop(el, card);
  return el;
}

// ---------------------------------------------------------------------------
// 拖放
// ---------------------------------------------------------------------------

function bindDrop(el, card) {
  let depth = 0;

  const clear = () => {
    depth = 0;
    el.classList.remove('is-over');
  };

  el.addEventListener('dragenter', (e) => {
    if (!card.dir) return;
    e.preventDefault();
    depth++;
    el.classList.add('is-over');
  });

  el.addEventListener('dragover', (e) => {
    if (!card.dir) {
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });

  el.addEventListener('dragleave', () => {
    depth--;
    if (depth <= 0) clear();
  });

  el.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clear();
    handleDrop(el, card, e);
  });
}

function handleDrop(el, card, e) {
  if (!card.dir) {
    toast('先给这张卡片选一个文件夹');
    return;
  }

  // DataTransferItemList 在 drop 回调返回后立刻失效，
  // 所以这一段必须全程同步，绝不能出现 await。
  const paths = [];
  let virtualCount = 0;

  const items = e.dataTransfer ? Array.from(e.dataTransfer.items || []) : [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;
    const p = API.pathForFile(file);
    if (p) paths.push(p);
    else virtualCount++;
  }

  if (paths.length === 0) {
    toast(virtualCount > 0 ? '这些内容还没有保存到磁盘，请先另存为文件' : '没有识别到文件');
    return;
  }

  void runMove(el, card, paths);
}

async function runMove(el, card, paths) {
  el.classList.add('is-busy');
  applyStatus(el, `正在移动 0/${paths.length}…`, '', card.id);

  let res;
  try {
    res = await API.moveToCard(card.id, paths);
  } catch (err) {
    el.classList.remove('is-busy');
    applyStatus(el, '移动失败，请重试', 'err', card.id);
    flash(el, 'is-error');
    return;
  }

  el.classList.remove('is-busy');

  if (!res || res.error) {
    const msg = (res && res.message) || '移动失败';
    applyStatus(el, msg, 'err', card.id);
    toast(msg);
    flash(el, 'is-error');
    return;
  }

  const { summary, results } = res;

  if (summary.failed > 0) {
    applyStatus(el, `${summary.ok} 成功 · ${summary.failed} 失败 ›`, 'err', card.id, results);
    flash(el, 'is-error');
    return;
  }

  if (summary.warning > 0) {
    applyStatus(el, `${summary.ok} 已到位 · ${summary.warning} 需确认 ›`, 'warn', card.id, results);
    return;
  }

  if (summary.ok > 0) {
    applyStatus(el, successText(summary), 'ok', card.id, results);
    flash(el, 'is-success');
    return;
  }

  if (summary.skipped > 0) {
    applyStatus(el, `${summary.skipped} 个已在目标文件夹`, '', card.id, results);
  }
}

function successText(s) {
  const n = s.ok;
  if (s.renamed > 0) return `已移入 ${n} 个 · ${s.renamed} 个重命名`;
  return `已移入 ${n} 个`;
}

// ---------------------------------------------------------------------------
// 状态 / 动画
// ---------------------------------------------------------------------------

function applyStatus(el, text, kind, cardId, results) {
  const prev = cardUI.get(cardId) || {};
  const next = {
    text,
    kind,
    results: results || prev.results || null,
  };
  cardUI.set(cardId, next);

  const st = el.querySelector('.card-status');
  if (!st) return;
  st.textContent = text || '';
  st.className = 'card-status' + (kind ? ` is-${kind}` : '');
  st.title = text || '';

  const clickable = (kind === 'err' || kind === 'warn') && next.results;
  st.style.cursor = clickable ? 'pointer' : '';
  st.onclick = clickable
    ? (e) => {
        e.stopPropagation();
        openDetail(next.results);
      }
    : null;
}

function setStatusById(cardId, text, kind) {
  const el = findCardEl(cardId);
  if (!el) {
    const prev = cardUI.get(cardId) || {};
    cardUI.set(cardId, { ...prev, text, kind });
    return;
  }
  applyStatus(el, text, kind, cardId);
}

function flash(el, cls) {
  el.classList.add(cls);
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    el.classList.remove(cls);
    el.removeEventListener('animationend', end);
  };
  el.addEventListener('animationend', end);
  // 动画被 prefers-reduced-motion 关掉时 animationend 不触发，兜底移除
  setTimeout(end, 900);
}

function findCardEl(cardId) {
  return gridEl.querySelector(`.card[data-id="${CSS.escape(String(cardId))}"]`);
}

function clearAllHover() {
  for (const el of gridEl.querySelectorAll('.card.is-over')) {
    el.classList.remove('is-over');
  }
}

// ---------------------------------------------------------------------------
// 详情浮层
// ---------------------------------------------------------------------------

function openDetail(results) {
  if (!Array.isArray(results) || results.length === 0) return;

  detailListEl.innerHTML = '';
  for (const r of results) {
    const li = document.createElement('li');
    const kind =
      r.status === 'failed' ? 'err' : r.status === 'skipped' ? 'skip' : r.status === 'warning' ? 'warn' : 'ok';
    li.className = `detail-item ${kind}`;

    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = kind === 'ok' ? '✓' : kind === 'skip' ? '–' : '!';

    const text = document.createElement('div');
    text.style.minWidth = '0';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent =
      r.finalName && r.srcName && r.finalName !== r.srcName
        ? `${r.srcName} → ${r.finalName}`
        : r.srcName || String(r.srcPath || '');

    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = r.message || '';

    text.appendChild(name);
    if (r.message) text.appendChild(msg);
    li.appendChild(mark);
    li.appendChild(text);

    const target = r.finalPath || r.srcPath;
    if (target) {
      li.title = `点击定位到：${target}`;
      li.style.cursor = 'pointer';
      li.addEventListener('click', () => API.reveal(target));
    }

    detailListEl.appendChild(li);
  }

  scrimEl.classList.remove('is-hidden');
  detailEl.classList.remove('is-hidden');
}

function closeDetail() {
  detailEl.classList.add('is-hidden');
  scrimEl.classList.add('is-hidden');
}

// ---------------------------------------------------------------------------
// 状态同步
// ---------------------------------------------------------------------------

function applyState(next) {
  if (!next) return;
  const countChanged = !state || next.cards.length !== state.cards.length;
  state = next;
  render();
  if (countChanged) {
    // 只在窗口装不下最小可读卡片时才请求撑大，用户手动设的尺寸不会被抢走
    void API.applyLayout();
  }
}

async function chooseDir(cardId) {
  const r = await API.pickDir(cardId);
  if (r && r.state) {
    applyState(r.state);
    // 目录变了，之前的结果状态不再适用
    const prev = cardUI.get(cardId);
    if (prev) cardUI.set(cardId, { ...prev, text: '', kind: '' });
    const el = findCardEl(cardId);
    if (el) {
      const st = el.querySelector('.card-status');
      if (st) {
        st.textContent = '';
        st.className = 'card-status';
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 行内重命名
// ---------------------------------------------------------------------------

function renameInline(cardId, current) {
  const el = findCardEl(cardId);
  if (!el) return;
  const nameEl = el.querySelector('.card-name');
  if (!nameEl) return;

  const input = document.createElement('input');
  input.className = 'card-name-input';
  input.value = current || '';
  input.maxLength = 24;
  input.spellcheck = false;

  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v) {
      const r = await API.renameCard(cardId, v);
      if (r && r.state) {
        state = r.state;
        render();
        return;
      }
    }
    render();
  };

  input.addEventListener('blur', () => commit(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      done = true;
      render();
    }
  });
}

// ---------------------------------------------------------------------------
// toast
// ---------------------------------------------------------------------------

function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.remove('is-hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.add('is-hidden');
    toastTimer = null;
  }, 2600);
}

// ---------------------------------------------------------------------------
// 全局事件
// ---------------------------------------------------------------------------

function bindGlobal() {
  // 三层防导航的第一层：任何地方拖入都不许跳转
  for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    window.addEventListener(type, (e) => e.preventDefault(), true);
  }

  window.addEventListener('dragend', clearAllHover);
  window.addEventListener('drop', clearAllHover, true);
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) clearAllHover();
  });

  pinBtn.addEventListener('click', async () => {
    const r = await API.setAlwaysOnTop(!state.alwaysOnTop);
    state.alwaysOnTop = !!(r && r.alwaysOnTop);
    pinBtn.classList.toggle('on', state.alwaysOnTop);
    pinBtn.title = state.alwaysOnTop ? '取消置顶' : '窗口置顶';
  });

  addBtn.addEventListener('click', async () => {
    const r = await API.addCard();
    applyState(r && r.state);
  });

  hideBtn.addEventListener('click', () => API.hideToTray());
  collectBtn.addEventListener('click', () => API.openCollect());
  detailCloseBtn.addEventListener('click', closeDetail);
  scrimEl.addEventListener('click', closeDetail);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDetail();
  });

  API.onStateChanged(applyState);

  API.onProgress(({ cardId, done, total }) => {
    if (done < total) setStatusById(cardId, `正在移动 ${done}/${total}…`, '');
  });

  API.onEditLabel((id, label) => renameInline(id, label));
}

// ---------------------------------------------------------------------------
// 路径缩短：C:\Users\me\Downloads\Inbox -> C:\…\Inbox
// ---------------------------------------------------------------------------

function shortenPath(p, max = 30) {
  if (!p) return '';
  const norm = String(p).replace(/\//g, '\\');
  if (norm.length <= max) return norm;
  const segs = norm.split('\\').filter(Boolean);
  if (segs.length <= 2) return norm;
  const head = segs[0];
  const tail = segs[segs.length - 1];
  const short = `${head}\\…\\${tail}`;
  return short.length <= max ? short : `…\\${tail}`;
}
