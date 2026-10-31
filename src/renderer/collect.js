'use strict';

// 注意：contextBridge 暴露的全局名是 collect，顶层再 const collect 会直接抛
// "Identifier 'collect' has already been declared"，所以换一个名字。
const CP = window.collect;

const srcEl = document.getElementById('drop-src');
const tgtEl = document.getElementById('drop-tgt');
const prefixEl = document.getElementById('opt-prefix');
const moveEl = document.getElementById('opt-move');
const noteEl = document.getElementById('note');
const tipsEl = document.getElementById('tips');
const runEl = document.getElementById('run');
const runTextEl = document.getElementById('run-text');
const runCountEl = document.getElementById('run-count');
const barEl = document.getElementById('bar-fill');
const resultEl = document.getElementById('result');
const resultHeadEl = document.getElementById('result-head');
const resultListEl = document.getElementById('result-list');
const startBtn = document.getElementById('start');
const cancelBtn = document.getElementById('cancel');
const closeBtn = document.getElementById('close');
const openTargetBtn = document.getElementById('open-target');

const zones = {
  src: {
    el: srcEl,
    path: null,
    info: null,
    nameEl: srcEl.querySelector('.drop-name'),
    pathEl: srcEl.querySelector('.drop-path'),
  },
  tgt: {
    el: tgtEl,
    path: null,
    info: null,
    nameEl: tgtEl.querySelector('.drop-name'),
    pathEl: tgtEl.querySelector('.drop-path'),
  },
};

let running = false;
let lastTarget = null;

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

(async function boot() {
  bindGlobal();
  bindZone('src');
  bindZone('tgt');

  let d = null;
  try {
    d = await CP.defaults();
  } catch {
    /* 拿不到就用默认值 */
  }
  if (d) {
    prefixEl.checked = d.prefix !== false;
    moveEl.checked = d.move === true;
    if (d.targetDir) await setFolder('tgt', d.targetDir, { quiet: true });
  }
})();

// ---------------------------------------------------------------------------
// 目标选择
// ---------------------------------------------------------------------------

const nf = new Intl.NumberFormat('zh-CN');

function basename(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const parts = s.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

function shorten(p, max = 62) {
  const s = String(p || '');
  if (s.length <= max) return s;
  const parts = s.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return s;
  return `${parts[0]}\\…\\${parts[parts.length - 1]}`;
}

function renderZone(kind) {
  const z = zones[kind];
  const has = !!z.path;
  z.el.classList.toggle('is-set', has);
  z.el.title = z.path || '';

  if (!has) {
    z.nameEl.textContent = '拖入文件夹，或点击选择';
    z.pathEl.textContent = '';
    return;
  }

  z.nameEl.textContent = basename(z.path);
  const bits = [shorten(z.path)];
  if (z.info) {
    if (z.info.files > 0) {
      // 预扫为了不卡界面只数到 5000，超了就标个 +
      bits.push(`· ${nf.format(z.info.files)}${z.info.truncated ? '+' : ''} 个文件`);
    } else {
      bits.push('· 里面没有文件');
    }
  }
  z.pathEl.textContent = bits.join(' ');
}

async function setFolder(kind, p, { quiet = false } = {}) {
  const z = zones[kind];
  if (!p || typeof p !== 'string') return;

  // 拖进来的可能是文件，先确认类型；顺便数一下有多少文件
  let info = null;
  try {
    info = await CP.inspect(p);
  } catch {
    info = null;
  }

  if (!info || !info.isDir) {
    z.el.classList.add('is-bad');
    setTimeout(() => z.el.classList.remove('is-bad'), 700);
    if (!quiet) note(info && info.error ? info.error : '这里要放文件夹，单个文件不行', 'err');
    return;
  }

  z.path = p;
  z.info = info;
  if (kind === 'tgt') lastTarget = p;
  renderZone(kind);
  hideNote();
  clearResult();
  syncButtons();
}

async function pick(kind) {
  if (running) return;
  const r = await CP.pick(kind);
  if (r && r.path) await setFolder(kind, r.path);
}

// ---------------------------------------------------------------------------
// 拖放
// ---------------------------------------------------------------------------

function bindZone(kind) {
  const z = zones[kind];
  const el = z.el;
  let depth = 0;

  const clear = () => {
    depth = 0;
    el.classList.remove('is-over');
  };

  el.addEventListener('click', () => pick(kind));

  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(kind);
    }
  });

  el.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    el.classList.add('is-over');
  });

  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  el.addEventListener('dragleave', () => {
    depth--;
    if (depth <= 0) clear();
  });

  el.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clear();

    // DataTransferItemList 在回调返回后立刻失效，这一段必须完全同步
    let p = '';
    const items = e.dataTransfer ? Array.from(e.dataTransfer.items || []) : [];
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      p = CP.pathForFile(file);
      if (p) break;
    }
    if (!p && e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      p = CP.pathForFile(e.dataTransfer.files[0]);
    }

    if (!p) {
      note('没识别到文件夹，试试从资源管理器直接拖过来', 'err');
      return;
    }
    void setFolder(kind, p);
  });
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

function syncButtons() {
  startBtn.textContent = running ? '停止收集' : '开始收集';
  startBtn.classList.toggle('primary', !running);
  startBtn.classList.toggle('stop', running);
  cancelBtn.textContent = running ? '关闭' : '取消';
  openTargetBtn.classList.toggle('is-hidden', running || !lastTarget);
}

async function start() {
  if (running) {
    startBtn.disabled = true;
    startBtn.textContent = '正在停止…';
    await CP.cancel();
    return;
  }

  const src = zones.src.path;
  const tgt = zones.tgt.path;

  if (!src) {
    note('先选一个源文件夹', 'err');
    shake(srcEl);
    return;
  }
  if (!tgt) {
    note('再选一个目标文件夹', 'err');
    shake(tgtEl);
    return;
  }
  if (src.toLowerCase() === tgt.toLowerCase()) {
    note('源文件夹和目标文件夹不能是同一个', 'err');
    shake(tgtEl);
    return;
  }

  clearResult();
  hideNote();
  running = true;
  startBtn.disabled = false;
  runEl.classList.remove('is-hidden');
  setProgress(0, { name: '准备中…', text: '正在扫描文件夹…' });
  syncButtons();
  syncPanels();

  let res;
  try {
    res = await CP.start({
      srcDir: src,
      targetDir: tgt,
      prefix: prefixEl.checked,
      move: moveEl.checked,
    });
  } catch (e) {
    finishRun();
    note(`收集失败：${(e && e.message) || '未知错误'}`, 'err');
    return;
  }

  finishRun();

  if (!res || res.error) {
    note((res && res.message) || '收集失败', 'err');
    return;
  }

  showResult(res);
}

function finishRun() {
  running = false;
  startBtn.disabled = false;
  runEl.classList.add('is-hidden');
  syncButtons();
  syncPanels();
}

/** 空闲时显示规则说明，跑起来时让位；结果有问题时也让位给结果面板 */
function syncPanels() {
  const runningNow = !runEl.classList.contains('is-hidden');
  const hasResult = !resultEl.classList.contains('is-hidden');
  const flat = resultEl.classList.contains('is-flat');
  tipsEl.classList.toggle('is-hidden', runningNow || (hasResult && !flat));
}

function setProgress(p, extra = {}) {
  const pct = p && p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
  barEl.style.width = `${pct}%`;
  if (p && p.total) {
    runTextEl.textContent = extra.name ? `正在收集：${extra.name}` : (extra.text || '');
    runCountEl.textContent = `${nf.format(p.done)} / ${nf.format(p.total)}`;
  } else {
    runTextEl.textContent = extra.text || '准备中…';
    runCountEl.textContent = '';
  }
}

// ---------------------------------------------------------------------------
// 结果
// ---------------------------------------------------------------------------

function showResult(res) {
  lastTarget = res.targetDir;
  syncButtons();
  openTargetBtn.classList.remove('is-hidden');

  const bits = [`已收集 <b>${nf.format(res.collected)}</b> 个文件`];
  if (res.renamed > 0) bits.push(`<span class="warn">${nf.format(res.renamed)} 个重命名</span>`);
  if (res.warning > 0) bits.push(`<span class="warn">${nf.format(res.warning)} 个需确认</span>`);
  if (res.failed > 0) bits.push(`<span class="bad">${nf.format(res.failed)} 个失败</span>`);
  if (res.skipped > 0) bits.push(`${nf.format(res.skipped)} 个跳过`);
  if (res.canceled) bits.push('<span class="warn">已中途停止</span>');
  if (res.collected > 0 && res.failed === 0 && res.warning === 0) {
    bits.push('<span class="ok">全部完成</span>');
  }
  resultHeadEl.innerHTML = bits.join(' · ');

  const problems = [];
  for (const r of res.results || []) {
    if (r.status === 'failed' || r.status === 'warning') problems.push(r);
  }
  for (const s of res.skippedList || []) {
    problems.push({
      srcName: s.rel || s.name,
      status: 'skipped',
      message: s.code === 'SYMLINK' ? '符号链接已跳过' : '不支持的类型，已跳过',
    });
  }

  resultListEl.innerHTML = '';
  for (const p of problems.slice(0, 200)) {
    const li = document.createElement('li');
    li.className = `result-item ${p.status === 'failed' ? 'err' : 'warn'}`;

    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = p.status === 'failed' ? '!' : '–';

    const box = document.createElement('div');
    box.style.minWidth = '0';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent =
      p.finalName && p.srcName && p.finalName !== p.srcName ? `${p.srcName} → ${p.finalName}` : p.srcName || '';

    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = p.message || '';

    box.appendChild(name);
    if (p.message) box.appendChild(msg);
    li.appendChild(mark);
    li.appendChild(box);
    resultListEl.appendChild(li);
  }

  if (problems.length === 0) {
    resultListEl.classList.add('is-hidden');
  } else {
    resultListEl.classList.remove('is-hidden');
    if (problems.length > 200) {
      const li = document.createElement('li');
      li.className = 'result-item';
      li.textContent = `… 还有 ${problems.length - 200} 条未显示`;
      resultListEl.appendChild(li);
    }
  }

  // 没有问题就不铺开结果面板，只留一行摘要，空出来的地方还给规则说明
  resultEl.classList.toggle('is-flat', problems.length === 0);
  resultEl.classList.remove('is-hidden');
  syncPanels();
}

function clearResult() {
  resultEl.classList.add('is-hidden');
  resultEl.classList.remove('is-flat');
  resultListEl.innerHTML = '';
  resultListEl.classList.remove('is-hidden');
  resultHeadEl.innerHTML = '';
  syncPanels();
}

function note(text, kind) {
  noteEl.textContent = text;
  noteEl.classList.toggle('is-err', kind === 'err');
  noteEl.classList.remove('is-hidden');
}

function hideNote() {
  noteEl.classList.add('is-hidden');
  noteEl.textContent = '';
}

function shake(el) {
  el.classList.add('is-bad');
  setTimeout(() => el.classList.remove('is-bad'), 700);
}

// ---------------------------------------------------------------------------
// 全局事件
// ---------------------------------------------------------------------------

function bindGlobal() {
  // 拖到窗口任何地方都不许导航
  for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    window.addEventListener(type, (e) => e.preventDefault(), true);
  }

  startBtn.addEventListener('click', () => void start());
  cancelBtn.addEventListener('click', () => {
    if (running) {
      // 关闭前先请求停止，已复制的文件保留，源文件不受影响
      void CP.cancel();
    }
    void CP.close();
  });
  closeBtn.addEventListener('click', () => {
    if (running) void CP.cancel();
    void CP.close();
  });
  openTargetBtn.addEventListener('click', () => {
    if (lastTarget) void CP.reveal(lastTarget);
  });

  prefixEl.addEventListener('change', () => {
    void CP.remember({ prefix: prefixEl.checked, move: moveEl.checked });
  });
  moveEl.addEventListener('change', () => {
    if (moveEl.checked && !moveEl.dataset.warned) {
      moveEl.dataset.warned = '1';
      note('已开启「移走后删除原文件」：复制校验通过后才会删除源文件，失败时两份都会保留。');
    } else if (!moveEl.checked) {
      hideNote();
    }
    void CP.remember({ prefix: prefixEl.checked, move: moveEl.checked });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (running) void CP.cancel();
      void CP.close();
    } else if (e.key === 'Enter' && !running && e.target === document.body) {
      e.preventDefault();
      void start();
    }
  });

  CP.onProgress((p) => {
    if (!running) return;
    setProgress(p, { name: p.name });
  });
}
