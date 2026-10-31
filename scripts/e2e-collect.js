'use strict';

/**
 * 收集弹窗端到端测试
 * 前提：应用已带 --remote-debugging-port=9333 启动
 * 跑法：node scripts/e2e-collect.js
 *
 * 走的是真实交互链路：主窗口点「收集」→ 弹窗出现 → 设置两个文件夹 →
 * 点「开始收集」→ 主进程 collect() → 落盘。最后核对磁盘上的结果。
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const PORT = Number(process.env.CDP_PORT) || 9333;
const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, '.e2e', 'collect');
const SRC = path.join(WORK, 'src');
const TGT = path.join(WORK, 'out');
const SHOT = path.join(ROOT, 'docs', '08-collect.png');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`);
  }
}

function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

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

async function targets() {
  try {
    return JSON.parse(await httpGet('/json/list'));
  } catch {
    return [];
  }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const logs = [];
    let seq = 0;

    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        logs.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
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

    ws.addEventListener('open', () => {
      const send = (method, params = {}) =>
        new Promise((res) => {
          const id = ++seq;
          pending.set(id, res);
          ws.send(JSON.stringify({ id, method, params }));
        });
      resolve({ ws, send, logs });
    });
    ws.addEventListener('error', reject);
  });
}

async function evalIn(conn, expression) {
  const r = await conn.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    includeCommandLineAPI: true,
  });
  if (r.result && r.result.exceptionDetails) {
    const d = r.result.exceptionDetails;
    throw new Error(d.exception?.description || d.text);
  }
  return r.result && r.result.result ? r.result.result.value : undefined;
}

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 120));
  }
}

function listTree(dir) {
  const out = [];
  const walk = (d, rel) => {
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

function q(s) {
  return JSON.stringify(String(s));
}

/** 用 CDP 注入一次真实拖放：把 dirPath 拖到指定拖放区上 */
async function dropFolder(conn, zoneId, dirPath) {
  const pt = await evalIn(
    conn,
    `(() => { const r = document.getElementById(${q(zoneId)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`
  );
  const data = {
    items: [{ mimeType: 'text/uri-list', data: 'file:///' + String(dirPath).replace(/\\/g, '/') }],
    files: [dirPath],
    dragOperationsMask: 1,
  };
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await conn.send('Input.dispatchDragEvent', { type, x: pt[0], y: pt[1], data });
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 500));
}

(async () => {
  // ------------------------------------------------------------------ 样本
  await fsp.rm(WORK, { recursive: true, force: true });
  await fsp.mkdir(path.join(SRC, 'sub', 'deep'), { recursive: true });
  await fsp.mkdir(path.join(SRC, 'sub2'), { recursive: true });
  await fsp.mkdir(TGT, { recursive: true });

  await fsp.writeFile(path.join(SRC, 'a.txt'), 'A-TOP');
  await fsp.writeFile(path.join(SRC, '报告.pdf'), 'REPORT-TOP');
  await fsp.writeFile(path.join(SRC, 'sub', 'b.txt'), 'B');
  await fsp.writeFile(path.join(SRC, 'sub', 'deep', 'c.txt'), 'C');
  await fsp.writeFile(path.join(SRC, 'sub2', '报告.pdf'), 'REPORT-SUB');
  // 目标里预置一个同名文件，验证绝不覆盖
  await fsp.writeFile(path.join(TGT, '1_a.txt'), 'OLD-DO-NOT-TOUCH');

  const srcBefore = listTree(SRC);

  // ------------------------------------------------------- 打开收集弹窗
  console.log('\n收集弹窗 · 端到端\n');

  // 上一轮或手工调试可能留着弹窗，它带着旧状态，会让空状态断言失真 —— 先关掉
  const stale = (await targets()).find((t) => t.type === 'page' && t.url.endsWith('collect.html'));
  if (stale) {
    const c = await connect(stale.webSocketDebuggerUrl);
    await c.send('Runtime.evaluate', { expression: 'window.collect.close()' }).catch(() => {});
    c.ws.close();
    await waitFor(
      async () => !(await targets()).some((t) => t.type === 'page' && t.url.endsWith('collect.html')),
      5000,
      '旧弹窗关闭'
    );
  }

  const list0 = await targets();
  const mainPage = list0.find((t) => t.type === 'page' && t.url.endsWith('index.html'));
  if (!mainPage) throw new Error('没找到主窗口页面，应用是否带 --remote-debugging-port=9333 启动？');

  const main = await connect(mainPage.webSocketDebuggerUrl);
  await main.send('Runtime.enable');

  const btnCount = await evalIn(main, `document.querySelectorAll('#collect').length`);
  ok('主窗口顶部有「收集」菜单项', btnCount === 1, `实际 ${btnCount} 个`);
  const btnText = await evalIn(main, `document.getElementById('collect').textContent.trim()`);
  eq('菜单项文案是「收集」', btnText, '收集');

  await evalIn(main, `document.getElementById('collect').click(); 1`);

  const page = await waitFor(async () => {
    const l = await targets();
    return l.find((t) => t.type === 'page' && t.url.endsWith('collect.html'));
  }, 8000, '收集弹窗出现');
  ok('点击后弹出收集窗口', !!page);

  const win = await connect(page.webSocketDebuggerUrl);
  await win.send('Runtime.enable');
  await win.send('Page.enable');

  // 等脚本跑完（boot 里会读取默认值）
  await waitFor(() => evalIn(win, `typeof setFolder === 'function' && !!window.collect`), 5000, '弹窗脚本就绪');

  // ------------------------------------------------------------ 结构断言
  const title = await evalIn(win, `document.title`);
  eq('窗口标题', title, '收集文件');

  // thickFrame 会让内容区比 BrowserWindow 的 width/height 多 1~2px，留点余量
  const size = await evalIn(win, `[innerWidth, innerHeight]`);
  ok(
    '弹窗内容区约 520×462',
    Math.abs(size[0] - 520) <= 4 && Math.abs(size[1] - 462) <= 4,
    `实际 ${size.join('×')}`
  );

  const zonesOk = await evalIn(win, `!!document.getElementById('drop-src') && !!document.getElementById('drop-tgt')`);
  ok('两个拖放区都在', zonesOk === true);

  const dropHint = await evalIn(win, `document.querySelector('#drop-src .drop-name').textContent`);
  eq('空状态下有提示文案', dropHint, '拖入文件夹，或点击选择');

  const hasScroll = await evalIn(win, `document.body.scrollHeight > window.innerHeight + 1 || document.body.scrollWidth > window.innerWidth + 1`);
  ok('窗口内没有滚动条（版式放得下）', hasScroll === false);

  // ------------------------------------------------- 拖入单个文件应被拒绝
  const filePath = path.join(SRC, 'a.txt');
  await evalIn(win, `setFolder('src', ${q(filePath)})`);
  const afterFile = await evalIn(win, `({ set: document.getElementById('drop-src').classList.contains('is-set'), note: document.getElementById('note').textContent, hidden: document.getElementById('note').classList.contains('is-hidden') })`);
  eq('拖入文件不被接受', afterFile.set, false);
  ok('并且给出提示', afterFile.hidden === false && afterFile.note.includes('文件夹'), JSON.stringify(afterFile));

  // ------------------------------------------------- 真拖一个文件夹进来
  await dropFolder(win, 'drop-src', SRC);
  const srcSet = await evalIn(win, `document.getElementById('drop-src').classList.contains('is-set')`);
  eq('把文件夹拖到源区能识别下来', srcSet, true);

  await dropFolder(win, 'drop-tgt', TGT);
  const tgtSet0 = await evalIn(win, `document.getElementById('drop-tgt').classList.contains('is-set')`);
  eq('目标区同样接得住拖入的文件夹', tgtSet0, true);

  const noteGone = await evalIn(win, `document.getElementById('note').classList.contains('is-hidden')`);
  eq('选好之后错误提示被清掉', noteGone, true);

  const srcName = await evalIn(win, `document.querySelector('#drop-src .drop-name').textContent`);
  eq('源文件夹显示文件夹名', srcName, 'src');

  const srcPathText = await evalIn(win, `document.querySelector('#drop-src .drop-path').textContent`);
  ok('源文件夹显示文件数', /5 个文件/.test(srcPathText), `实际「${srcPathText}」`);

  const tgtSet = await evalIn(win, `document.getElementById('drop-tgt').classList.contains('is-set')`);
  eq('目标区进入已选状态', tgtSet, true);

  // --------------------------------------------------------------- 开始收集
  await evalIn(win, `document.getElementById('start').click(); 1`);

  const head = await waitFor(async () => {
    const v = await evalIn(win, `document.getElementById('result').classList.contains('is-hidden') ? '' : document.getElementById('result-head').textContent`);
    return v || false;
  }, 20000, '收集完成');

  ok('结果摘要出现', !!head, head);
  ok('摘要里是「已收集 5 个文件」', /已收集\s*5\s*个文件/.test(head), `实际「${head}」`);
  ok('摘要里说明有 1 个重命名', /1\s*个重命名/.test(head), `实际「${head}」`);

  const runHidden = await evalIn(win, `document.getElementById('run').classList.contains('is-hidden')`);
  eq('进度条已收起', runHidden, true);

  const flat = await evalIn(win, `document.getElementById('result').classList.contains('is-flat')`);
  eq('全部成功时结果卡片只占一行', flat, true);

  const tipsBack = await evalIn(win, `!document.getElementById('tips').classList.contains('is-hidden')`);
  eq('没有问题时规则说明留在原位，不留空白', tipsBack, true);

  const noScrollAfter = await evalIn(win, `document.body.scrollHeight > window.innerHeight + 1`);
  eq('结果出来后窗口内仍不出现滚动条', noScrollAfter, false);

  // --------------------------------------------------------- 磁盘结果核对
  const got = listTree(TGT);
  const want = [
    '1_a.txt', // 预置的旧文件
    '1_a_1.txt', // a.txt 撞名后改名
    '1_b.txt',
    '1_c.txt',
    '2_报告.pdf',
    '3_报告.pdf',
  ];
  eq('目标目录内容符合序号规则', got, want);

  const oldContent = fs.readFileSync(path.join(TGT, '1_a.txt'), 'utf8');
  eq('预置的同名文件一个字节都没动', oldContent, 'OLD-DO-NOT-TOUCH');
  eq('a.txt 落到 1_a_1.txt', fs.readFileSync(path.join(TGT, '1_a_1.txt'), 'utf8'), 'A-TOP');
  eq('顶层「报告.pdf」是 3_ 号', fs.readFileSync(path.join(TGT, '3_报告.pdf'), 'utf8'), 'REPORT-TOP');
  eq('子目录同名文件是 2_ 号', fs.readFileSync(path.join(TGT, '2_报告.pdf'), 'utf8'), 'REPORT-SUB');

  eq('默认是复制，源文件夹原封不动', listTree(SRC), srcBefore);
  const leftovers = listTree(TGT).filter((n) => n.includes('wbcollect.tmp'));
  eq('没有残留临时文件', leftovers, []);

  // -------------------------------------------------------------- 截图
  try {
    const shot = await win.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (shot.result && shot.result.data) {
      fs.mkdirSync(path.dirname(SHOT), { recursive: true });
      fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
      ok('截图已保存', true);
    }
  } catch (e) {
    console.log('   · 截图失败（不影响功能判定）', e.message);
  }

  // ------------------------------------------------- 配置持久化 & 无异常
  await new Promise((r) => setTimeout(r, 700));
  const cfgPath = path.join(process.env.APPDATA, 'FileCards', 'config.json');
  let cfgOk = false;
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfgOk = !!cfg.collect && path.resolve(cfg.collect.targetDir || '') === path.resolve(TGT) && cfg.collect.prefix === true;
  } catch {
    cfgOk = false;
  }
  ok('目标文件夹与开关已写进配置', cfgOk, cfg ? JSON.stringify(cfg.collect) : '读不到配置');

  const errs = [...main.logs, ...win.logs].filter((l) => !/Electron Security Warning/.test(l));
  eq('两个窗口都没有 JS 报错', errs, []);

  const nav = await evalIn(win, `location.href.endsWith('collect.html')`);
  eq('拖放没有把窗口导航走', nav, true);

  // -------------------------------------------------------------- 收尾
  await evalIn(win, `window.collect.close(); 1`).catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  const after = (await targets()).filter((t) => t.type === 'page' && t.url.endsWith('collect.html'));
  eq('关闭后弹窗被销毁', after.length, 0);

  main.ws.close();
  win.ws.close();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  if (fail) {
    for (const f of failures) console.error('  -', f);
    process.exitCode = 1;
  }
})().catch((e) => {
  console.error('\n测试中断：', e.stack || e.message);
  process.exitCode = 1;
});
