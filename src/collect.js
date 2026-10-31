'use strict';

/**
 * 收集引擎：把一个文件夹里的所有文件「平铺」复制到另一个文件夹
 * ---------------------------------------------------------------------------
 * 对应 movepy.py 的行为，但把 shutil.move 换成了「复制 + 校验 + 最后才删源」：
 *
 *   1. 递归遍历源文件夹，按名称排序（和 python sorted(os.listdir()) 一致）
 *   2. 给每个文件加「进入的层级序号」前缀：1_文件名.ext
 *      序号规则与脚本完全一致：顶层从 1 开始，每进入一个子文件夹用当前序号，
 *      出来后序号 +1，所以同名不同目录的文件不会互相盖掉
 *   3. 目标已有同名文件时追加 _1 / _2 …，绝不覆盖
 *   4. 默认「复制」，源文件保持不动；可选 move 模式，最后一步才删源
 *
 * 落名仍然沿用 mover 的原子占名法：先 open(path,'wx') 抢占一个 0 字节占位，
 * 再把临时件 rename 覆盖到自己的占位上。Windows 上 fs.rename 会静默替换，
 * 不这么干就可能盖掉用户已有的文件。
 *
 * 本模块不 require('electron')，可用 `node test/collect.test.js` 独立跑。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const { splitName, sanitizeName, isValidName, isDescendant, samePath, explain } = require('./mover');

const MAX_FILES = 20000;
const MAX_DEPTH = 32;
const HASH_LIMIT = 8 * 1024 * 1024;
const MAX_CANDIDATES = 999;
const MAX_STEM = 180;

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

class CollectError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'CollectError';
    this.code = code;
    this.detail = detail;
  }
}

const ERROR_TEXT = {
  SRC_MISSING: '源文件夹不存在或无法访问',
  SRC_NOT_DIR: '选的不是文件夹',
  TARGET_MISSING: '还没选目标文件夹',
  TARGET_NOT_DIR: '目标路径不是文件夹',
  SAME_DIR: '源文件夹和目标文件夹是同一个',
  TARGET_INSIDE_SRC: '目标文件夹不能放在源文件夹里面',
  NO_FILES: '这个文件夹里没有可收集的文件',
  TOO_MANY: `文件太多（超过 ${MAX_FILES} 个），已取消`,
  TOO_DEEP: '文件夹层级过深，已取消',
  VERIFY_FAILED: '复制后校验未通过，已跳过（原文件未受影响）',
  SOURCE_DELETE_FAILED: '已复制到目标位置，但原文件删除失败（两份都在）',
  NAME_EXHAUSTED: '同名项过多，无法生成新名称',
  SYMLINK: '符号链接已跳过',
  UNSUPPORTED_TYPE: '不支持的文件类型，已跳过',
};

/** 把任意异常翻译成 { code, message } */
function describe(err) {
  if (err instanceof CollectError) {
    const base = ERROR_TEXT[err.code] || '收集失败';
    return { code: err.code, message: err.detail ? `${base}（${err.detail}）` : base };
  }
  const x = explain(err);
  return { code: x.code, message: x.message };
}

function wrap(e) {
  return e instanceof CollectError ? e : new CollectError(e && e.code ? e.code : 'UNKNOWN');
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * 预扫描：只读，不改动任何东西。
 * 返回 { files: [{ abs, name, rel, index, size }], skipped, truncated }
 *
 * index 的推进规则逐条对齐 movepy.py：
 *   index 从 1 开始；遇到子文件夹就用「进入时的 index」递归，
 *   递归返回后 index += 1。顶层文件因此在同一次循环里取的也是当前 index。
 */
async function scanFiles(srcDir, { limit = MAX_FILES, maxDepth = MAX_DEPTH } = {}) {
  const files = [];
  const skipped = [];
  let truncated = false;

  async function walk(dir, index, depth, rel) {
    if (truncated) return;
    if (depth > maxDepth) throw new CollectError('TOO_DEEP');

    let ents;
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      throw new CollectError(e.code || 'UNKNOWN', path.basename(dir) || dir);
    }
    ents.sort(byName);

    for (const ent of ents) {
      if (truncated) return;
      const abs = path.join(dir, ent.name);
      const relPath = rel ? `${rel}${path.sep}${ent.name}` : ent.name;

      // 符号链接一律跳过：可能是死循环，也可能指向源文件夹外面
      if (ent.isSymbolicLink()) {
        skipped.push({ abs, name: ent.name, rel: relPath, code: 'SYMLINK' });
        continue;
      }

      if (ent.isDirectory()) {
        await walk(abs, index, depth + 1, relPath);
        index += 1;
        continue;
      }

      if (!ent.isFile()) {
        skipped.push({ abs, name: ent.name, rel: relPath, code: 'UNSUPPORTED_TYPE' });
        continue;
      }

      if (files.length >= limit) {
        truncated = true;
        return;
      }

      let size = 0;
      try {
        size = (await fsp.stat(abs)).size;
      } catch {
        size = 0;
      }
      files.push({ abs, name: ent.name, rel: relPath, index, size });
    }
  }

  await walk(srcDir, 1, 0, '');
  return { files, skipped, truncated };
}

// ---------------------------------------------------------------------------
// 落名
// ---------------------------------------------------------------------------

/**
 * 文件名清洗。
 * mover 里的 sanitizeName 用的正则没有 g 标志，只替换第一个非法字符，
 * 这里先做一遍全量替换再交给它处理保留名 / 长度 / 结尾点空格。
 */
const ILLEGAL_ALL = /[<>:"|?*\u0000-\u001f]/g;
function safeName(s) {
  return sanitizeName(String(s).replace(ILLEGAL_ALL, '_'));
}

/** 候选名：1_a.txt → 1_a_1.txt → 1_a_2.txt … → 时间戳兜底 */
function* nameCandidates(desired) {
  const base = safeName(desired);
  yield base;
  const { stem, ext } = splitName(base);
  const s = stem.length > MAX_STEM ? stem.slice(0, MAX_STEM) : stem;
  for (let i = 1; i <= MAX_CANDIDATES; i++) {
    yield `${s}_${i}${ext}`;
  }
  for (let k = 0; k < 32; k++) {
    const tag = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    yield `${s}_${tag}${ext}`;
  }
}

const TAKEN = new Set(['EEXIST', 'EISDIR']);

/**
 * 把临时件放到 tdir 下的第一个可用名字上。
 * 先 open(full,'wx') 原子占名，再 rename 覆盖我们自己的 0 字节占位。
 */
async function claim(tdir, desired, tmp) {
  for (const cand of nameCandidates(desired)) {
    if (!isValidName(cand)) continue;
    const full = path.join(tdir, cand);

    let fh;
    try {
      fh = await fsp.open(full, 'wx');
    } catch (e) {
      if (TAKEN.has(e.code)) continue;
      throw e;
    }
    try {
      await fh.close();
    } catch {
      /* 关闭失败不影响占名结果，继续 */
    }

    try {
      await fsp.rename(tmp, full);
      return full;
    } catch (e) {
      // 只删我们自己刚建的那个占位，别碰别人的文件
      await fsp.unlink(full).catch(() => {});
      throw e;
    }
  }
  throw new CollectError('NAME_EXHAUSTED');
}

async function cleanup(tmp) {
  try {
    await fsp.unlink(tmp);
  } catch {
    /* 已经不存在，正常 */
  }
}

/**
 * 把路径还原成「真实长路径」，不存在的部分原样拼回去。
 *
 * 必须这么做：Windows 上 %TEMP% 常是 8.3 短名（ADMINI~1），而 realpath 返回长名，
 * 直接 path.relative 会让「目标在源内部」「同一个目录」这类判断全部失效 ——
 * 那是会真的把文件复制进源目录、甚至自己收自己的致命 bug。
 */
async function resolveLong(p) {
  const abs = path.resolve(p);
  try {
    return await fsp.realpath(abs);
  } catch {
    /* 不存在，往下逐级找存在的祖先 */
  }

  const parts = [];
  let cur = abs;
  for (let i = 0; i < 64; i++) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    parts.unshift(path.basename(cur));
    cur = parent;
    try {
      const real = await fsp.realpath(cur);
      return path.join(real, ...parts);
    } catch {
      /* 继续向上 */
    }
  }
  return abs;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function verifyFile(src, dst) {
  const [a, b] = await Promise.all([fsp.stat(src), fsp.stat(dst)]);
  if (!b.isFile()) return { ok: false, detail: '目标不是文件' };
  if (a.size !== b.size) return { ok: false, detail: `大小 ${a.size} → ${b.size}` };
  if (a.size <= HASH_LIMIT) {
    const [ha, hb] = await Promise.all([sha256(src), sha256(dst)]);
    if (ha !== hb) return { ok: false, detail: '内容不一致' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 单个文件
// ---------------------------------------------------------------------------

async function copyOne(file, tdir, desired, move) {
  const base = safeName(desired);
  const tmp = path.join(tdir, `.${process.pid}-${crypto.randomBytes(5).toString('hex')}.wbcollect.tmp`);

  await fsp.copyFile(file.abs, tmp, fs.constants.COPYFILE_EXCL);

  let final;
  try {
    const v = await verifyFile(file.abs, tmp);
    if (!v.ok) throw new CollectError('VERIFY_FAILED', v.detail);
    final = await claim(tdir, base, tmp);
  } catch (e) {
    // claim 成功后 tmp 已被 rename 走，这里只会清掉真正的残留临时件
    await cleanup(tmp);
    throw wrap(e);
  }

  let warning = null;
  if (move) {
    try {
      await fsp.unlink(file.abs);
    } catch (e) {
      warning = {
        code: 'SOURCE_DELETE_FAILED',
        message: ERROR_TEXT.SOURCE_DELETE_FAILED,
      };
    }
  }

  const finalName = path.basename(final);
  return { finalPath: final, finalName, renamed: finalName !== base, warning };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function collect(options, hooks = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const prefix = opts.prefix !== false;
  const move = opts.move === true;
  const shouldStop = typeof hooks.shouldStop === 'function' ? hooks.shouldStop : () => false;
  const onProgress = typeof hooks.onProgress === 'function' ? hooks.onProgress : () => {};

  if (typeof opts.srcDir !== 'string' || !opts.srcDir.trim()) throw new CollectError('SRC_MISSING');

  let src;
  try {
    src = await fsp.realpath(opts.srcDir);
  } catch {
    throw new CollectError('SRC_MISSING');
  }
  const sst = await fsp.stat(src).catch(() => null);
  if (!sst || !sst.isDirectory()) throw new CollectError('SRC_NOT_DIR');

  if (typeof opts.targetDir !== 'string' || !opts.targetDir.trim()) throw new CollectError('TARGET_MISSING');

  // 目标可能还不存在，先把它还原成长路径再比包含关系，否则 8.3 短名会让判断失效
  const targetAbs = await resolveLong(opts.targetDir);

  // 目标落在源里面：收集过程中会把自己刚写进去的文件再扫一遍，必须拦掉
  if (samePath(src, targetAbs)) throw new CollectError('SAME_DIR');
  if (isDescendant(src, targetAbs)) throw new CollectError('TARGET_INSIDE_SRC');

  try {
    await fsp.mkdir(targetAbs, { recursive: true });
  } catch (e) {
    throw new CollectError(e.code === 'ENOTDIR' || e.code === 'EEXIST' ? 'TARGET_NOT_DIR' : e.code || 'UNKNOWN');
  }

  const tgt = await fsp.realpath(targetAbs).catch(() => null);
  if (!tgt) throw new CollectError('TARGET_MISSING');
  const tst = await fsp.stat(tgt).catch(() => null);
  if (!tst || !tst.isDirectory()) throw new CollectError('TARGET_NOT_DIR');

  // mkdir 之后再判一次（此时两边都是长路径，能兜住软链接绕出来的情况）
  if (samePath(src, tgt)) throw new CollectError('SAME_DIR');
  if (isDescendant(src, tgt)) throw new CollectError('TARGET_INSIDE_SRC');

  const { files, skipped, truncated } = await scanFiles(src);
  if (truncated) throw new CollectError('TOO_MANY');
  if (files.length === 0) throw new CollectError('NO_FILES');

  const results = [];
  let collected = 0;
  let renamed = 0;
  let failed = 0;
  let warning = 0;
  let bytes = 0;
  let canceled = false;

  for (let i = 0; i < files.length; i++) {
    if (shouldStop()) {
      canceled = true;
      break;
    }

    const f = files[i];
    const desired = prefix ? `${f.index}_${f.name}` : f.name;
    const item = {
      srcName: f.name,
      srcPath: f.abs,
      rel: f.rel,
      index: f.index,
      finalName: null,
      finalPath: null,
      status: 'pending',
      code: null,
      message: null,
    };

    try {
      const out = await copyOne(f, tgt, desired, move);
      item.finalName = out.finalName;
      item.finalPath = out.finalPath;
      bytes += f.size;

      if (out.warning) {
        item.status = 'warning';
        item.code = out.warning.code;
        item.message = out.warning.message;
        warning++;
        collected++; // 目标位置已经有这份文件了，算收下
      } else if (out.renamed) {
        item.status = 'renamed';
        item.message = `重命名为「${out.finalName}」，同名文件未被覆盖`;
        renamed++;
        collected++;
      } else {
        item.status = 'collected';
        item.message = '已复制到目标文件夹';
        collected++;
      }
    } catch (e) {
      const d = describe(e);
      item.status = 'failed';
      item.code = d.code;
      item.message = d.message;
      failed++;
    }

    results.push(item);
    onProgress({ done: i + 1, total: files.length, name: f.name, status: item.status });
  }

  return {
    ok: true,
    srcDir: src,
    targetDir: tgt,
    total: files.length,
    collected,
    renamed,
    failed,
    warning,
    skipped: skipped.length,
    bytes,
    canceled,
    results,
    skippedList: skipped,
  };
}

module.exports = {
  collect,
  scanFiles,
  describe,
  CollectError,
  ERROR_TEXT,
  nameCandidates,
  _internal: { claim, copyOne, verifyFile, MAX_FILES },
};
