'use strict';

/**
 * 端到端验证：拖边框缩放窗口 + 卡片铺满、留白恒定。
 *
 * 用合成 MouseEvent 直接打到 .rz 热区上，screenX/screenY 可控，
 * 走的是真实路径：mousedown -> getBounds -> mousemove* -> setBounds -> resize 观察者重排。
 *
 * 断言的核心不是「卡片多大多方」，而是：
 *   卡片与窗口四边的留白恒等于 --grid-pad(14)，卡片间距恒等于 --gap(10)，
 *   且卡片始终铺满整块网格（不留豁口、不出滚动条）。
 *
 * 注意：窗口必须留在屏幕内。拖到屏幕外会让 renderer 变成 hidden，
 * 视口度量会停止更新，测出来的数字全是陈的（踩过一次）。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAD = 14;
const GAP = 10;
const TITLEBAR = 34;

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: 9222, path: pathname, family: 4 }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(d));
      })
      .on('error', reject);
  });
}

(async () => {
  const list = JSON.parse(await getJson('/json/list'));
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pend.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  await send('Runtime.enable');

  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      throw new Error(d.exception ? d.exception.description : d.text);
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  const results = [];
  const check = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
  };

  const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

  /** 完整拖一次：dir 热区方向，dx/dy 为屏幕位移 */
  async function dragRim(dir, dx, dy) {
    await evaluate(`(async () => {
      const el = document.querySelector('[data-rz="${dir}"]');
      const r = el.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      const o = { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: cx, clientY: cy };
      el.dispatchEvent(new MouseEvent('mousedown', { ...o, screenX: 1000, screenY: 1000 }));
      await new Promise(r => setTimeout(r, 90));
      for (let i = 1; i <= 5; i++) {
        window.dispatchEvent(new MouseEvent('mousemove', {
          ...o, buttons: 1,
          screenX: 1000 + Math.round(${dx} * i / 5),
          screenY: 1000 + Math.round(${dy} * i / 5),
        }));
        await new Promise(r => setTimeout(r, 80));
      }
      window.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 }));
      await new Promise(r => setTimeout(r, 160));
      return true;
    })()`);
  }

  /** 量出卡片矩形、窗口尺寸、以及四周实际留白 */
  const snap = async () =>
    JSON.parse(
      await evaluate(`(async () => {
        const b = await window.bridge.getBounds();
        const cards = [...document.querySelectorAll('.card')].map(c => {
          const r = c.getBoundingClientRect();
          return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
        });
        const g = document.getElementById('grid');
        const cs = getComputedStyle(g);
        // 实际留白：用未取整的矩形算，避免每张卡各自 round 引入的 1px 误差
        const rects = [...document.querySelectorAll('.card')].map(c => c.getBoundingClientRect());
        const left = rects.length ? Math.min(...rects.map(r => r.left)) : null;
        const top = rects.length ? Math.min(...rects.map(r => r.top)) - ${TITLEBAR} : null;
        const right = rects.length ? window.innerWidth - Math.max(...rects.map(r => r.right)) : null;
        const bottom = rects.length ? window.innerHeight - Math.max(...rects.map(r => r.bottom)) : null;
        return JSON.stringify({
          b, cards, padL: left, padT: top, padR: right, padB: bottom,
          gapSize: cs.gap,
          gridPad: cs.padding,
          compact: g.classList.contains('is-compact'),
          tiny: g.classList.contains('is-tiny'),
          scroll: [document.documentElement.scrollWidth > window.innerWidth, document.documentElement.scrollHeight > window.innerHeight],
          hidden: document.hidden,
        });
      })()`)
    );

  /** 卡片是否铺满网格：最左/最右/最上/最下的卡都贴到留白线 */
  function fillsArea(s) {
    return (
      near(s.padL, PAD, 1) &&
      near(s.padT, PAD, 1) &&
      near(s.padR, PAD, 1) &&
      near(s.padB, PAD, 1)
    );
  }

  // 起点固定，确保窗口整块在屏幕内
  await evaluate(`window.bridge.setBounds({ x: 120, y: 120, width: 360, height: 330 })`);
  await sleep(700);

  const b0 = await snap();
  console.log('起点：', JSON.stringify(b0.b), 'cards=', JSON.stringify(b0.cards), 'hidden=', b0.hidden);
  check('起始窗口在屏内可见', b0.hidden === false, '');
  check(
    '卡片铺满窗口，四周留白恒为 14px',
    fillsArea(b0),
    `左${b0.padL} 上${b0.padT} 右${b0.padR} 下${b0.padB}`
  );
  check('卡片间距恒为 10px', b0.gapSize === `${GAP}px`, `gap=${b0.gapSize}`);

  // 1. 右下角放大
  await dragRim('se', 200, 150);
  const b1 = await snap();
  check(
    '右下角拖 200x150：尺寸同步变大',
    near(b1.b.width, b0.b.width + 200) && near(b1.b.height, b0.b.height + 150),
    `${b0.b.width}x${b0.b.height} -> ${b1.b.width}x${b1.b.height}`
  );
  check('位置不该动', b1.b.x === b0.b.x && b1.b.y === b0.b.y, `${b1.b.x},${b1.b.y}`);
  check('卡片跟着变大', b1.cards[0][2] > b0.cards[0][2], `${b0.cards[0][2]} -> ${b1.cards[0][2]} 宽`);
  check(
    '放大后留白仍是 14px（卡片吃满，不是居中缩着）',
    fillsArea(b1),
    `左${b1.padL} 上${b1.padT} 右${b1.padR} 下${b1.padB}`
  );
  check('放大后无滚动条', !b1.scroll[0] && !b1.scroll[1], JSON.stringify(b1.scroll));

  // 2. 左边缘往右收：x 增加、宽度减少
  await dragRim('w', 120, 0);
  const b2 = await snap();
  check(
    '左边缘拖 120：宽度减少、左边框右移',
    near(b2.b.width, b1.b.width - 120) && near(b2.b.x, b1.b.x + 120),
    `x ${b1.b.x}->${b2.b.x}  w ${b1.b.width}->${b2.b.width}`
  );
  check('变小后卡片跟着变小', b2.cards[0][2] < b1.cards[0][2], `${b1.cards[0][2]} -> ${b2.cards[0][2]} 宽`);
  check('变小后留白仍是 14px', fillsArea(b2), `左${b2.padL} 右${b2.padR}`);

  // 3. 上边缘往上拉：y 减少、高度增加
  await dragRim('n', 0, -100);
  const b3 = await snap();
  check(
    '上边缘拖 -100：高度增加、顶边上移',
    near(b3.b.height, b2.b.height + 100) && near(b3.b.y, b2.b.y - 100),
    `y ${b2.b.y}->${b3.b.y}  h ${b2.b.height}->${b3.b.height}`
  );
  check('拉高后卡片变高、仍贴住上下留白', b3.cards[0][3] > b2.cards[0][3] && fillsArea(b3), `高 ${b2.cards[0][3]} -> ${b3.cards[0][3]}`);

  // 4. 一直往小拖：必须停在最小尺寸而不是塌掉
  await dragRim('se', -600, -600);
  const b4 = await snap();
  // Windows 的 thickFrame 会让实际尺寸比请求值多 1px，容忍 1px
  check('收缩停在最小尺寸 240x200', near(b4.b.width, 240, 1) && near(b4.b.height, 200, 1), `${b4.b.width}x${b4.b.height}`);
  check('最小尺寸下每张卡仍有 >96px 宽', b4.cards.every((c) => c[2] > 96), JSON.stringify(b4.cards.map((c) => c[2])));
  check('最小尺寸下留白不塌陷', fillsArea(b4), `左${b4.padL} 右${b4.padR} 下${b4.padB}`);
  check('最小尺寸下无滚动条', !b4.scroll[0] && !b4.scroll[1], JSON.stringify(b4.scroll));

  // 5. 顶边不许出屏：往上猛拽，y 必须停在 0
  await dragRim('n', 0, -400);
  const bt = await snap();
  check('顶边被挡在工作区顶部（标题栏抓得到）', bt.b.y === 0, `y=${bt.b.y}`);

  // 5b. 回到屏内再测左上角放大：x/y 同时外移
  await evaluate(`window.bridge.setBounds({ x: 300, y: 260, width: 320, height: 260 })`);
  await sleep(500);
  const b4b = await snap();
  await dragRim('nw', -70, -40);
  const b5 = await snap();
  check(
    '左上角拖 -70/-40：尺寸增、位置外移',
    near(b5.b.width, b4b.b.width + 70) &&
      near(b5.b.height, b4b.b.height + 40) &&
      near(b5.b.x, b4b.b.x - 70) &&
      near(b5.b.y, b4b.b.y - 40),
    `${b4b.b.x},${b4b.b.y} ${b4b.b.width}x${b4b.b.height} -> ${b5.b.x},${b5.b.y} ${b5.b.width}x${b5.b.height}`
  );

  // 6. 尺寸落盘
  await sleep(800);
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'FileCards', 'config.json'), 'utf8')).bounds;
  } catch {}
  check(
    '窗口尺寸写入配置',
    !!saved && saved.width === b5.b.width && saved.height === b5.b.height,
    JSON.stringify(saved)
  );

  // 7. 热区不能吃掉卡片的点击/拖放
  const hit = await evaluate(`(() => {
    const card = document.querySelector('.card');
    const r = card.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!el && !!el.closest('.card');
  })()`);
  check('卡片中心未被缩放热区覆盖', hit === true, '');

  // 8. 加到 3 张：一行三列，仍然铺满
  await evaluate(`(async () => {
    document.getElementById('add').click();
    await new Promise(r => setTimeout(r, 300));
    return document.querySelectorAll('.card').length;
  })()`);
  await sleep(400);
  const b6 = await snap();
  check('3 张卡片排成一行且铺满', b6.cards.length === 3 && b6.cards.every((c, i, a) => (i === 0 ? true : c[1] === a[0][1])) && fillsArea(b6), JSON.stringify(b6.cards));

  // 9. 加到 6 张：3x2，最后一行也铺满，不留豁口
  await evaluate(`(async () => {
    for (let i = 0; i < 3; i++) { document.getElementById('add').click(); await new Promise(r => setTimeout(r, 260)); }
    return document.querySelectorAll('.card').length;
  })()`);
  await sleep(600);
  const b7 = await snap();
  const rows = new Set(b7.cards.map((c) => c[1]));
  check('6 张卡片排成 2 行', b7.cards.length === 6 && rows.size === 2, JSON.stringify([...rows]));
  check('6 张卡片铺满窗口（无空列、无滚动条）', fillsArea(b7) && !b7.scroll[0] && !b7.scroll[1], `左${b7.padL} 右${b7.padR} 下${b7.padB}`);
  // 同一行内等宽、间距恒定（getBoundingClientRect 有亚像素，容差 1.5px）
  const row0 = b7.cards.filter((c) => c[1] === b7.cards[0][1]);
  const gapsOk = row0.every((c, i) => (i === 0 ? true : near(c[0] - (row0[i - 1][0] + row0[i - 1][2]), GAP, 1.5)));
  check('同一行卡片间距恒为 10px', gapsOk, JSON.stringify(row0.map((c) => c[0])));

  // 收尾：缩回 2 张
  await evaluate(`(async () => {
    while (document.querySelectorAll('.card').length > 2) {
      const cs = document.querySelectorAll('.card');
      cs[cs.length - 1].querySelector('.card-remove').click();
      await new Promise(r => setTimeout(r, 220));
    }
    return true;
  })()`);

  ws.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('E2E 出错：', e.message);
  process.exit(1);
});
