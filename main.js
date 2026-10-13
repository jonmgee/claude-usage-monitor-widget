const { app, BrowserWindow, ipcMain, screen, Notification, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { compute } = require('./usage');

app.setName('Claude Usage Widget');
if (process.platform === 'win32') app.setAppUserModelId('com.jongallop.claude-usage-widget');

const CFG = path.join(app.getPath('userData'), 'config.json');
// Budgets are gone: the percentages are now the real ones from the desktop app's
// own usage cache, so there is nothing left to calibrate.
const DEFAULTS = {
  refreshSec: 60,
  alwaysOnTop: true,
  docked: false, // snapped to the bottom-right corner; resizes re-snap while true
  skin: 'lcars', // lcars | dash | term | scribble
  caffeinate: 'off', // off | system (display may sleep) | display (keep both awake)
  heartbeatEnabled: false,
  heartbeatTimes: ['15:30'], // HH:MM local — each ping starts a window ending ~5h later
  lastHeartbeatAt: null,   // ms of last successful ping (for the countdown + display)
  lastAuthNotify: null,     // dayKey of the last 'signed out' notification
  lastExpiryNotify: null,  // dayKey of the last 'expiring soon' notification
  lastFires: {},           // { 'HH:MM': dayKey } set ONLY on success now
  pingFails: {},           // { 'HH:MM': {day, attempts} } retry tracker (max 3/day)
  lastPingError: null,     // { at: ms, error: str } most recent failure, for display
  heartbeats: [],          // ms timestamps of every ping (drives the ECG monitor)
  stepdownEnabled: false,
  stepdownTiers: [],       // [{pct: 50, model: 'opus'}, ...] highest crossed tier wins
  stepdownOriginal: null,  // settings.json "model" before we touched it (null = key absent)
  stepdownApplied: null,   // model we currently forced (null = not active)
};

// Locate the Claude Code CLI (the "stable launcher").
function findCli() {
  const home = os.homedir();
  const cands = process.platform === 'win32'
    ? [
        path.join(home, '.local', 'bin', 'claude.exe'),
        path.join(home, '.local', 'bin', 'claude.cmd'),
        path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm', 'claude.cmd'),
        path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'claude', 'claude.exe'),
      ]
    : [
        path.join(home, '.local', 'bin', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
      ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return null;
}
const CLI = findCli();

// --- CLI login expiry -------------------------------------------------------
// The CLI's OAuth refresh token lasts about 30 days; when it lapses every ping
// fails until the user signs in again. The expiry date is stored alongside the
// credentials, so read JUST that timestamp and warn before it bites.
//
// Only refreshTokenExpiresAt is kept. The tokens themselves are never stored,
// logged or sent anywhere. On macOS the credentials live in the login keychain;
// elsewhere they are a file. Any failure here is silent: no warning, no noise.
let loginExpiresAt = null;      // ms, or null if unknown
let loginCheckedAt = 0;
const LOGIN_CHECK_EVERY = 60 * 60 * 1000;   // hourly is plenty for a 30-day clock

function pickExpiry(raw) {
  try {
    const o = JSON.parse(raw);
    const v = (o.claudeAiOauth || o).refreshTokenExpiresAt;
    return typeof v === 'number' && v > 0 ? v : null;
  } catch { return null; }
}

function refreshLoginExpiry() {
  const now = Date.now();
  if (now - loginCheckedAt < LOGIN_CHECK_EVERY) return;
  loginCheckedAt = now;

  if (process.platform === 'darwin') {
    execFile('/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 5000 },
      (err, stdout) => { if (!err) loginExpiresAt = pickExpiry(stdout); });
    return;
  }
  fs.readFile(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8',
    (err, txt) => { if (!err) loginExpiresAt = pickExpiry(txt); });
}
refreshLoginExpiry();

function loadCfg() {
  let c;
  try { c = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CFG, 'utf8')) }; }
  catch { c = { ...DEFAULTS }; }
  // migrate old single-time config to the list form
  if (!Array.isArray(c.heartbeatTimes)) {
    c.heartbeatTimes = c.heartbeatTime ? [c.heartbeatTime] : ['15:30'];
  }
  if (!c.lastFires || typeof c.lastFires !== 'object') c.lastFires = {};
  if (!c.pingFails || typeof c.pingFails !== 'object') c.pingFails = {};
  return c;
}
function saveCfg(c) {
  try {
    fs.mkdirSync(path.dirname(CFG), { recursive: true });
    fs.writeFileSync(CFG, JSON.stringify(c, null, 2));
  } catch { /* ignore */ }
}

// Plan tier for the header pill, read straight from ~/.claude.json (no network).
function readPlan() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    const tier = (j && j.oauthAccount && j.oauthAccount.organizationRateLimitTier) || '';
    return /max_20x/.test(tier) ? 'Max (20x)'
      : /max_5x/.test(tier) ? 'Max (5x)'
      : /pro/.test(tier) ? 'Pro'
      : tier || 'Claude';
  } catch {
    return 'Claude';
  }
}

let win = null;
let cfg = loadCfg();
let timer = null;

function build() {
  return {
    ...compute({ heartbeatAt: cfg.lastHeartbeatAt }),
    plan: readPlan(),
    skin: cfg.skin || 'lcars',
    stepdown: {
      enabled: cfg.stepdownEnabled,
      tiers: cfg.stepdownTiers || [],
      applied: cfg.stepdownApplied,
      original: cfg.stepdownOriginal,
    },
    heartbeat: {
      enabled: cfg.heartbeatEnabled,
      times: cfg.heartbeatTimes || [],
      lastAt: cfg.lastHeartbeatAt,
      lastError: cfg.lastPingError,
      available: !!CLI,
      loginExpiresAt,
      history: cfg.heartbeats || [],
    },
  };
}
// Tell the user before the login dies, and when it has. Once a day at most:
// the card already carries the detail, this is just so it is not missed.
function maybeLoginNotify() {
  const now = new Date();
  const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const authFailed = cfg.lastPingError && /authenticat|oauth/i.test(cfg.lastPingError.error || '');

  if (authFailed) {
    if (cfg.lastAuthNotify === dayKey) return;
    cfg.lastAuthNotify = dayKey;
    saveCfg(cfg);
    notify('Claude usage widget', 'Auto-ping has stopped: the Claude CLI is signed out. Click Sign in on the widget to fix it.');
    return;
  }
  if (!loginExpiresAt) return;
  const days = Math.ceil((loginExpiresAt - Date.now()) / 86400000);
  if (days > 7) return;
  if (cfg.lastExpiryNotify === dayKey) return;
  cfg.lastExpiryNotify = dayKey;
  saveCfg(cfg);
  notify('Claude usage widget',
    days <= 0 ? 'The Claude CLI login has expired - auto-ping will fail until you sign in again.'
              : `The Claude CLI login expires in ${days} day${days === 1 ? '' : 's'}. Sign in again to keep auto-ping running.`);
}

function push() {
  refreshLoginExpiry();
  maybeLoginNotify();
  const u = build();
  if (win && !win.isDestroyed()) win.webContents.send('usage', u);
  maybeHeartbeat(u);
  maybeStepdown(u);
}

// The CLI reports real failures on STDOUT (e.g. an expired login) while stderr
// often carries only warnings, so read stdout first and drop known noise.
function pingError(stdout, stderr, err) {
  const noise = /no stdin data received/i;
  const out = String(stdout || '').trim();
  const errOut = String(stderr || '').trim();
  const pick = out || (noise.test(errOut) ? '' : errOut) || String(err && err.message || err);
  return pick.split('\n').filter((l) => !noise.test(l)).join(' ').trim().slice(0, 160);
}

// Fire a minimal, cheap CLI call to start a 5-hour window. Resolves {ok} / {ok:false,error}.
function fireHeartbeat() {
  return new Promise((resolve) => {
    if (!CLI) { resolve({ ok: false, error: 'Claude CLI not found' }); return; }
    const sep = process.platform === 'win32' ? ';' : ':';
    const extra = process.platform === 'win32'
      ? [path.join(os.homedir(), '.local', 'bin')]
      : [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
    const env = { ...process.env, HOME: os.homedir(),
      PATH: [...extra, process.env.PATH || ''].join(sep) };
    // .cmd/.bat shims can only be launched through a shell on Windows
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(CLI);
    execFile(CLI,
      ['-p', 'Reply with the single word: ok', '--model', 'haiku', '--no-session-persistence'],
      // stdin ignored: the CLI otherwise waits 3s for piped input on every ping
      // and writes a warning to stderr that masks the real error.
      { timeout: 90000, windowsHide: true, env, shell: needsShell, stdio: ['ignore', 'pipe', 'pipe'] },
      (err, stdout, stderr) => {
        if (err) {
          cfg.lastPingError = { at: Date.now(), error: pingError(stdout, stderr, err) };
          saveCfg(cfg);
          push();
          resolve({ ok: false, error: cfg.lastPingError.error });
          return;
        }
        const at = Date.now();
        cfg.lastPingError = null;
        cfg.lastHeartbeatAt = at;
        cfg.heartbeats = [...(cfg.heartbeats || []), at]
          .filter((t) => t > at - 14 * 24 * 60 * 60 * 1000) // keep 14 days
          .slice(-200);
        saveCfg(cfg);
        push();
        resolve({ ok: true });
      });
  });
}

// Scheduler: at each configured time, if no window is currently active, fire once.
function maybeHeartbeat(usage) {
  if (!cfg.heartbeatEnabled || !CLI) return;
  const times = Array.isArray(cfg.heartbeatTimes) ? cfg.heartbeatTimes : [];
  const now = new Date();
  const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  for (const t of times) {
    const [h, m] = String(t).split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) continue;
    if (cfg.lastFires[t] === dayKey) continue;          // this slot succeeded today
    const scheduled = new Date(now); scheduled.setHours(h, m, 0, 0);
    if (now < scheduled) continue;                       // not time yet
    if (now - scheduled > 60 * 60 * 1000) continue;      // missed by >1h — skip today
    if (usage.session.active) continue;                  // window already running; ping would be wasted
    const st = cfg.pingFails[t];
    const attempts = st && st.day === dayKey ? st.attempts : 0;
    if (attempts >= 3) continue;                         // gave up on this slot today
    // An expired CLI login needs the user to sign in again; retrying can't help.
    if (cfg.lastPingError && /authenticat|oauth/i.test(cfg.lastPingError.error || '')
        && attempts >= 1) continue;
    cfg.pingFails[t] = { day: dayKey, attempts: attempts + 1 }; // claim attempt before async fire
    saveCfg(cfg);
    fireHeartbeat().then((r) => {
      if (r.ok) {
        cfg.lastFires[t] = dayKey;   // lock the slot only on success
        delete cfg.pingFails[t];
        saveCfg(cfg);
      }
      // on failure the attempt count stands; next 60s tick retries (max 3)
    });
    return; // at most one ping per tick
  }
}

// --- auto step-down: swap Claude Code's default model as session usage climbs ---
// Writes the "model" key in ~/.claude/settings.json (read-merge-write, nothing else
// touched). Affects NEW sessions/conversations; a live conversation keeps its model
// until /model or restart. Restores the original automatically when usage falls
// back below every tier (i.e. the 5-hour window reset), on disable, and on quit.
const CC_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
function readCCModel() {
  try {
    const j = JSON.parse(fs.readFileSync(CC_SETTINGS, 'utf8'));
    return typeof j.model === 'string' ? j.model : null;
  } catch { return null; }
}
function writeCCModel(model) {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(CC_SETTINGS, 'utf8')); } catch { /* fresh file */ }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) j = {};
  if (model == null) delete j.model; else j.model = model;
  try {
    fs.mkdirSync(path.dirname(CC_SETTINGS), { recursive: true });
    fs.writeFileSync(CC_SETTINGS, JSON.stringify(j, null, 2));
    return true;
  } catch { return false; }
}
// Open a terminal sitting at the CLI's sign-in flow. The login has to happen in
// a real terminal (it prints a URL and waits for a code), but the user should
// not have to find one. Fixed command strings; nothing is interpolated.
function openSignIn() {
  if (process.platform === 'darwin') {
    execFile('/usr/bin/osascript', [
      '-e', 'tell application "Terminal" to do script "claude /login"',
      '-e', 'tell application "Terminal" to activate',
    ], { timeout: 10000 }, () => {});
    return { ok: true };
  }
  if (process.platform === 'win32') {
    execFile('cmd.exe', ['/c', 'start', '', 'cmd', '/k', 'claude', '/login'],
      { timeout: 10000, windowsHide: true }, () => {});
    return { ok: true };
  }
  return { ok: false, error: 'Open a terminal and run: claude /login' };
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch { /* ignore */ }
}
function applyStepdown(target) {
  if (cfg.stepdownApplied == null) cfg.stepdownOriginal = readCCModel();
  if (!writeCCModel(target)) return;
  const first = cfg.stepdownApplied == null;
  cfg.stepdownApplied = target;
  saveCfg(cfg);
  notify(
    'Claude step-down: ' + target.toUpperCase(),
    (first ? 'Usage crossed your tier. ' : 'Next tier crossed. ') +
    `New sessions now use ${target.toUpperCase()}. In an open session, type /model ${target} to switch it too.`
  );
}
function restoreStepdown() {
  if (cfg.stepdownApplied == null) return;
  writeCCModel(cfg.stepdownOriginal);
  cfg.stepdownApplied = null;
  cfg.stepdownOriginal = null;
  saveCfg(cfg);
  notify('Claude model restored', 'Session window reset - back to your usual model.');
}
function maybeStepdown(usage) {
  if (!cfg.stepdownEnabled) return;
  const pct = usage.session ? usage.session.pct : null;
  const tiers = (cfg.stepdownTiers || [])
    .filter((t) => t && t.pct > 0 && t.pct < 100 && t.model)
    .sort((a, b) => a.pct - b.pct);
  if (pct == null || !tiers.length) return;
  let target = null;
  for (const t of tiers) if (pct >= t.pct) target = t.model;
  if (target && cfg.stepdownApplied !== target) applyStepdown(target);
  else if (!target && cfg.stepdownApplied) restoreStepdown(); // window reset
}

// --- keep the machine awake so scheduled pings can fire (cross-platform) ---
// modes: off | system (display may sleep) | display (both awake)
//        | system-off (system awake + display slept right now; macOS only)
let blockerId = null;
function applyCaffeinate(sleepScreenNow = false) {
  if (blockerId !== null) {
    try { if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId); } catch { /* ignore */ }
    blockerId = null;
  }
  const mode = cfg.caffeinate || 'off';
  if (mode === 'off') return;
  try {
    blockerId = powerSaveBlocker.start(
      mode === 'display' ? 'prevent-display-sleep' : 'prevent-app-suspension'
    );
  } catch { blockerId = null; }
  // one-shot screen-off, only when the user just picked this mode --
  // not on app startup (they just launched the widget to look at it)
  if (mode === 'system-off' && sleepScreenNow && process.platform === 'darwin') {
    try { execFile('/usr/bin/pmset', ['displaysleepnow'], { timeout: 10000 }, () => {}); }
    catch { /* ignore */ }
  }
}

function startTimer() {
  clearInterval(timer);
  timer = setInterval(push, Math.max(15, cfg.refreshSec) * 1000);
}

function createWindow() {
  win = new BrowserWindow({
    width: 340,
    height: 312, // starting height; the renderer auto-fits it to content
    frame: false,
    transparent: true,
    resizable: false,
    fullscreenable: false,
    hasShadow: true,
    alwaysOnTop: cfg.alwaysOnTop,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  if (cfg.alwaysOnTop) win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    push();
    win.webContents.send('pin', cfg.alwaysOnTop);
    if (cfg.docked) snapToCorner();
  });
  // dragging the window by hand releases the dock anchor
  win.on('moved', () => {
    if (Date.now() - lastProgMove < 300) return; // ignore our own setBounds
    if (cfg.docked) { cfg.docked = false; saveCfg(cfg); }
  });
  startTimer();
}

app.whenReady().then(() => {
  // give the running app (Dock, cmd-tab) the LCARS icon on macOS
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(path.join(__dirname, 'icon.png')); } catch { /* ignore */ }
  }
  applyCaffeinate();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  if (blockerId !== null) {
    try { if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId); } catch { /* ignore */ }
  }
  restoreStepdown(); // never leave a silently downgraded model behind
});

ipcMain.handle('refresh', () => build());
ipcMain.handle('getConfig', () => cfg);
ipcMain.handle('setConfig', (_e, patch) => {
  cfg = { ...cfg, ...patch };
  saveCfg(cfg);
  if ('refreshSec' in patch) startTimer();
  if ('caffeinate' in patch) applyCaffeinate(true);
  if ('stepdownEnabled' in patch && !patch.stepdownEnabled) restoreStepdown();
  push();
  return cfg;
});
ipcMain.handle('signIn', () => openSignIn());
ipcMain.handle('restoreModel', () => { restoreStepdown(); push(); return { ok: true }; });
ipcMain.on('togglePin', () => {
  cfg.alwaysOnTop = !cfg.alwaysOnTop;
  saveCfg(cfg);
  if (win) win.setAlwaysOnTop(cfg.alwaysOnTop, 'floating');
  if (win) win.webContents.send('pin', cfg.alwaysOnTop);
});
let lastProgMove = 0;
function snapToCorner() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  lastProgMove = Date.now();
  win.setPosition(wa.x + wa.width - b.width - 16, wa.y + wa.height - b.height - 16);
}
ipcMain.on('dock', () => {
  cfg.docked = true;
  saveCfg(cfg);
  snapToCorner();
});
ipcMain.on('close', () => { if (win) win.close(); });
ipcMain.on('fitHeight', (_e, h) => {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const newH = Math.max(180, Math.min(wa.height - 16, Math.round(h)));
  lastProgMove = Date.now();
  if (cfg.docked) {
    // docked: grow/shrink anchored to the bottom-right corner
    win.setBounds({
      x: wa.x + wa.width - b.width - 16,
      y: wa.y + wa.height - newH - 16,
      width: b.width, height: newH,
    });
    return;
  }
  // free-floating: keep top edge, but shift up if the bottom would leave the screen
  let y = b.y;
  const maxY = wa.y + wa.height - 8 - newH;
  if (y > maxY) y = Math.max(wa.y + 8, maxY);
  win.setBounds({ x: b.x, y, width: b.width, height: newH });
});
ipcMain.handle('pingNow', async () => {
  const r = await fireHeartbeat();
  return r;
});
