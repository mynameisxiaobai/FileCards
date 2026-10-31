'use strict';

/**
 * 在页面里执行一段 JS 并打印结果。
 * 用法：node scripts/cdp-eval.js "<表达式>"
 * 例：  node scripts/cdp-eval.js "document.querySelectorAll('.card').length"
 */

const http = require('http');

const PORT = 9222;

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
  const expr = process.argv.slice(2).join(' ') || '1';
  const list = JSON.parse(await httpGet('/json/list'));
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有页面目标');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  const logs = [];

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push('EXCEPTION: ' + (d.exception?.description || d.text));
    }
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

  await send('Runtime.enable');
  await send('Log.enable');

  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
    includeCommandLineAPI: true,
  });

  if (logs.length) {
    console.log('--- console ---');
    for (const l of logs) console.log(l);
    console.log('---------------');
  }

  if (r.result?.exceptionDetails) {
    console.log('EXCEPTION:', JSON.stringify(r.result.exceptionDetails, null, 2).slice(0, 1500));
  } else {
    const v = r.result?.result?.value;
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  }

  ws.close();
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
