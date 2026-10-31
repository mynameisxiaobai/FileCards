'use strict';

/**
 * 端到端验证
 *
 * 关于方法的一点说明：
 *   最初想用 CDP 的 Input.dispatchDragEvent 直接模拟"从资源管理器拖文件进来"，
 *   但实测 drop 会被 Chromium 降级成 dragleave（该接口假设拖拽会话已存在，
 *   用于 DevTools 重放被拦截的拖拽，不适合从零发起一次外部拖入）。
 *
 *   所以改用：DOM.setFileInputFiles 拿到磁盘上真实的 File 对象
 *   → 放进一个真实 DataTransfer → dispatch 一个 drop 事件到卡片。
 *   这样 handleDrop 里读到的 items/getAsFile 与真实拖放完全一致，
 *   webUtils.getPathForFile 也能拿到真实路径，链路覆盖不打折。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9222;
const ROOT = path.join(__dirname, '..');
const E2E = path.join(ROOT, '.e2e');
const OUT = path.join(E2E, 'shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: p, family: 4 }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(d));
      })
      .on('error', reject);
  });
}

async function connect() {
  const list = JSON.parse(await httpGet('/json/list'));
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有找到页面目标');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let seq = 0;
  const pending = new Map();

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  return { ws, send };
}

async function shot(send, name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(OUT, `${name}.png`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}

async function evalJson(send, expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800));
  return r.result.value;
}

/** 把真实磁盘文件塞进一个隐藏 file input，返回 nodeId */
async function setFileInput(send, files) {
  await evalJson(
    send,
    `(() => {
      let inp = document.getElementById('__e2e_input');
      if (!inp) {
        inp = document.createElement('input');
        inp.type = 'file';
        inp.id = '__e2e_input';
        inp.multiple = true;
        inp.style.cssText = 'position:fixed;left:-9999px;top:0;';
        document.body.appendChild(inp);
      }
      inp.value = '';
      return true;
    })()`
  );

  const doc = await send('DOM.getDocument', { depth: 1 });
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#__e2e_input' });
  if (!node.nodeId) throw new Error('找不到注入的 input');

  await send('DOM.setFileInputFiles', { files, nodeId: node.nodeId });
  return node.nodeId;
}

/** 用真实 File 对象构造 DataTransfer 并派发 drop 到指定卡片 */
async function dispatchDrop(send, cardId, files) {
  await setFileInput(send, files);

  return evalJson(
    send,
    `(async () => {
      const inp = document.getElementById('__e2e_input');
      const card = document.querySelector('.card[data-id="${cardId}"]');
      if (!card) return { error: 'card not found' };
      const dt = new DataTransfer();
      for (const f of inp.files) dt.items.add(f);

      // 先模拟悬停，让 UI 进入拖入态
      const r = card.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, dataTransfer: dt,
                     clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
      card.dispatchEvent(new DragEvent('dragenter', opts));
      card.dispatchEvent(new DragEvent('dragover', opts));
      const hover = card.classList.contains('is-over');

      // 真正派发 drop
      const paths = [];
      const virtual = [];
      for (const item of dt.items) {
        if (item.kind !== 'file') continue;
        const f = item.getAsFile();
        const p = window.bridge.pathForFile(f);
        (p ? paths : virtual).push(p || f.name);
      }

      card.dispatchEvent(new DragEvent('drop', opts));
      return { hover, paths, virtual, fileCount: inp.files.length };
    })()`
  );
}

// ---------------------------------------------------------------------------

(async () => {
  const { ws, send } = await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await sleep(400);

  const srcFile = path.join(E2E, 'src', '报告.txt');
  const srcDir = path.join(E2E, 'src', '项目');

  let bad = 0;
  const check = (name, ok, extra = '') => {
    console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${extra ? '  ' + extra : ''}`);
    if (!ok) bad++;
  };

  console.log('\n[1] 初始界面');
  await shot(send, '01-initial');
  const init = await evalJson(
    send,
    `JSON.stringify({cards: document.querySelectorAll('.card').length,
      names: [...document.querySelectorAll('.card-name')].map(n => n.textContent)})`
  );
  console.log('  ', init);

  console.log('\n[2] 拖 报告.txt 到卡片1（目标已有同名文件）');
  const d1 = await dispatchDrop(send, 'c1', [srcFile]);
  console.log('   hover=', d1.hover, ' paths=', JSON.stringify(d1.paths));
  check('webUtils 取到真实磁盘路径', Array.isArray(d1.paths) && d1.paths.length === 1 && path.isAbsolute(d1.paths[0]), d1.paths?.[0] || '');
  check('dragover 触发 hover 高亮', d1.hover === true);
  await sleep(1500);
  await shot(send, '02-after-drop-file');

  const st1 = await evalJson(send, `document.querySelector('.card[data-id="c1"] .card-status').textContent`);
  console.log('   卡片1 状态:', JSON.stringify(st1));

  console.log('\n[3] 拖 项目 文件夹到卡片2');
  const d2 = await dispatchDrop(send, 'c2', [srcDir]);
  console.log('   paths=', JSON.stringify(d2.paths));
  await sleep(1500);
  await shot(send, '03-after-drop-dir');

  const st2 = await evalJson(send, `document.querySelector('.card[data-id="c2"] .card-status').textContent`);
  console.log('   卡片2 状态:', JSON.stringify(st2));

  console.log('\n[4] 文件系统核对');
  const dst = path.join(E2E, 'dst');
  const dst2 = path.join(E2E, 'dst2');
  const list1 = fs.readdirSync(dst);
  const list2 = fs.readdirSync(dst2);
  console.log('   .e2e/dst  :', JSON.stringify(list1));
  console.log('   .e2e/dst2 :', JSON.stringify(list2));

  check('原有同名文件内容未变', fs.readFileSync(path.join(dst, '报告.txt'), 'utf8') === 'conflict-old');
  check('新文件改名到位', list1.includes('报告 (1).txt'));
  check(
    '新文件内容正确',
    list1.includes('报告 (1).txt') &&
      fs.readFileSync(path.join(dst, '报告 (1).txt'), 'utf8') === 'hello-from-e2e'
  );
  check('源文件已移走', !fs.existsSync(srcFile));
  check('文件夹整体到位', fs.existsSync(path.join(dst2, '项目', 'inner', 'deep.txt')));
  check('源文件夹已移走', !fs.existsSync(srcDir));
  check(
    '没有残留临时件',
    ![...list1, ...list2].some((n) => n.includes('.wbmove-'))
  );

  console.log('\n[5] 失败可读性：拖一个不存在的路径');
  const ghost = await dispatchDrop(send, 'c1', [srcFile]); // 源已被移走
  await sleep(900);
  const st3 = await evalJson(send, `document.querySelector('.card[data-id="c1"] .card-status').textContent`);
  console.log('   卡片1 状态:', JSON.stringify(st3));
  check('状态行给出了可读提示', typeof st3 === 'string' && st3.length > 0);

  console.log(`\n${bad === 0 ? '\x1b[32m端到端通过\x1b[0m' : `\x1b[31m${bad} 项失败\x1b[0m`}`);
  ws.close();
  process.exitCode = bad === 0 ? 0 : 1;
})().catch((e) => {
  console.error('E2E 失败:', e.message);
  process.exitCode = 1;
});
