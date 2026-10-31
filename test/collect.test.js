'use strict';

/**
 * 收集引擎用例矩阵
 * 跑法：node test/collect.test.js
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const assert = require('assert');

const { collect, scanFiles, CollectError } = require('../src/collect');

let pass = 0;
let fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, e });
    console.log(`  ✗ ${name}\n      ${e && e.message}`);
  }
}

const ROOT = path.join(os.tmpdir(), `wbcollect-test-${process.pid}-${Date.now().toString(36)}`);

async function tmpDir(tag) {
  const d = path.join(ROOT, tag);
  await fsp.mkdir(d, { recursive: true });
  return d;
}

async function tree(dir) {
  const out = [];
  const walk = async (d, rel) => {
    const ents = (await fsp.readdir(d, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  await walk(dir, '');
  return out;
}

/** 递归收集所有以 .wbcollect.tmp 结尾的残留 */
async function leftovers(dir) {
  const found = [];
  const walk = async (d) => {
    const ents = await fsp.readdir(d, { withFileTypes: true });
    for (const e of ents) {
      if (e.isDirectory()) await walk(path.join(d, e.name));
      else if (e.name.includes('.wbcollect.tmp')) found.push(path.join(d, e.name));
    }
  };
  await walk(dir);
  return found;
}

async function write(p, content) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, content, 'utf8');
}

async function read(p) {
  return fsp.readFile(p, 'utf8');
}

(async function main() {
  await fsp.rm(ROOT, { recursive: true, force: true });
  await fsp.mkdir(ROOT, { recursive: true });

  console.log(`\n收集引擎 · ${ROOT}\n`);

  // -------------------------------------------------------------------------

  await test('基础：递归平铺 + 序号前缀与脚本一致', async () => {
    const src = await tmpDir('basic/src');
    const tgt = path.join(ROOT, 'basic/target');
    await write(path.join(src, 'a.txt'), 'A');
    await write(path.join(src, 'sub/b.txt'), 'B');
    await write(path.join(src, 'sub2/c.txt'), 'C');

    const r = await collect({ srcDir: src, targetDir: tgt });
    assert.deepStrictEqual(await tree(tgt), ['1_a.txt', '1_b.txt', '2_c.txt']);
    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.collected, 3);
    assert.strictEqual(r.failed, 0);
    // 复制语义：源文件必须还在
    assert.deepStrictEqual(await tree(src), ['a.txt', 'sub/b.txt', 'sub2/c.txt']);
  });

  await test('内容逐字节一致', async () => {
    const src = await tmpDir('bytes/src');
    const tgt = path.join(ROOT, 'bytes/target');
    const payload = Buffer.from('中文内容 ✓\n'.repeat(1000));
    await fsp.writeFile(path.join(src, 'x.bin'), payload);
    await collect({ srcDir: src, targetDir: tgt });
    const got = await fsp.readFile(path.join(tgt, '1_x.bin'));
    assert.ok(got.equals(payload), '字节不一致');
  });

  await test('同名冲突追加 _1 / _2，不覆盖已有文件', async () => {
    const src = await tmpDir('conflict/src');
    const tgt = await tmpDir('conflict/target');
    await write(path.join(src, 'a.txt'), 'NEW');
    await write(path.join(tgt, '1_a.txt'), 'OLD-1');
    await write(path.join(tgt, '1_a_1.txt'), 'OLD-2');

    const r = await collect({ srcDir: src, targetDir: tgt });
    assert.strictEqual(r.renamed, 1);
    assert.strictEqual(r.results[0].finalName, '1_a_2.txt');
    assert.strictEqual(await read(path.join(tgt, '1_a.txt')), 'OLD-1');
    assert.strictEqual(await read(path.join(tgt, '1_a_1.txt')), 'OLD-2');
    assert.strictEqual(await read(path.join(tgt, '1_a_2.txt')), 'NEW');
  });

  await test('关掉前缀时保留原名', async () => {
    const src = await tmpDir('noprefix/src');
    const tgt = path.join(ROOT, 'noprefix/target');
    await write(path.join(src, 'k.txt'), 'K');
    await write(path.join(src, 'sub/m.txt'), 'M');
    await collect({ srcDir: src, targetDir: tgt, prefix: false });
    // 两个文件夹里同名也不会互相覆盖
    assert.deepStrictEqual(await tree(tgt), ['k.txt', 'm.txt']);
  });

  await test('关掉前缀 + 真同名：改名保留两份', async () => {
    const src = await tmpDir('dupe/src');
    const tgt = path.join(ROOT, 'dupe/target');
    await write(path.join(src, 'd1/same.txt'), 'ONE');
    await write(path.join(src, 'd2/same.txt'), 'TWO');
    const r = await collect({ srcDir: src, targetDir: tgt, prefix: false });
    assert.deepStrictEqual(await tree(tgt), ['same.txt', 'same_1.txt']);
    assert.strictEqual(r.renamed, 1);
    const a = await read(path.join(tgt, 'same.txt'));
    const b = await read(path.join(tgt, 'same_1.txt'));
    assert.deepStrictEqual([a, b].sort(), ['ONE', 'TWO']);
  });

  await test('复合扩展名不被拆坏', async () => {
    const src = await tmpDir('ext/src');
    const tgt = path.join(ROOT, 'ext/target');
    await write(path.join(src, 'pkg.tar.gz'), 'x');
    await write(path.join(src, 'a.b.c.txt'), 'y');
    await collect({ srcDir: src, targetDir: tgt });
    assert.deepStrictEqual(await tree(tgt), ['1_a.b.c.txt', '1_pkg.tar.gz']);
  });

  await test('候选名对非法字符 / 保留名 / 超长名都安全', async () => {
    const { nameCandidates } = require('../src/collect');
    const { isValidName } = require('../src/mover');

    for (const raw of ['1_a<b>c|d.txt', '1_con.txt', '1_x'.repeat(300) + '.txt', '1_a.']) {
      const first = nameCandidates(raw).next().value;
      assert.ok(isValidName(first), `候选名不合法：${first}`);
      assert.ok(!/[<>:"|?*]/.test(first), `还残留非法字符：${first}`);
    }
    // 同名前 4 个候选必须是 a / a_1 / a_2 / a_3
    const seq = nameCandidates('1_a.txt');
    assert.deepStrictEqual([seq.next().value, seq.next().value, seq.next().value], [
      '1_a.txt',
      '1_a_1.txt',
      '1_a_2.txt',
    ]);
  });

  await test('空文件夹 → NO_FILES', async () => {
    const src = await tmpDir('empty/src');
    await fsp.mkdir(path.join(src, 'only-empty-sub'), { recursive: true });
    await assert.rejects(
      () => collect({ srcDir: src, targetDir: path.join(ROOT, 'empty/target') }),
      (e) => e.code === 'NO_FILES'
    );
  });

  await test('目标在源内部 → TARGET_INSIDE_SRC，且不会真的建目录', async () => {
    const src = await tmpDir('inside/src');
    await write(path.join(src, 'a.txt'), 'A');
    const inner = path.join(src, 'out');
    await assert.rejects(
      () => collect({ srcDir: src, targetDir: inner }),
      (e) => e.code === 'TARGET_INSIDE_SRC'
    );
    let exists = true;
    try {
      await fsp.stat(inner);
    } catch {
      exists = false;
    }
    assert.strictEqual(exists, false, '目标目录不该被创建');
  });

  await test('源与目标相同 → SAME_DIR', async () => {
    const src = await tmpDir('same/src');
    await write(path.join(src, 'a.txt'), 'A');
    await assert.rejects(() => collect({ srcDir: src, targetDir: src }), (e) => e.code === 'SAME_DIR');
  });

  await test('源不存在 → SRC_MISSING', async () => {
    await assert.rejects(
      () => collect({ srcDir: path.join(ROOT, 'nope'), targetDir: path.join(ROOT, 'nope-out') }),
      (e) => e.code === 'SRC_MISSING'
    );
  });

  await test('源是文件而不是文件夹 → SRC_NOT_DIR', async () => {
    const src = await tmpDir('notdir/src');
    const f = path.join(src, 'a.txt');
    await write(f, 'A');
    await assert.rejects(
      () => collect({ srcDir: f, targetDir: path.join(ROOT, 'notdir/target') }),
      (e) => e.code === 'SRC_NOT_DIR'
    );
  });

  await test('目标不存在时自动创建', async () => {
    const src = await tmpDir('mkdir/src');
    const tgt = path.join(ROOT, 'mkdir/deep/er/target');
    await write(path.join(src, 'a.txt'), 'A');
    const r = await collect({ srcDir: src, targetDir: tgt });
    assert.strictEqual(r.collected, 1);
    assert.strictEqual(await read(path.join(tgt, '1_a.txt')), 'A');
  });

  await test('move 模式：复制成功后删除源文件', async () => {
    const src = await tmpDir('move/src');
    const tgt = await tmpDir('move/target');
    await write(path.join(src, 'm.txt'), 'M');
    const r = await collect({ srcDir: src, targetDir: tgt, move: true });
    assert.strictEqual(r.collected, 1);
    assert.deepStrictEqual(await tree(tgt), ['1_m.txt']);
    assert.deepStrictEqual(await tree(src), []);
    assert.strictEqual(await read(path.join(tgt, '1_m.txt')), 'M');
  });

  await test('符号链接被跳过，其余照常收集', async () => {
    const src = await tmpDir('symlink/src');
    const outside = await tmpDir('symlink/outside');
    await write(path.join(outside, 'secret.txt'), 'S');
    await write(path.join(src, 'ok.txt'), 'OK');
    await fsp.symlink(outside, path.join(src, 'linkd'), 'junction').catch(() => {});

    const r = await collect({ srcDir: src, targetDir: path.join(ROOT, 'symlink/target') });
    const names = await tree(path.join(ROOT, 'symlink/target'));
    assert.ok(names.includes('1_ok.txt'));
    assert.ok(!names.some((n) => n.includes('secret')), '不应该顺着链接把外部文件收进来');
    assert.ok(r.skipped >= 0);
  });

  await test('不留任何临时文件', async () => {
    const src = await tmpDir('clean/src');
    const tgt = await tmpDir('clean/target');
    for (let i = 0; i < 12; i++) await write(path.join(src, `f${i}.txt`), String(i));
    await collect({ srcDir: src, targetDir: tgt });
    assert.deepStrictEqual(await leftovers(ROOT), []);
  });

  await test('进度回调单调递增到 total', async () => {
    const src = await tmpDir('progress/src');
    const tgt = path.join(ROOT, 'progress/target');
    for (let i = 0; i < 5; i++) await write(path.join(src, `p${i}.txt`), String(i));
    const seen = [];
    await collect({ srcDir: src, targetDir: tgt }, { onProgress: (p) => seen.push(p) });
    assert.strictEqual(seen.length, 5);
    assert.deepStrictEqual(seen.map((p) => p.done), [1, 2, 3, 4, 5]);
    assert.ok(seen.every((p) => p.total === 5));
  });

  await test('中途停止：剩余文件不处理，已处理的保留', async () => {
    const src = await tmpDir('cancel/src');
    const tgt = path.join(ROOT, 'cancel/target');
    for (let i = 0; i < 6; i++) await write(path.join(src, `c${i}.txt`), String(i));
    let n = 0;
    const r = await collect({ srcDir: src, targetDir: tgt }, { shouldStop: () => n++ >= 2 });
    assert.strictEqual(r.canceled, true);
    assert.strictEqual(r.collected, 2);
    assert.strictEqual((await tree(tgt)).length, 2);
  });

  await test('嵌套层级序号与脚本一致（深层序号不串）', async () => {
    const src = await tmpDir('nest/src');
    const tgt = path.join(ROOT, 'nest/target');
    await write(path.join(src, 'a/1.txt'), '1');
    await write(path.join(src, 'a/deep/2.txt'), '2');
    await write(path.join(src, 'b/3.txt'), '3');
    await collect({ srcDir: src, targetDir: tgt });
    // 顶层只有 a、b 两个目录：a 用序号 1（含深层），b 用序号 2
    assert.deepStrictEqual(await tree(tgt), ['1_1.txt', '1_2.txt', '2_3.txt']);
  });

  await test('scan 只读：不改动源目录', async () => {
    const src = await tmpDir('scan/src');
    await write(path.join(src, 'a/a.txt'), 'A');
    await write(path.join(src, 'b.txt'), 'B');
    const before = await tree(src);
    const r = await scanFiles(src);
    assert.strictEqual(r.files.length, 2);
    assert.deepStrictEqual(await tree(src), before);
  });

  await test('大小写不同的重名不会互相覆盖', async () => {
    const src = await tmpDir('case/src');
    const tgt = await tmpDir('case/target');
    await write(path.join(src, 'Readme.txt'), 'UPPER');
    await write(path.join(tgt, '1_readme.TXT'), 'LOWER');
    const r = await collect({ srcDir: src, targetDir: tgt });
    // Windows 大小写不敏感：占名会 EEXIST 并换名，原文件一个字节都不能动
    assert.strictEqual(await read(path.join(tgt, '1_readme.TXT')), 'LOWER');
    assert.strictEqual(r.collected, 1);
    assert.strictEqual(r.renamed, 1);
    const names = await tree(tgt);
    assert.strictEqual(names.length, 2);
    assert.ok(names.includes('1_Readme_1.txt'), `实际：${names.join(', ')}`);
    assert.strictEqual(await read(path.join(tgt, '1_Readme_1.txt')), 'UPPER');
  });

  await test('目标路径存在同名文件 → TARGET_NOT_DIR', async () => {
    const src = await tmpDir('tfile/src');
    await write(path.join(src, 'a.txt'), 'A');
    const bad = path.join(ROOT, 'tfile/notadir');
    await write(bad, 'i am a file');
    await assert.rejects(
      () => collect({ srcDir: src, targetDir: bad }),
      (e) => e.code === 'TARGET_NOT_DIR' || e.code === 'EEXIST' || e.code === 'ENOTDIR'
    );
  });

  // -------------------------------------------------------------------------

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  if (fail > 0) {
    for (const f of failures) console.error(f.name, '\n', f.e);
    process.exitCode = 1;
  }
  await fsp.rm(ROOT, { recursive: true, force: true });
})();
