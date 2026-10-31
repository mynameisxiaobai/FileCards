'use strict';

/**
 * mover.js 用例矩阵
 * 直接 `node test/mover.test.js` 跑，不需要起 Electron。
 *
 * 核心断言只有一句：跑完之后，目标目录里原有的任何东西都不许变；
 * 源要么还在原处，要么在目标目录里完整出现两份中的一份。
 */

const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const mover = require('../src/mover.js');

const ROOT = path.join(__dirname, '..', '.tmp-test');
const ALT_PARENT = 'D:\\';

let pass = 0;
const failures = [];

// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (p) =>
  new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('error', rej);
    s.on('data', (d) => h.update(d));
    s.on('end', () => res(h.digest('hex')));
  });

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`);
    console.log(`        ${e.message.split('\n').join('\n        ')}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

let seq = 0;
async function sandbox(prefix, parent = ROOT) {
  const base = path.join(parent, `${prefix}-${process.pid}-${(seq++).toString(36)}`);
  const src = path.join(base, 'src');
  const dst = path.join(base, 'dst');
  await fsp.rm(base, { recursive: true, force: true });
  await fsp.mkdir(src, { recursive: true });
  await fsp.mkdir(dst, { recursive: true });
  return { base, src, dst };
}

async function write(p, content) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, content, 'utf8');
  return p;
}

/** 递归快照：{ 相对路径: "size:sha256" | 'DIR' } */
async function snapshot(dir) {
  const out = new Map();
  async function walk(d, rel) {
    const ents = await fsp.readdir(d, { withFileTypes: true });
    for (const e of ents) {
      const r = rel ? path.join(rel, e.name) : e.name;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        out.set(r, 'DIR');
        await walk(abs, r);
      } else {
        const st = await fsp.stat(abs);
        out.set(r, `${st.size}:${await sha(abs)}`);
      }
    }
  }
  await walk(dir, '');
  return out;
}

/** 只允许新增：原有的每一项内容与大小都不许变 */
async function assertOnlyAdded(before, after, label) {
  for (const [k, v] of before) {
    assert.ok(after.has(k), `${label}: 原有项消失了 ${k}`);
    assert.strictEqual(after.get(k), v, `${label}: 原有项被改动了 ${k}`);
  }
}

async function assertNotExist(p, label) {
  let found = false;
  try {
    await fsp.lstat(p);
    found = true;
  } catch {}
  assert.strictEqual(found, false, `${label}: ${p} 不应存在`);
}

async function assertContent(p, expected, label) {
  const actual = await fsp.readFile(p, 'utf8');
  assert.strictEqual(actual, expected, `${label}: ${p} 内容不符`);
}

// ---------------------------------------------------------------------------
// A. 同卷
// ---------------------------------------------------------------------------

async function suiteSameVolume() {
  section('A. 同卷移动（快路径）');

  await test('A1 普通文件搬到空目录', async () => {
    const { src, dst } = await sandbox('a1');
    await write(path.join(src, 'note.txt'), 'hello');
    const r = await mover.moveOne(path.join(src, 'note.txt'), dst);
    assert.strictEqual(r.status, 'moved', `状态 ${r.status} / ${r.message}`);
    assert.strictEqual(r.finalName, 'note.txt');
    await assertContent(path.join(dst, 'note.txt'), 'hello', 'A1');
    await assertNotExist(path.join(src, 'note.txt'), 'A1');
  });

  await test('A2 同名文件 → 自动改名，原文件分毫不动', async () => {
    const { src, dst } = await sandbox('a2');
    await write(path.join(dst, 'a.txt'), 'B-original');
    await write(path.join(src, 'a.txt'), 'A-new');
    const before = await snapshot(dst);

    const r = await mover.moveOne(path.join(src, 'a.txt'), dst);
    assert.strictEqual(r.status, 'renamed', `状态 ${r.status} / ${r.message}`);
    assert.strictEqual(r.finalName, 'a (1).txt');
    assert.strictEqual(r.renamed, true);

    await assertContent(path.join(dst, 'a.txt'), 'B-original', 'A2 原有文件');
    await assertContent(path.join(dst, 'a (1).txt'), 'A-new', 'A2 新文件');
    await assertOnlyAdded(before, await snapshot(dst), 'A2');
  });

  await test('A3 大小写变体不产生仅差大小写的第二个名字', async () => {
    const { src, dst } = await sandbox('a3');
    await write(path.join(dst, 'Report.PDF'), 'UPPER');
    await write(path.join(src, 'report.pdf'), 'lower');

    const r = await mover.moveOne(path.join(src, 'report.pdf'), dst);
    assert.strictEqual(r.status, 'renamed', `状态 ${r.status}`);
    assert.strictEqual(r.finalName, 'report (1).pdf');
    await assertContent(path.join(dst, 'Report.PDF'), 'UPPER', 'A3');
  });

  await test('A4 复合扩展名切在正确位置', async () => {
    const { src, dst } = await sandbox('a4');
    await write(path.join(dst, 'backup.tar.gz'), 'old');
    await write(path.join(src, 'backup.tar.gz'), 'new');
    const r = await mover.moveOne(path.join(src, 'backup.tar.gz'), dst);
    assert.strictEqual(r.finalName, 'backup (1).tar.gz');
  });

  await test('A5 点开头无第二点的名字整体当 stem', async () => {
    const { src, dst } = await sandbox('a5');
    await write(path.join(dst, '.gitignore'), 'old');
    await write(path.join(src, '.gitignore'), 'new');
    const r = await mover.moveOne(path.join(src, '.gitignore'), dst);
    assert.strictEqual(r.finalName, '.gitignore (1)');
  });

  await test('A6 连续三次同名 → (1) (2) (3) 各自独立', async () => {
    const { src, dst } = await sandbox('a6');
    const names = [];
    for (let i = 0; i < 4; i++) {
      const p = await write(path.join(src, `shot-${i}.png`), `v${i}`);
      const r = await mover.moveOne(p, dst);
      assert.strictEqual(r.status === 'moved' || r.status === 'renamed', true, r.message);
      names.push(r.finalName);
    }
    assert.deepStrictEqual(names, ['shot-0.png', 'shot-1.png', 'shot-2.png', 'shot-3.png']);

    // 同名再来三次
    const again = [];
    for (let i = 0; i < 3; i++) {
      const p = await write(path.join(src, 'dup.txt'), `x${i}`);
      again.push((await mover.moveOne(p, dst)).finalName);
    }
    assert.deepStrictEqual(again, ['dup.txt', 'dup (1).txt', 'dup (2).txt']);
  });

  await test('A7 文件夹整体移动，内部结构完整', async () => {
    const { src, dst } = await sandbox('a7');
    await write(path.join(src, 'proj', 'a', 'x.txt'), 'xx');
    await write(path.join(src, 'proj', 'b.txt'), 'bb');
    await fsp.mkdir(path.join(src, 'proj', 'empty'), { recursive: true });

    const r = await mover.moveOne(path.join(src, 'proj'), dst);
    assert.strictEqual(r.status, 'moved', r.message);
    await assertContent(path.join(dst, 'proj', 'a', 'x.txt'), 'xx', 'A7');
    await assertContent(path.join(dst, 'proj', 'b.txt'), 'bb', 'A7');
    const st = await fsp.stat(path.join(dst, 'proj', 'empty'));
    assert.ok(st.isDirectory());
    await assertNotExist(path.join(src, 'proj'), 'A7');
  });

  await test('A8 同名文件夹 → 生成 proj (1)，旧目录内容逐字节不变', async () => {
    const { src, dst } = await sandbox('a8');
    await write(path.join(dst, 'proj', 'keep.txt'), 'OLD');
    await write(path.join(src, 'proj', 'new.txt'), 'NEW');
    const before = await snapshot(dst);

    const r = await mover.moveOne(path.join(src, 'proj'), dst);
    assert.strictEqual(r.status, 'renamed', r.message);
    assert.strictEqual(r.finalName, 'proj (1)');
    await assertContent(path.join(dst, 'proj', 'keep.txt'), 'OLD', 'A8 旧目录');
    await assertContent(path.join(dst, 'proj (1)', 'new.txt'), 'NEW', 'A8 新目录');
    await assertOnlyAdded(before, await snapshot(dst), 'A8');
  });

  await test('A9 空文件也能搬', async () => {
    const { src, dst } = await sandbox('a9');
    await write(path.join(src, 'zero.bin'), '');
    const r = await mover.moveOne(path.join(src, 'zero.bin'), dst);
    assert.strictEqual(r.status, 'moved', r.message);
    const st = await fsp.stat(path.join(dst, 'zero.bin'));
    assert.strictEqual(st.size, 0);
  });
}

// ---------------------------------------------------------------------------
// B. 拒绝与跳过
// ---------------------------------------------------------------------------

async function suiteGuards() {
  section('B. 预检 / 拒绝 / 跳过');

  await test('B1 文件已在目标目录 → 跳过，不报错', async () => {
    const { dst } = await sandbox('b1');
    const p = await write(path.join(dst, 'stay.txt'), 'x');
    const r = await mover.moveOne(p, dst);
    assert.strictEqual(r.status, 'skipped');
    assert.strictEqual(r.code, 'ALREADY_THERE');
    await assertContent(p, 'x', 'B1');
  });

  await test('B2 把父文件夹拖进自己的子目录 → 拒绝', async () => {
    const { src } = await sandbox('b2');
    await write(path.join(src, 'proj', 'inner', 'a.txt'), 'x');
    const r = await mover.moveOne(
      path.join(src, 'proj'),
      path.join(src, 'proj', 'inner')
    );
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.code, 'SRC_IS_ANCESTOR');
    await assertContent(path.join(src, 'proj', 'inner', 'a.txt'), 'x', 'B2');
  });

  await test('B3 目标目录不存在 → 失败，不自动创建', async () => {
    const { src, base } = await sandbox('b3');
    const p = await write(path.join(src, 'a.txt'), 'x');
    const ghost = path.join(base, 'nope');
    const r = await mover.moveOne(p, ghost);
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.code, 'TARGET_MISSING');
    assert.strictEqual(await fsp.exists ? true : true, true);
    await assertNotExist(ghost, 'B3');
    await assertContent(p, 'x', 'B3 源应保留');
  });

  await test('B4 源不存在 → 跳过', async () => {
    const { base, dst } = await sandbox('b4');
    const r = await mover.moveOne(path.join(base, 'ghost.txt'), dst);
    assert.strictEqual(r.status, 'skipped');
    assert.strictEqual(r.code, 'NOT_EXIST');
  });

  await test('B5 把磁盘根目录拖进去 → 拒绝', async () => {
    const { dst } = await sandbox('b5');
    const r = await mover.moveOne('C:\\', dst);
    assert.strictEqual(r.status, 'failed');
    assert.ok(['DANGEROUS_SRC', 'SRC_IS_ANCESTOR'].includes(r.code), `实际 ${r.code}`);
  });

  await test('B6 把文件移到它自己 → 拒绝', async () => {
    const { src } = await sandbox('b6');
    const p = await write(path.join(src, 'self.txt'), 'x');
    const r = await mover.moveOne(p, p);
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.code, 'SRC_IS_TARGET');
  });

  await test('B7 子目录里的文件搬到父目录卡片 → 正常上移', async () => {
    const { src, dst } = await sandbox('b7');
    const inner = path.join(dst, 'sub');
    await write(path.join(inner, 'up.txt'), 'move me');
    const r = await mover.moveOne(path.join(inner, 'up.txt'), dst);
    assert.strictEqual(r.status, 'moved', r.message);
    await assertContent(path.join(dst, 'up.txt'), 'move me', 'B7');
  });
}

// ---------------------------------------------------------------------------
// C. 跨卷
// ---------------------------------------------------------------------------

async function suiteCrossVolume() {
  section('C. 跨卷移动（复制 → 校验 → 占名 → 改名 → 删源）');

  const altOk = await (async () => {
    try {
      const a = await fsp.stat('C:\\');
      const b = await fsp.stat(ALT_PARENT);
      return a.dev !== b.dev;
    } catch {
      return false;
    }
  })();

  if (!altOk) {
    console.log('  \x1b[33mSKIP\x1b[0m  没有找到与 C: 不同的卷，跨卷用例跳过');
    return;
  }

  await test('C1 跨卷单文件', async () => {
    const { src } = await sandbox('c1');
    const alt = await sandbox('c1', ALT_PARENT);
    try {
      const content = 'cross-volume-payload-' + crypto.randomBytes(8).toString('hex');
      await write(path.join(src, 'big.txt'), content);
      const r = await mover.moveOne(path.join(src, 'big.txt'), alt.dst);
      assert.strictEqual(r.status, 'moved', `${r.status} / ${r.message}`);
      await assertContent(path.join(alt.dst, 'big.txt'), content, 'C1');
      await assertNotExist(path.join(src, 'big.txt'), 'C1 源应已删除');
    } finally {
      await fsp.rm(alt.base, { recursive: true, force: true });
    }
  });

  await test('C2 跨卷目录树，结构完整', async () => {
    const { src } = await sandbox('c2');
    const alt = await sandbox('c2', ALT_PARENT);
    try {
      await write(path.join(src, 'proj', 'a.txt'), 'A');
      await write(path.join(src, 'proj', 'deep', 'b.txt'), 'B');
      await write(path.join(src, 'proj', 'deep', 'deeper', 'c.txt'), 'C');
      const r = await mover.moveOne(path.join(src, 'proj'), alt.dst);
      assert.strictEqual(r.status, 'moved', `${r.status} / ${r.message}`);
      await assertContent(path.join(alt.dst, 'proj', 'a.txt'), 'A', 'C2');
      await assertContent(path.join(alt.dst, 'proj', 'deep', 'deeper', 'c.txt'), 'C', 'C2');
      await assertNotExist(path.join(src, 'proj'), 'C2 源应已删除');
    } finally {
      await fsp.rm(alt.base, { recursive: true, force: true });
    }
  });

  await test('C3 跨卷同名 → 改名，目标原有文件不动', async () => {
    const { src } = await sandbox('c3');
    const alt = await sandbox('c3', ALT_PARENT);
    try {
      await write(path.join(alt.dst, 'same.txt'), 'OLD-ON-D');
      await write(path.join(src, 'same.txt'), 'NEW-FROM-C');
      const before = await snapshot(alt.dst);

      const r = await mover.moveOne(path.join(src, 'same.txt'), alt.dst);
      assert.strictEqual(r.status, 'renamed', r.message);
      assert.strictEqual(r.finalName, 'same (1).txt');
      await assertContent(path.join(alt.dst, 'same.txt'), 'OLD-ON-D', 'C3');
      await assertContent(path.join(alt.dst, 'same (1).txt'), 'NEW-FROM-C', 'C3');
      await assertOnlyAdded(before, await snapshot(alt.dst), 'C3');
    } finally {
      await fsp.rm(alt.base, { recursive: true, force: true });
    }
  });

  await test('C4 搬完不留 .wbmove 临时件', async () => {
    const { src } = await sandbox('c4');
    const alt = await sandbox('c4', ALT_PARENT);
    try {
      await write(path.join(src, 'x.bin'), crypto.randomBytes(4096));
      await mover.moveOne(path.join(src, 'x.bin'), alt.dst);
      const left = (await fsp.readdir(alt.dst)).filter((n) => n.includes('.wbmove-'));
      assert.deepStrictEqual(left, [], `残留临时件: ${left.join(', ')}`);
    } finally {
      await fsp.rm(alt.base, { recursive: true, force: true });
    }
  });

  await test('C5 跨卷大文件（> 8MB 走大小校验）', async () => {
    const { src } = await sandbox('c5');
    const alt = await sandbox('c5', ALT_PARENT);
    try {
      const buf = crypto.randomBytes(9 * 1024 * 1024);
      await fsp.writeFile(path.join(src, 'big.iso'), buf);
      const r = await mover.moveOne(path.join(src, 'big.iso'), alt.dst);
      assert.strictEqual(r.status, 'moved', r.message);
      const st = await fsp.stat(path.join(alt.dst, 'big.iso'));
      assert.strictEqual(st.size, buf.length);
      await assertNotExist(path.join(src, 'big.iso'), 'C5');
    } finally {
      await fsp.rm(alt.base, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// D. 批量
// ---------------------------------------------------------------------------

async function suiteBatch() {
  section('D. 批量：失败隔离');

  await test('D1 一个失败不影响其他项，汇总如实', async () => {
    const { src, dst, base } = await sandbox('d1');
    await write(path.join(src, 'ok1.txt'), '1');
    await write(path.join(src, 'ok2.txt'), '2');
    await write(path.join(src, 'proj', 'inner', 'x.txt'), 'x');

    const list = [
      path.join(src, 'ok1.txt'),
      path.join(src, 'proj'),               // 这条会失败（目标是它自己的子目录）
      path.join(src, 'ok2.txt'),
      path.join(base, 'ghost.txt'),         // 不存在 → skipped
    ];
    const { results, summary } = await mover.moveMany(list, path.join(src, 'proj', 'inner'));

    assert.strictEqual(summary.total, 4);
    assert.strictEqual(summary.failed, 1, JSON.stringify(summary));
    assert.strictEqual(summary.skipped, 1, JSON.stringify(summary));
    assert.strictEqual(summary.ok, 2, JSON.stringify(summary));

    // 成功的两项确实到位了
    await assertContent(path.join(src, 'proj', 'inner', 'ok1.txt'), '1', 'D1');
    await assertContent(path.join(src, 'proj', 'inner', 'ok2.txt'), '2', 'D1');
    // 失败的源仍在
    await assertContent(path.join(src, 'proj', 'inner', 'x.txt'), 'x', 'D1 失败项源应保留');
  });

  await test('D2 同一文件重复拖入 → 去重', async () => {
    const { src, dst } = await sandbox('d2');
    const p = await write(path.join(src, 'once.txt'), 'z');
    const { results, summary } = await mover.moveMany([p, p, p], dst);
    assert.strictEqual(summary.moved, 1, JSON.stringify(summary));
    assert.strictEqual(summary.skipped, 2, JSON.stringify(summary));
    assert.strictEqual(results[1].code, 'DUPLICATE_IN_BATCH');
  });

  await test('D3 中文 / 空格 / 括号 文件名', async () => {
    const { src, dst } = await sandbox('d3');
    const name = '季度报告 (终稿) v2.xlsx';
    await write(path.join(src, name), 'cn');
    const r = await mover.moveOne(path.join(src, name), dst);
    assert.strictEqual(r.status, 'moved', r.message);
    await assertContent(path.join(dst, name), 'cn', 'D3');
  });

  await test('D4 进度回调次数正确', async () => {
    const { src, dst } = await sandbox('d4');
    const list = [];
    for (let i = 0; i < 5; i++) list.push(await write(path.join(src, `f${i}.txt`), String(i)));
    const seen = [];
    await mover.moveMany(list, dst, 'card-x', (done, total, last) => {
      seen.push([done, total, last && last.cardId]);
    });
    assert.deepStrictEqual(seen.map((s) => s[0]), [1, 2, 3, 4, 5]);
    assert.strictEqual(seen[0][1], 5);
    assert.strictEqual(seen[0][2], 'card-x');
  });
}

// ---------------------------------------------------------------------------
// E. 纯函数
// ---------------------------------------------------------------------------

async function suitePure() {
  section('E. 纯函数');

  await test('E1 splitName 切分口径', async () => {
    const cases = [
      ['a.txt', 'a', '.txt'],
      ['backup.tar.gz', 'backup', '.tar.gz'],
      ['.gitignore', '.gitignore', ''],
      ['noext', 'noext', ''],
      ['a.b.c', 'a.b', '.c'],
    ];
    for (const [input, stem, ext] of cases) {
      const r = mover.splitName(input);
      assert.strictEqual(r.stem, stem, `${input} stem`);
      assert.strictEqual(r.ext, ext, `${input} ext`);
    }
  });

  await test('E2 候选名序列', async () => {
    const it = mover.candidateNames('a.txt');
    const got = [];
    for (let i = 0; i < 3; i++) got.push(it.next().value);
    assert.deepStrictEqual(got, ['a.txt', 'a (1).txt', 'a (2).txt']);
  });

  await test('E3 非法名清洗与保留名', async () => {
    assert.strictEqual(mover.isValidName('a<b.txt'), false);
    assert.strictEqual(mover.isValidName('a.txt '), false);
    assert.strictEqual(mover.isValidName('CON.txt'), false);
    assert.strictEqual(mover.isValidName('ok.txt'), true);
    assert.strictEqual(mover.sanitizeName('CON.txt'), '_CON.txt');
  });

  await test('E4 isDescendant 不误判前缀相同的兄弟目录', async () => {
    assert.strictEqual(mover.isDescendant('C:\\ab', 'C:\\ab\\x'), true);
    assert.strictEqual(mover.isDescendant('C:\\ab', 'C:\\abc'), false);
    assert.strictEqual(mover.isDescendant('C:\\ab', 'C:\\ab'), false);
    assert.strictEqual(mover.isDescendant('C:\\ab', 'D:\\ab\\x'), false);
  });
}

// ---------------------------------------------------------------------------

(async () => {
  console.log('\x1b[1m移动引擎用例矩阵\x1b[0m');
  console.log(`工作目录 ${ROOT}`);

  await fsp.rm(ROOT, { recursive: true, force: true });
  await fsp.mkdir(ROOT, { recursive: true });

  const t0 = Date.now();
  await suiteSameVolume();
  await suiteGuards();
  await suiteCrossVolume();
  await suiteBatch();
  await suitePure();

  await fsp.rm(ROOT, { recursive: true, force: true });

  const ms = Date.now() - t0;
  console.log(`\n${'─'.repeat(56)}`);
  if (failures.length === 0) {
    console.log(`\x1b[32m全部通过\x1b[0m  ${pass} 项，耗时 ${ms}ms`);
  } else {
    console.log(`\x1b[31m${failures.length} 项失败\x1b[0m / 通过 ${pass} 项，耗时 ${ms}ms`);
    for (const f of failures) console.log(`  · ${f.name}`);
    process.exitCode = 1;
  }
})();
