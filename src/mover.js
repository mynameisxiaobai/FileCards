'use strict';

/**
 * 安全移动引擎
 * ---------------------------------------------------------------------------
 * 设计目标：任何一步失败，结果只能是「源还在」或「两份都在」，永远不允许「少一份」。
 *
 * 为什么不用 fs.rename 一把梭：
 *   Windows 上 libuv 用 MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)，目标存在同名
 *   文件时「静默替换、不报错」。所以最终落名必须先用 open(path,'wx')（CREATE_NEW）
 *   原子抢占，再把源改名到「我们自己刚占下的那个 0 字节文件」上。
 *
 * 为什么不用 fs.cp + 删除源：
 *   fs.cp 默认 force:true，默认行为就是覆盖；且整棵树复制是非原子的，
 *   中断后目标目录里会留下可见的半棵树。
 *
 * 为什么文件夹绝不合并：
 *   逐个文件搬进去 = merge 语义，会引入内部同名冲突、部分成功、半棵树。
 *   整棵树整体移动、只在最外层判重名，是唯一能保证不误覆盖的目录策略。
 *
 * 本模块不 require('electron')，可用 `node test/mover.test.js` 独立跑用例矩阵。
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const IS_WIN = process.platform === 'win32';

const HASH_LIMIT = 8 * 1024 * 1024; // <=8MB 追加 SHA-256 校验
const MAX_DEPTH = 32;
const MAX_ENTRIES = 100000;
const MAX_CANDIDATES = 999;
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EMFILE', 'ENFILE']);
// open(path,'wx') 撞名时的返回码。EPERM/EACCES 不在此列——那多半是「没有写权限」，
// 换名字重试 999 次也没用，只会白等几秒。
const CLAIM_TAKEN = new Set(['EEXIST', 'EISDIR']);
// 目录改名撞名时的返回码。Windows 上 MoveFileEx 用目录替换已存在目录不会成功，
// 失败即冲突，所以这里可以放心换名重试。
const RENAME_DIR_TAKEN = new Set(['EEXIST', 'ENOTEMPTY']);

const COMPOUND_EXT = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst', '.tar.z', '.tar.lz'];
const WIN_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);
const ILLEGAL_CHARS = /[<>:"|?*\u0000-\u001f]/;

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

class MoveError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'MoveError';
    this.code = code;
    this.detail = detail;
  }
}

const ERROR_TEXT = {
  NOT_EXIST: '文件或文件夹已不存在',
  ALREADY_THERE: '已经在目标文件夹中',
  DUPLICATE_IN_BATCH: '同一次拖入中重复出现',
  SRC_IS_TARGET: '目标文件夹就是这个文件本身',
  SRC_IS_ANCESTOR: '不能把文件夹移动到它自己内部',
  DANGEROUS_SRC: '不允许移动系统文件夹或磁盘根目录',
  SYMLINK: '包含符号链接或联接点，无法安全移动',
  UNSUPPORTED_TYPE: '不支持的文件类型',
  TOO_DEEP: '文件夹层级过深，已取消',
  TOO_MANY: '文件夹内条目过多，已取消',
  TARGET_NOT_DIR: '目标路径不是文件夹',
  TARGET_MISSING: '目标文件夹不存在，请重新选择',
  NAME_EXHAUSTED: '同名项过多，无法生成新名称',
  PATH_TOO_LONG: '路径过长，无法移动',
  VERIFY_FAILED: '复制后校验未通过，已取消（源文件未受影响）',
  SOURCE_CHANGED: '源文件在移动过程中被修改，已取消（源文件未受影响）',
  ASSERT_FAILED: '移动结果校验未通过，请立即检查这两个位置',
  SOURCE_DELETE_FAILED: '已复制到目标位置，但源文件删除失败（两份都在）',
  ENOSPC: '目标磁盘空间不足，源文件未受影响',
  ENOENT: '文件或文件夹已不存在',
  EACCES: '没有权限访问该位置',
  EPERM: '操作被系统拒绝，文件可能被其他程序占用',
  EBUSY: '文件正被其他程序占用，请关闭后重试',
  ENAMETOOLONG: '路径过长，无法移动',
  EEXIST: '目标位置已存在同名项',
  EIO: '磁盘读写错误，若目标在移动硬盘上请检查连接',
  EXDEV: '跨磁盘移动失败',
};

function explain(err) {
  const code = err && err.code ? String(err.code) : 'UNKNOWN';
  const base = ERROR_TEXT[code] || '移动失败';
  const suffix = err && err.detail ? `（${err.detail}）` : '';
  return {
    code,
    message: base + suffix,
    // 未知错误也带上原始 code，方便用户截图反馈
    hint: ERROR_TEXT[code] ? undefined : `错误代码 ${code}`,
  };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function norm(p) {
  return IS_WIN ? path.resolve(p).toLowerCase() : path.resolve(p);
}

function samePath(a, b) {
  if (!a || !b) return false;
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

/** child 是否在 parent 之下（不含 parent 本身）。跨盘返回 false。 */
function isDescendant(parent, child) {
  if (!parent || !child) return false;
  const rel = path.relative(parent, child);
  if (!rel || path.isAbsolute(rel)) return false;
  return rel.split(path.sep)[0] !== '..';
}

async function exists(p) {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** 仅对「可能过一会儿就好」的错误重试；ENOSPC/EXDEV/ENOENT 重试没有意义。 */
async function retryOnBusy(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!BUSY_CODES.has(e.code)) throw e;
      await sleep(120 * 2 ** i);
    }
  }
  throw last;
}

/** 超长路径兜底：只在真的报了 ENAMETOOLONG 时才套 \\?\ 前缀重试一次。 */
async function withLongPath(fn, p, ...args) {
  try {
    return await fn(p, ...args);
  } catch (e) {
    if (e.code === 'ENAMETOOLONG' && IS_WIN && !p.startsWith('\\\\?\\')) {
      return await fn('\\\\?\\' + path.resolve(p), ...args);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 文件名处理
// ---------------------------------------------------------------------------

function splitName(name) {
  if (name.startsWith('.') && !name.slice(1).includes('.')) {
    return { stem: name, ext: '' }; // .gitignore 不切分
  }
  const lower = name.toLowerCase();
  for (const ce of COMPOUND_EXT) {
    if (lower.endsWith(ce) && name.length > ce.length) {
      return { stem: name.slice(0, -ce.length), ext: name.slice(-ce.length) };
    }
  }
  const i = name.lastIndexOf('.');
  if (i <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, i), ext: name.slice(i) };
}

function isValidName(name) {
  if (!name || name === '.' || name === '..') return false;
  if (name.length > 255) return false;
  if (ILLEGAL_CHARS.test(name)) return false;
  if (/[ .]$/.test(name)) return false;
  const base = name.split('.')[0].toLowerCase();
  if (WIN_RESERVED.has(base)) return false;
  return true;
}

function sanitizeName(name) {
  let s = String(name).replace(ILLEGAL_CHARS, '_');
  s = s.replace(/[ .]+$/, '');
  if (!s) s = 'file';
  const base = s.split('.')[0].toLowerCase();
  if (WIN_RESERVED.has(base)) s = '_' + s;
  if (s.length > 200) {
    const { stem, ext } = splitName(s);
    s = stem.slice(0, 200 - ext.length) + ext;
  }
  return s;
}

/** 候选名：原名 → 原名 (1) … (999) → 原名 (时间戳-随机)。惰性生成，永不无限循环。 */
function* candidateNames(original) {
  const base = sanitizeName(original);
  yield base;
  const { stem, ext } = splitName(base);
  const stemLimited = stem.length > 190 ? stem.slice(0, 190) : stem;
  for (let i = 1; i <= MAX_CANDIDATES; i++) {
    yield `${stemLimited} (${i})${ext}`;
  }
  for (let k = 0; k < 32; k++) {
    const tag = Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
    yield `${stemLimited} (${tag})${ext}`;
  }
}

// ---------------------------------------------------------------------------
// 危险源
// ---------------------------------------------------------------------------

function dangerReason(p) {
  const root = path.parse(p).root;
  if (samePath(p, root)) return '磁盘根目录';

  const env = process.env;
  const guarded = [
    env.SystemRoot || 'C:\\Windows',
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.ProgramData,
    env.USERPROFILE,
  ].filter(Boolean);

  for (const g of guarded) {
    if (samePath(p, g)) return path.basename(g) || g;
  }

  const base = path.basename(p).toLowerCase();
  if (base === '$recycle.bin' || base === 'system volume information') {
    return '系统受保护目录';
  }

  // 系统目录内部的任意位置也不允许（避免把 Windows 里的文件搬走）
  for (const g of guarded.slice(0, 4)) {
    if (g && isDescendant(g, p)) return `${path.basename(g)} 内部`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 预检
// ---------------------------------------------------------------------------

async function scanTree(root) {
  let count = 0;
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > MAX_DEPTH) return { ok: false, code: 'TOO_DEEP' };
    let ents;
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      return { ok: false, code: e.code || 'UNKNOWN' };
    }
    for (const e of ents) {
      if (++count > MAX_ENTRIES) return { ok: false, code: 'TOO_MANY' };
      if (e.isSymbolicLink()) return { ok: false, code: 'SYMLINK' };
      if (e.isDirectory()) stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return { ok: true };
}

/**
 * 只读预检。返回 { skip, code } 表示不动；抛 MoveError 表示拒绝；否则返回 plan。
 */
async function planMove(rawSrc, rawTarget) {
  if (typeof rawSrc !== 'string' || typeof rawTarget !== 'string') {
    throw new MoveError('UNSUPPORTED_TYPE', '参数类型错误');
  }

  let tdir;
  try {
    tdir = await fsp.realpath(rawTarget);
  } catch (e) {
    throw new MoveError('TARGET_MISSING');
  }

  let src;
  try {
    src = await fsp.realpath(rawSrc);
  } catch (e) {
    if (e.code === 'ENOENT') return { skip: 'NOT_EXIST', srcRaw: rawSrc };
    throw e;
  }

  // 先判「目标就是源本身」，再判目标类型 —— 否则同一个错误会被报成"目标不是文件夹"
  if (samePath(src, tdir)) throw new MoveError('SRC_IS_TARGET');

  const tst = await fsp.stat(tdir);
  if (!tst.isDirectory()) throw new MoveError('TARGET_NOT_DIR');

  const st = await fsp.lstat(src);
  if (st.isSymbolicLink()) throw new MoveError('SYMLINK');
  if (!st.isFile() && !st.isDirectory()) throw new MoveError('UNSUPPORTED_TYPE');

  const danger = dangerReason(src);
  if (danger) throw new MoveError('DANGEROUS_SRC', danger);

  // 已经在目标目录里
  if (samePath(path.dirname(src), tdir)) {
    return { skip: 'ALREADY_THERE', src };
  }
  // 目标是源的祖先：允许（把子目录里的文件挪到上层），继续
  // 源是目标的祖先：说明目标在源内部，把文件夹拖进自己子目录 —— 拒绝
  if (isDescendant(src, tdir)) throw new MoveError('SRC_IS_ANCESTOR');

  const kind = st.isDirectory() ? 'dir' : 'file';

  if (kind === 'dir') {
    const scan = await scanTree(src);
    if (!scan.ok) throw new MoveError(scan.code);
  }

  const name = path.basename(src);

  return {
    skip: null,
    src,
    tdir,
    kind,
    name,
    size: st.size,
    mtimeMs: st.mtimeMs,
    crossVolume: st.dev !== tst.dev,
  };
}

// ---------------------------------------------------------------------------
// 落名：原子占名 + 放置
// ---------------------------------------------------------------------------

function tempPath(tdir, name, kind) {
  const tag = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  return path.join(tdir, `.${sanitizeName(name)}.wbmove-${tag}.tmp`);
}

const isClaimTaken = (e) => !!e && CLAIM_TAKEN.has(e.code);
const isDirTaken = (e) => !!e && RENAME_DIR_TAKEN.has(e.code);

/**
 * 依次尝试候选名，对每个候选执行 place(finalPath)。
 * - 文件：先 open(full,'wx') 原子抢占（EEXIST 天然覆盖大小写不敏感/Unicode 变体/并发）
 * - 目录：rename 在 Windows 上无法用目录替换已存在目录，天然 no-clobber，
 *         所以探测 + 竞态失败后换名重试即可
 */
async function claimAndPlace(tdir, originalName, kind, place) {
  for (const cand of candidateNames(originalName)) {
    if (!isValidName(cand)) continue;
    const full = path.join(tdir, cand);

    if (kind === 'file') {
      let fh;
      try {
        fh = await withLongPath(fsp.open, full, 'wx');
      } catch (e) {
        if (isClaimTaken(e)) continue; // 名字被占，换下一个候选
        throw e;
      }
      await fh.close();

      try {
        await place(full);
      } catch (e) {
        // 只删我们自己刚创建的那个 0 字节占位文件
        await fsp.unlink(full).catch(() => {});
        throw e;
      }
      return full;
    }

    // 目录：Windows 上 rename 无法用目录替换已存在目录，天然 no-clobber。
    // 所以先探测（省一次 rename），竞态失败后换名重试即可。
    if (await exists(full)) continue;
    try {
      await place(full);
      return full;
    } catch (e) {
      if (isDirTaken(e)) {
        await cleanupEmptyDir(full);
        continue;
      }
      throw e;
    }
  }
  throw new MoveError('NAME_EXHAUSTED');
}

async function cleanupEmptyDir(dir) {
  try {
    const ents = await fsp.readdir(dir);
    if (ents.length === 0) await fsp.rmdir(dir);
  } catch {
    /* 不存在或非空，不动 */
  }
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

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

async function walkTree(root) {
  const files = new Map();
  const dirs = new Set();
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    const ents = await fsp.readdir(abs, { withFileTypes: true });
    for (const e of ents) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        dirs.add(r);
        stack.push(r);
      } else {
        const st = await fsp.lstat(path.join(abs, e.name));
        files.set(r, st.size);
      }
    }
  }
  return { files, dirs };
}

async function verifyTree(src, dst) {
  const [a, b] = await Promise.all([walkTree(src), walkTree(dst)]);
  if (a.files.size !== b.files.size) {
    return { ok: false, detail: `文件数 ${a.files.size} → ${b.files.size}` };
  }
  for (const [rel, size] of a.files) {
    const other = b.files.get(rel);
    if (other === undefined) return { ok: false, detail: `缺少 ${rel}` };
    if (other !== size) return { ok: false, detail: `${rel} 大小 ${size} → ${other}` };
  }
  if (a.dirs.size !== b.dirs.size) {
    return { ok: false, detail: `文件夹数 ${a.dirs.size} → ${b.dirs.size}` };
  }
  return { ok: true };
}

async function assertLanded(final, kind, size) {
  const st = await fsp.stat(final);
  const typeOk = kind === 'file' ? st.isFile() : st.isDirectory();
  const sizeOk = kind === 'file' ? st.size === size : true;
  if (!typeOk || !sizeOk) {
    throw new MoveError('ASSERT_FAILED', `目标类型/大小不符（type=${typeOk} size=${sizeOk}）`);
  }
}

async function assertGone(src) {
  let gone = false;
  try {
    await fsp.lstat(src);
  } catch (e) {
    if (e.code === 'ENOENT') gone = true;
    else throw e;
  }
  if (!gone) throw new MoveError('ASSERT_FAILED', '源文件仍然存在，移动未生效');
}

// ---------------------------------------------------------------------------
// 两条路径
// ---------------------------------------------------------------------------

async function moveSameVolume(plan) {
  const final = await claimAndPlace(plan.tdir, plan.name, plan.kind, async (dest) => {
    await retryOnBusy(() => withLongPath(fsp.rename, plan.src, dest));
  });
  await assertGone(plan.src);
  await assertLanded(final, plan.kind, plan.size);
  return { finalPath: final, finalName: path.basename(final), warning: null };
}

async function moveCrossVolume(plan) {
  const tmp = tempPath(plan.tdir, plan.name, plan.kind);
  let final = null;

  try {
    // ① 复制到目标目录内的临时名（EXCL，绝不覆盖）
    if (plan.kind === 'file') {
      await withLongPath(fsp.copyFile, plan.src, tmp, fs.constants.COPYFILE_EXCL);
    } else {
      await fsp.cp(plan.src, tmp, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
        dereference: false,
      });
    }

    // ② 校验临时件（此时源还在，随时可以放弃）
    const v = plan.kind === 'file'
      ? await verifyFile(plan.src, tmp)
      : await verifyTree(plan.src, tmp);
    if (!v.ok) throw new MoveError('VERIFY_FAILED', v.detail);

    // ③ 源在复制期间是否被改动
    const after = await fsp.lstat(plan.src);
    if (after.size !== plan.size || Math.abs(after.mtimeMs - plan.mtimeMs) > 1) {
      throw new MoveError('SOURCE_CHANGED');
    }

    // ④ 占名 + 同卷原子改名
    final = await claimAndPlace(plan.tdir, plan.name, plan.kind, async (dest) => {
      await retryOnBusy(() => withLongPath(fsp.rename, tmp, dest));
    });

    // ⑤ 落盘断言（此时源应仍在）
    await assertLanded(final, plan.kind, plan.size);
  } catch (e) {
    // 清理我们自己的临时件。注意：若 rename 已成功但后续断言失败，临时名已不存在，
    // cleanupTmp 会静默跳过——那份数据仍留在 final 位置，绝不删，交给用户判断。
    await cleanupTmp(tmp);
    throw e;
  }

  // ⑥ 最后一步：删源。失败 = 两份都在，算成功但要提醒
  try {
    if (plan.kind === 'file') {
      await fsp.unlink(plan.src);
    } else {
      await fsp.rm(plan.src, { recursive: true, maxRetries: 3, retryDelay: 150 });
    }
  } catch (e) {
    return {
      finalPath: final,
      finalName: path.basename(final),
      warning: 'SOURCE_DELETE_FAILED',
      warningDetail: `${explain(e).message}`,
    };
  }

  await assertGone(plan.src).catch(() => {
    /* 已尽力，UI 仍按成功展示 */
  });

  return { finalPath: final, finalName: path.basename(final), warning: null };
}

async function cleanupTmp(tmp) {
  try {
    const st = await fsp.lstat(tmp);
    if (st.isDirectory()) await fsp.rm(tmp, { recursive: true, force: true });
    else await fsp.unlink(tmp);
  } catch {
    /* 不存在，正常 */
  }
}

// ---------------------------------------------------------------------------
// 单项 / 批量
// ---------------------------------------------------------------------------

function baseResult(rawSrc, cardId) {
  return {
    srcPath: rawSrc,
    srcName: path.basename(rawSrc || '') || String(rawSrc || ''),
    cardId: cardId ?? null,
    status: 'pending',
    finalName: null,
    finalPath: null,
    code: null,
    message: null,
    renamed: false,
  };
}

async function moveOne(rawSrc, rawTarget, cardId) {
  const r = baseResult(rawSrc, cardId);
  let plan;
  try {
    plan = await planMove(rawSrc, rawTarget);
  } catch (e) {
    Object.assign(r, { status: 'failed' }, explain(e));
    return r;
  }

  if (plan.skip) {
    r.status = 'skipped';
    r.code = plan.skip;
    r.message = ERROR_TEXT[plan.skip] || '已跳过';
    return r;
  }

  try {
    const out = plan.crossVolume
      ? await moveCrossVolume(plan)
      : await moveSameVolume(plan);

    r.finalPath = out.finalPath;
    r.finalName = out.finalName;
    r.renamed = out.finalName !== plan.name;

    if (out.warning) {
      r.status = 'warning';
      r.code = out.warning;
      r.message = explain({ code: out.warning, detail: out.warningDetail }).message;
    } else {
      r.status = r.renamed ? 'renamed' : 'moved';
      r.message = r.renamed
        ? `已重命名为「${out.finalName}」，原同名文件未被改动`
        : '已移动到目标文件夹';
    }
    return r;
  } catch (e) {
    Object.assign(r, { status: 'failed' }, explain(e));
    return r;
  }
}

function tally(results) {
  const s = { moved: 0, renamed: 0, skipped: 0, failed: 0, warning: 0, total: results.length };
  for (const r of results) {
    if (r.status === 'moved') s.moved++;
    else if (r.status === 'renamed') s.renamed++;
    else if (r.status === 'skipped') s.skipped++;
    else if (r.status === 'warning') s.warning++;
    else if (r.status === 'failed') s.failed++;
  }
  s.ok = s.moved + s.renamed + s.warning;
  return s;
}

/** 严格串行：结果确定、错误归属清晰、不会并发抢 IO 造成 EBUSY 误报 */
async function moveMany(rawList, rawTarget, cardId, onProgress) {
  const results = [];
  const seen = new Set();

  for (const raw of rawList) {
    const key = IS_WIN ? String(raw).toLowerCase() : String(raw);
    if (seen.has(key)) {
      const r = baseResult(raw, cardId);
      Object.assign(r, { status: 'skipped', code: 'DUPLICATE_IN_BATCH', message: ERROR_TEXT.DUPLICATE_IN_BATCH });
      results.push(r);
    } else {
      seen.add(key);
      results.push(await moveOne(raw, rawTarget, cardId));
    }
    if (onProgress) onProgress(results.length, rawList.length, results[results.length - 1]);
  }

  return { results, summary: tally(results) };
}

module.exports = {
  moveOne,
  moveMany,
  planMove,
  tally,
  explain,
  MoveError,
  candidateNames,
  splitName,
  sanitizeName,
  isValidName,
  isDescendant,
  samePath,
  // 供测试使用
  _internal: { claimAndPlace, tempPath, verifyTree, HASH_LIMIT },
};
