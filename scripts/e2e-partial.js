'use strict';

/** 验证「部分成功 + 失败」的界面表达，以及详情浮层。 */

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

(async () => {
  const list = JSON.parse(await httpGet('/json/list'));
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    return r.result?.result?.value;
  };

  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');

  // 1. 删回 2 张卡片（点真实按钮，走完整渲染链路）
  const removed = await evaluate(`
    (async () => {
      for (let i = 0; i < 6; i++) {
        const cards = [...document.querySelectorAll('.card')];
        if (cards.length <= 2) break;
        const btn = cards[cards.length - 1].querySelector('.card-remove');
        if (!btn) break;
        btn.click();
        await new Promise(r => setTimeout(r, 520));
      }
      return document.querySelectorAll('.card').length;
    })()`);
  console.log('剩余卡片:', removed);
  await sleep(600);

  // 2. 准备一个正常文件
  const okFile = path.join(E2E, 'src', '正常.txt');
  fs.mkdirSync(path.dirname(okFile), { recursive: true });
  fs.writeFileSync(okFile, 'ok-content', 'utf8');
  const badDir = E2E; // 卡片目标是 .e2e/dst，把 .e2e 拖进去 = 把父目录塞进自己的子目录 → 必须被拒

  // 3. 注入 input 并派发 drop
  await evaluate(`
    (() => {
      let inp = document.getElementById('__e2e_input');
      if (!inp) {
        inp = document.createElement('input');
        inp.type = 'file'; inp.id = '__e2e_input'; inp.multiple = true;
        inp.style.cssText = 'position:fixed;left:-9999px;top:0;';
        document.body.appendChild(inp);
      }
      inp.value = '';
      return true;
    })()`);

  const hasInput = await evaluate(`!!document.getElementById('__e2e_input')`);
  console.log('input 已注入:', hasInput);

  const doc = await send('DOM.getDocument', { depth: 1 });
  const node = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#__e2e_input' });
  if (!node.result?.nodeId) throw new Error('找不到注入的 input，nodeId=' + JSON.stringify(node.result));
  await send('DOM.setFileInputFiles', { files: [okFile, badDir], nodeId: node.result.nodeId });

  const dispatched = await evaluate(`
    (() => {
      const inp = document.getElementById('__e2e_input');
      const card = document.querySelector('.card');
      const dt = new DataTransfer();
      for (const f of inp.files) dt.items.add(f);
      const r = card.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, dataTransfer: dt,
                     clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
      card.dispatchEvent(new DragEvent('dragenter', opts));
      card.dispatchEvent(new DragEvent('dragover', opts));
      card.dispatchEvent(new DragEvent('drop', opts));
      return { files: inp.files.length };
    })()`);
  console.log('已派发 drop, 文件数:', dispatched.files);

  await sleep(2200);
  await shot('11-partial-fail');

  const statusText = await evaluate(`document.querySelector('.card .card-status').textContent`);
  const statusClass = await evaluate(`document.querySelector('.card .card-status').className`);
  console.log('状态行:', JSON.stringify(statusText), '| class:', statusClass);

  // 4. 点开详情
  const opened = await evaluate(`
    (() => {
      const st = document.querySelector('.card .card-status');
      st.click();
      return !document.getElementById('detail').classList.contains('is-hidden');
    })()`);
  console.log('详情浮层已打开:', opened);
  await sleep(400);
  await shot('12-detail-panel');

  const items = await evaluate(
    `JSON.stringify([...document.querySelectorAll('.detail-item')].map(li => ({
       cls: li.className, text: li.textContent.trim()
     })))`
  );
  console.log('详情条目:', items);

  // 5. 关闭详情
  await evaluate(`document.getElementById('detail-close').click()`);
  await sleep(300);

  // 6. 还原配置，回到干净的两张卡
  console.log('\n清理：把残留文件移回');
  const dst = path.join(E2E, 'dst');
  for (const n of fs.readdirSync(dst)) {
    if (n === '报告.txt') continue;
    try {
      fs.renameSync(path.join(dst, n), path.join(E2E, 'src', n));
    } catch {}
  }

  ws.close();
})().catch((e) => {
  console.error('失败:', e.message);
  process.exitCode = 1;
});
