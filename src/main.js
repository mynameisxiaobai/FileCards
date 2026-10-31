'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  shell,
  dialog,
  screen,
  nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const { moveMany } = require('./mover');
const collector = require('./collect');

// ---------------------------------------------------------------------------
// 布局常量（与 style.css 里的 --grid-pad / --gap 保持一致）
// 注意：卡片不再固定正方形，直接铺满网格；这里只用于推算「默认窗口」和
// 「增卡时至少要多大才能放下可读的格子」。
// ---------------------------------------------------------------------------

const CARD_SIZE = 150; // 新装时的默认窗口基准宽度（不是卡片实际尺寸）
const CARD_H = 190; // 默认窗口基准高度：略高于宽，卡片是竖直小面板而不是方块
const MIN_CARD = 104; // 增删卡片时，窗口至少放大到每个格子有这个宽度/高度
const GAP = 10;
const PAD = 14;
const TITLEBAR = 34;
const MAX_CARDS = 6;
const MIN_CARDS = 1;

/** 卡片排几列几行 —— 必须和 renderer 里 columnSpans() / rowCount() 一致 */
function gridShape(n) {
  switch (n) {
    case 1:
      return { cols: 1, rows: 1 };
    case 2:
      return { cols: 2, rows: 1 };
    case 3:
      return { cols: 3, rows: 1 };
    case 4:
      return { cols: 2, rows: 2 };
    default:
      return { cols: 3, rows: 2 }; // 5 / 6
  }
}

// 窗口最小尺寸：再小卡片里的字就挤成一团了
const WIN_MIN_W = 240;
const WIN_MIN_H = 200;
const WIN_MAX_W = 2400;
const WIN_MAX_H = 1600;

const clampWidth = (v) => Math.min(Math.max(Math.round(v), WIN_MIN_W), WIN_MAX_W);
const clampHeight = (v) => Math.min(Math.max(Math.round(v), WIN_MIN_H), WIN_MAX_H);

// ---------------------------------------------------------------------------
// 配置：userData/config.json，tmp + rename 原子写
// ---------------------------------------------------------------------------

const CONFIG_DIR = app.getPath('userData');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function defaults() {
  return {
    version: 1,
    cards: [
      { id: 'c1', dir: null, label: '收件箱' },
      { id: 'c2', dir: null, label: '归档' },
    ],
    alwaysOnTop: false,
    bounds: null,
    // 收集弹窗上次用的目标文件夹与开关
    collect: { targetDir: null, prefix: true, move: false },
  };
}

function sanitizeConfig(raw) {
  const d = defaults();
  if (!raw || typeof raw !== 'object') return d;

  const cards = Array.isArray(raw.cards) ? raw.cards : [];
  const cleaned = [];
  const usedIds = new Set();

  for (const c of cards.slice(0, MAX_CARDS)) {
    if (!c || typeof c !== 'object') continue;
    let id = typeof c.id === 'string' && /^[a-z0-9_-]{1,24}$/i.test(c.id) ? c.id : `c${cleaned.length + 1}`;
    while (usedIds.has(id)) id = `c${cleaned.length + 1}${Math.random().toString(36).slice(2, 5)}`;
    usedIds.add(id);
    cleaned.push({
      id,
      dir: typeof c.dir === 'string' && path.isAbsolute(c.dir) ? c.dir : null,
      label: typeof c.label === 'string' && c.label.trim() ? c.label.slice(0, 24) : '未命名',
    });
  }

  while (cleaned.length < MIN_CARDS) {
    const id = `c${cleaned.length + 1}`;
    cleaned.push({ id, dir: null, label: cleaned.length === 0 ? '收件箱' : '归档' });
  }

  const b = raw.bounds;
  const bounds =
    b && Number.isFinite(b.x) && Number.isFinite(b.y)
      ? {
          x: Math.round(b.x),
          y: Math.round(b.y),
          // 旧版本只存了 x/y，缺尺寸时留空，由调用方回落到默认布局
          width: Number.isFinite(b.width) ? Math.round(clampWidth(b.width)) : null,
          height: Number.isFinite(b.height) ? Math.round(clampHeight(b.height)) : null,
        }
      : null;

  return {
    version: 1,
    cards: cleaned,
    alwaysOnTop: raw.alwaysOnTop === true,
    bounds,
    collect: sanitizeCollect(raw.collect),
  };
}

function sanitizeCollect(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    targetDir: typeof c.targetDir === 'string' && c.targetDir && path.isAbsolute(c.targetDir) ? c.targetDir : null,
    prefix: c.prefix !== false,
    move: c.move === true,
  };
}

function loadConfig() {
  try {
    const text = fs.readFileSync(CONFIG_FILE, 'utf8');
    return sanitizeConfig(JSON.parse(text));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // 配置损坏绝不阻断启动：备份后回落默认值
      try {
        const bak = `${CONFIG_FILE}.corrupt-${Date.now()}.json`;
        fs.renameSync(CONFIG_FILE, bak);
        console.warn('[config] 解析失败，已备份到', bak);
      } catch {}
    }
    return defaults();
  }
}

let config = defaults();
let saveTimer = null;
let saveChain = Promise.resolve();

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveChain = saveChain.then(saveNow).catch((e) => console.error('[config] 写入失败', e));
  }, 300);
}

async function saveNow() {
  const tmp = CONFIG_FILE + '.tmp';
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
  await fsp.rename(tmp, CONFIG_FILE);
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

let win = null;
let tray = null;
let quitting = false;

function layoutFor(n) {
  const { cols, rows } = gridShape(Math.min(Math.max(n, 1), MAX_CARDS));
  return {
    cols,
    rows,
    width: PAD * 2 + cols * CARD_SIZE + (cols - 1) * GAP,
    height: TITLEBAR + PAD * 2 + rows * CARD_H + (rows - 1) * GAP,
  };
}

function initialPosition(w, h) {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + workArea.width - w - 40),
    y: Math.round(workArea.y + workArea.height - h - 60),
  };
}

function clampToWorkArea(x, y, w, h) {
  const { workArea } = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
  return {
    x: Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - w),
    y: Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - h),
  };
}

/** 保证窗口至少露出 120px，且顶边不出屏（标题栏必须抓得到） */
function safePosition(x, y, width, height) {
  const { workArea } = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
  const KEEP = 120;
  return {
    x: Math.min(Math.max(Math.round(x), workArea.x - width + KEEP), workArea.x + workArea.width - KEEP),
    y: Math.min(Math.max(Math.round(y), workArea.y), workArea.y + workArea.height - KEEP),
  };
}

/** 记录当前窗口位置与尺寸（拖动和缩放都走这里） */
function saveBoundsNow() {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  const b = win.getBounds();
  config.bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
  scheduleSave();
}

let boundsTimer = null;
function scheduleBoundsSave() {
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    boundsTimer = null;
    saveBoundsNow();
  }, 350);
}

function trayImage() {
  try {
    const p = path.join(__dirname, '..', 'assets', 'tray.png');
    const buf = fs.readFileSync(p); // readFileSync 支持 asar 内路径
    return nativeImage.createFromBuffer(buf);
  } catch (e) {
    console.warn('[tray] 图标加载失败', e.message);
    return nativeImage.createEmpty();
  }
}

function createWindow() {
  const g = layoutFor(config.cards.length);
  const saved = config.bounds;
  const raw = saved || initialPosition(g.width, g.height);

  // 换过显示器、改过分辨率后，旧尺寸可能比屏幕还大 —— 先压进工作区
  const { workArea } = screen.getDisplayNearestPoint({ x: Math.round(raw.x), y: Math.round(raw.y) });
  const w = Math.min(clampWidth((saved && saved.width) || g.width), workArea.width);
  const h = Math.min(clampHeight((saved && saved.height) || g.height), workArea.height);
  const pos = safePosition(raw.x, raw.y, w, h);

  win = new BrowserWindow({
    width: w,
    height: h,
    x: pos.x,
    y: pos.y,
    minWidth: WIN_MIN_W,
    minHeight: WIN_MIN_H,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    roundedCorners: true,
    thickFrame: true,
    hasShadow: true,
    backgroundColor: '#F7F8FA',
    show: false,
    alwaysOnTop: config.alwaysOnTop,
    title: '归位',
    icon: trayImage(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      navigateOnDragDrop: false,
      spellcheck: false,
      // 窗口被其他窗口挡住时 Chromium 会把渲染进程判成 hidden 并冻结布局，
      // 再露出来时卡片尺寸就是旧的。这个工具随时要被拖放，不能停。
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    if (process.env.DEBUG) win.webContents.openDevTools({ mode: 'detach' });
  });

  // 三层防导航：任何一层还在就还有救，所以不要只做一层
  const wc = win.webContents;
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-frame-navigate', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.on('move', scheduleBoundsSave);
  win.on('resize', scheduleBoundsSave);

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
      updateTrayMenu();
    }
  });

  win.on('show', updateTrayMenu);
}

/**
 * 卡片数量变化时调用：只在窗口装不下「最小可读卡片」时才把窗口撑大。
 * 已经够大就一律不动 —— 尺寸归用户管，不能被程序抢回去。
 */
function ensureWindowFits() {
  if (!win || win.isDestroyed()) return;
  const { cols, rows } = gridShape(Math.min(Math.max(config.cards.length, 1), MAX_CARDS));
  const needW = clampWidth(PAD * 2 + cols * MIN_CARD + (cols - 1) * GAP);
  const needH = clampHeight(TITLEBAR + PAD * 2 + rows * MIN_CARD + (rows - 1) * GAP);

  const b = win.getBounds();
  const w = Math.max(b.width, needW);
  const h = Math.max(b.height, needH);
  if (w === b.width && h === b.height) return;

  const pos = clampToWorkArea(b.x, b.y, w, h);
  win.setBounds({ x: pos.x, y: pos.y, width: w, height: h });
  saveBoundsNow();
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible() && !win.isMinimized()) {
    win.hide();
  } else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  updateTrayMenu();
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------

function updateTrayMenu() {
  if (!tray) return;
  const visible = !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: visible ? '隐藏窗口' : '显示窗口',
        click: toggleWindow,
      },
      {
        label: '收集文件…',
        click: openCollectWindow,
      },
      {
        label: '窗口置顶',
        type: 'checkbox',
        checked: config.alwaysOnTop,
        click: (item) => setAlwaysOnTop(item.checked),
      },
      { type: 'separator' },
      {
        label: '打开配置文件位置',
        click: () => shell.openPath(CONFIG_DIR),
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('归位 · 拖进去就归位');
  tray.on('click', toggleWindow);
  updateTrayMenu();
}

function setAlwaysOnTop(v) {
  config.alwaysOnTop = !!v;
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(config.alwaysOnTop);
  scheduleSave();
  updateTrayMenu();
  if (win && !win.isDestroyed()) win.webContents.send('state:changed', publicState());
}

// ---------------------------------------------------------------------------
// 收集弹窗：把某个文件夹里的文件平铺复制到另一个文件夹
// 主窗口最小只有 240×200，塞不下两个拖放区，所以单独开一个版式固定的窗口。
// ---------------------------------------------------------------------------

let collectWin = null;
/** 当前正在跑的收集任务，canceled=true 会在下一个文件前停下 */
let collectJob = null;

function sendCollect(channel, payload) {
  if (collectWin && !collectWin.isDestroyed()) {
    collectWin.webContents.send(channel, payload);
  }
}

function openCollectWindow() {
  if (collectWin && !collectWin.isDestroyed()) {
    if (collectWin.isMinimized()) collectWin.restore();
    collectWin.show();
    collectWin.focus();
    return;
  }

  const W = 520;
  const H = 462;
  const parent = win && !win.isDestroyed() ? win : null;
  const pb = parent ? parent.getBounds() : null;
  const anchor = pb ? { x: pb.x, y: pb.y } : screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(anchor);

  const x = pb ? Math.round(pb.x + (pb.width - W) / 2) : Math.round(workArea.x + (workArea.width - W) / 2);
  const y = pb ? Math.round(pb.y + (pb.height - H) / 2) : Math.round(workArea.y + (workArea.height - H) / 2);
  const pos = clampToWorkArea(x, y, W, H);

  collectWin = new BrowserWindow({
    width: W,
    height: H,
    x: pos.x,
    y: pos.y,
    minWidth: 440,
    minHeight: 420,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    roundedCorners: true,
    thickFrame: true,
    hasShadow: true,
    backgroundColor: '#F7F8FA',
    show: false,
    title: '收集文件',
    icon: trayImage(),
    parent: parent || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'collect-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      navigateOnDragDrop: false,
      spellcheck: false,
    },
  });

  collectWin.loadFile(path.join(__dirname, 'renderer', 'collect.html'));

  collectWin.once('ready-to-show', () => {
    collectWin.show();
    collectWin.focus();
  });

  const cwc = collectWin.webContents;
  cwc.on('will-navigate', (e) => e.preventDefault());
  cwc.on('will-frame-navigate', (e) => e.preventDefault());
  cwc.setWindowOpenHandler(() => ({ action: 'deny' }));

  collectWin.on('closed', () => {
    collectWin = null;
    // 窗口都没了就别继续复读了，停在第 N 个文件上（源文件不受影响）
    if (collectJob) collectJob.canceled = true;
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function publicState() {
  return {
    cards: config.cards,
    alwaysOnTop: config.alwaysOnTop,
    layout: layoutFor(config.cards.length),
  };
}

/** 串行队列：同一时刻只跑一个 batch */
let jobChain = Promise.resolve();

function registerIpc() {
  ipcMain.handle('app:init', () => publicState());

  ipcMain.handle('card:pick-dir', async (_e, cardId) => {
    const card = config.cards.find((c) => c.id === cardId);
    if (!card) return { error: 'CARD_NOT_FOUND' };
    const res = await dialog.showOpenDialog(win, {
      title: '选择要归位到的文件夹',
      properties: ['openDirectory', 'dontAddToRecent'],
      defaultPath: card.dir || app.getPath('downloads'),
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    card.dir = res.filePaths[0];
    scheduleSave();
    return { dir: card.dir, state: publicState() };
  });

  ipcMain.handle('card:add', () => {
    if (config.cards.length >= MAX_CARDS) return { state: publicState() };
    const used = new Set(config.cards.map((c) => c.id));
    let n = config.cards.length + 1;
    while (used.has(`c${n}`)) n++;
    config.cards.push({ id: `c${n}`, dir: null, label: `卡片 ${n}` });
    scheduleSave();
    ensureWindowFits();
    return { state: publicState() };
  });

  ipcMain.handle('card:remove', (_e, cardId) => {
    if (config.cards.length <= MIN_CARDS) return { state: publicState() };
    const i = config.cards.findIndex((c) => c.id === cardId);
    if (i < 0) return { state: publicState() };
    config.cards.splice(i, 1);
    scheduleSave();
    ensureWindowFits();
    return { state: publicState() };
  });

  ipcMain.handle('card:rename', (_e, cardId, label) => {
    const card = config.cards.find((c) => c.id === cardId);
    if (!card) return { state: publicState() };
    const t = String(label || '').trim().slice(0, 24);
    if (t) card.label = t;
    scheduleSave();
    return { state: publicState() };
  });

  ipcMain.handle('win:layout', () => {
    ensureWindowFits();
    return { state: publicState() };
  });

  ipcMain.handle('win:always-on-top', (_e, v) => {
    setAlwaysOnTop(v);
    return { alwaysOnTop: config.alwaysOnTop };
  });

  ipcMain.handle('win:hide', () => {
    if (win && !win.isDestroyed()) win.hide();
    updateTrayMenu();
  });

  // 自绘边框缩放用：渲染层拿鼠标屏幕坐标算差值，这里只负责落地
  ipcMain.handle('win:get-bounds', () => {
    if (!win || win.isDestroyed()) return null;
    return win.getBounds();
  });

  ipcMain.handle('win:set-bounds', (_e, b) => {
    if (!win || win.isDestroyed() || !b || typeof b !== 'object') return null;

    const cur = win.getBounds();
    const width = Number.isFinite(b.width) ? clampWidth(b.width) : cur.width;
    const height = Number.isFinite(b.height) ? clampHeight(b.height) : cur.height;
    const x = Number.isFinite(b.x) ? b.x : cur.x;
    const y = Number.isFinite(b.y) ? b.y : cur.y;

    // 顶边绝不允许出屏：标题栏一旦看不到，这窗口就再也拖不回来了
    const { workArea } = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
    const KEEP = 120; // 左右至少留这么宽在屏内
    const px = Math.min(Math.max(Math.round(x), workArea.x - width + KEEP), workArea.x + workArea.width - KEEP);
    const py = Math.min(Math.max(Math.round(y), workArea.y), workArea.y + workArea.height - KEEP);

    win.setBounds({ x: px, y: py, width, height });
    return win.getBounds();
  });

  ipcMain.handle('shell:reveal', async (_e, p) => {
    if (typeof p === 'string' && p) shell.showItemInFolder(p);
  });

  ipcMain.handle('shell:open', async (_e, p) => {
    if (typeof p === 'string' && p) {
      const err = await shell.openPath(p);
      return { error: err || null };
    }
  });

  ipcMain.handle('card:menu', async (_e, cardId) => {
    const card = config.cards.find((c) => c.id === cardId);
    if (!card) return;
    Menu.buildFromTemplate([
      { label: '选择文件夹…', click: () => pickDir(cardId) },
      {
        label: '重命名',
        click: () => {
          if (win && !win.isDestroyed()) win.webContents.send('card:edit-label', cardId, card.label);
        },
      },
      {
        label: '在资源管理器中打开',
        enabled: !!card.dir,
        click: () => card.dir && shell.openPath(card.dir),
      },
      { type: 'separator' },
      {
        label: '删除这张卡片',
        enabled: config.cards.length > MIN_CARDS,
        click: () => {
          const i = config.cards.findIndex((c) => c.id === cardId);
          if (i < 0 || config.cards.length <= MIN_CARDS) return;
          config.cards.splice(i, 1);
          scheduleSave();
          ensureWindowFits();
          broadcast();
        },
      },
    ]).popup({ window: win });
  });

  // -------------------------------------------------------------------------
  // 收集弹窗
  // -------------------------------------------------------------------------

  ipcMain.handle('collect:open', () => {
    openCollectWindow();
  });

  ipcMain.handle('collect:defaults', () => ({ ...config.collect }));

  ipcMain.handle('collect:pick', async (_e, kind) => {
    const isSrc = kind === 'src';
    const res = await dialog.showOpenDialog(collectWin && !collectWin.isDestroyed() ? collectWin : win, {
      title: isSrc ? '选择要收集的文件夹' : '选择收集到哪个文件夹',
      buttonLabel: '选择',
      properties: ['openDirectory', 'dontAddToRecent'],
      defaultPath: (isSrc ? null : config.collect.targetDir) || app.getPath('downloads'),
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    return { path: res.filePaths[0] };
  });

  // 拖进来一个路径：确认是文件夹，顺便数一下有多少文件给用户看
  ipcMain.handle('collect:inspect', async (_e, p) => {
    if (typeof p !== 'string' || !p || p.length > 4096) return { isDir: false, error: '路径无效' };
    try {
      const st = await fsp.stat(p);
      if (!st.isDirectory()) return { isDir: false, error: '这里要放文件夹，单个文件不行' };
      const real = await fsp.realpath(p);
      const { files, skipped, truncated } = await collector.scanFiles(real, { limit: 5000 });
      return {
        isDir: true,
        path: real,
        files: files.length,
        bytes: files.reduce((a, b) => a + (b.size || 0), 0),
        skipped: skipped.length,
        truncated,
      };
    } catch (e) {
      return { isDir: false, error: collector.describe(e).message };
    }
  });

  ipcMain.handle('collect:start', async (_e, opts) => {
    if (collectJob) return { error: 'BUSY', message: '正在收集中，请等这次结束' };
    if (!opts || typeof opts !== 'object') return { error: 'BAD_ARGS', message: '参数无效' };

    const job = { canceled: false };
    collectJob = job;

    try {
      const res = await collector.collect(opts, {
        shouldStop: () => job.canceled,
        onProgress: (p) => sendCollect('collect:progress', p),
      });
      config.collect = {
        targetDir: res.targetDir,
        prefix: opts.prefix !== false,
        move: opts.move === true,
      };
      scheduleSave();
      return res;
    } catch (e) {
      const d = collector.describe(e);
      return { error: d.code, message: d.message };
    } finally {
      collectJob = null;
    }
  });

  ipcMain.handle('collect:cancel', () => {
    if (!collectJob) return { ok: false };
    collectJob.canceled = true;
    return { ok: true };
  });

  ipcMain.handle('collect:remember', (_e, opts) => {
    if (!opts || typeof opts !== 'object') return;
    if (typeof opts.prefix === 'boolean') config.collect.prefix = opts.prefix;
    if (typeof opts.move === 'boolean') config.collect.move = opts.move;
    scheduleSave();
  });

  ipcMain.handle('collect:reveal', async (_e, p) => {
    if (typeof p === 'string' && p) await shell.openPath(p);
  });

  ipcMain.handle('collect:close', () => {
    if (collectWin && !collectWin.isDestroyed()) collectWin.close();
  });

  ipcMain.handle('move:to-card', async (_e, cardId, paths) => {
    const card = config.cards.find((c) => c.id === cardId);
    if (!card) return { error: 'CARD_NOT_FOUND', message: '卡片已不存在' };
    if (!card.dir) return { error: 'NO_DIR', message: '这张卡片还没设置目标文件夹' };
    if (!Array.isArray(paths) || paths.length === 0) {
      return { error: 'EMPTY', message: '没有可移动的文件' };
    }

    // 快照目标目录：任务执行期间用户改目录也不会影响本次
    const target = card.dir;
    const list = paths
      .filter((p) => typeof p === 'string' && p.length > 0 && p.length < 4096)
      .slice(0, 300);

    if (!list.length) return { error: 'EMPTY', message: '没有可移动的文件' };

    const run = async () => {
      const { results, summary } = await moveMany(list, target, cardId, (done, total, last) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('move:progress', { cardId, done, total, last });
        }
      });
      return { results, summary, target, cardId };
    };

    const p = jobChain.then(run, run);
    jobChain = p.catch(() => {});
    return p;
  });
}

async function pickDir(cardId) {
  const card = config.cards.find((c) => c.id === cardId);
  if (!card) return;
  const res = await dialog.showOpenDialog(win, {
    title: '选择要归位到的文件夹',
    properties: ['openDirectory', 'dontAddToRecent'],
    defaultPath: card.dir || app.getPath('downloads'),
  });
  if (res.canceled || !res.filePaths.length) return;
  card.dir = res.filePaths[0];
  scheduleSave();
  broadcast();
}

function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('state:changed', publicState());
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('local.filecards');
    config = loadConfig();
    registerIpc();
    createWindow();
    createTray();

    app.on('activate', () => {
      if (!win || win.isDestroyed()) createWindow();
      else {
        win.show();
        win.focus();
      }
    });
  });

  app.on('window-all-closed', () => {
    // 托盘常驻：不退出
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('will-quit', () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      const tmp = CONFIG_FILE + '.tmp';
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
      fs.renameSync(tmp, CONFIG_FILE);
    } catch {}
  });
}
