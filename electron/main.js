'use strict';
/**
 * Slack Copilot for macOS.
 *
 * A menubar app that keeps the Slack Copilot server running in the background,
 * shows the existing web UI in a real window, and raises a macOS notification
 * when something urgent arrives.
 *
 * Deliberate choices:
 *   - The server runs as a *child process* of this app rather than being imported,
 *     so the app never has to understand (or be rebuilt for) the server's code.
 *   - The app starts itself at login via macOS's own "Open at Login", so there is
 *     one thing to install and one checkbox to turn it off.
 *   - Closing the window hides it; the app keeps working from the menubar.
 */
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  nativeImage,
  nativeTheme,
  powerMonitor,
  session,
  shell,
} = require('electron');
const path = require('node:path');

// Set before anything asks for a path, so settings and logs land in the same place
// whether the app is packaged or being run from source during development.
app.setName('Slack Copilot');

const { baseUrl, config, log, logDir, readJson, userDataFile, writeJson } = require('./env');
const { Supervisor } = require('./supervisor');
const { FeedWatcher } = require('./watcher');

// Icons live next to main.js in the built app (scripts/prepare-app.mjs copies them
// there); when running from source straight out of the repo they are one level up.
const ASSETS = require('node:fs').existsSync(path.join(__dirname, 'assets'))
  ? path.join(__dirname, 'assets')
  : path.join(__dirname, '..', 'assets');

const STARTING_PAGE = path.join(__dirname, 'starting.html');

/* ------------------------------------------------- command-line helpers ---- */
// Handled before anything else so the uninstaller works even while the app runs.

if (process.argv.includes('--unregister-login-item')) {
  app.whenReady().then(() => {
    app.setLoginItemSettings({ openAtLogin: false });
    setTimeout(() => app.exit(0), 400);
  });
} else if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  main();
}

function main() {
  let win = null;
  let tray = null;
  let quitting = false;
  let pageMode = 'local'; // 'local' = our Starting… page, 'server' = the real UI
  let pendingThreadId = null;
  let downSince = 0;

  const supervisor = new Supervisor();
  const watcher = new FeedWatcher();
  let counts = { urgent: 0, total: 0 };
  let feedReachable = false;
  /** Last GET /api/status answer — the server's own account of how Slack is doing. */
  let serverStatus = null;

  /* ------------------------------------------------------------- window --- */

  function savedBounds() {
    const b = readJson(userDataFile('window.json'));
    if (!b || !Number.isInteger(b.width) || !Number.isInteger(b.height)) return {};
    const out = { width: Math.max(640, b.width), height: Math.max(420, b.height) };
    if (Number.isInteger(b.x) && Number.isInteger(b.y)) {
      out.x = b.x;
      out.y = b.y;
    }
    return out;
  }

  function rememberBounds() {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    writeJson(userDataFile('window.json'), win.getNormalBounds());
  }

  /**
   * The colour the window paints before the page does. It has to match what the
   * page is about to paint or the window flashes the wrong colour on open — and
   * both pages follow the Mac's appearance setting now, so this does too.
   * (Same values as the `--bg` tokens in public/index.html / starting.html.)
   */
  function windowBackground() {
    return nativeTheme.shouldUseDarkColors ? '#16181d' : '#eef1f6';
  }

  function createWindow() {
    win = new BrowserWindow({
      title: 'Slack Copilot',
      width: 1180,
      height: 840,
      minWidth: 680,
      minHeight: 440,
      show: false,
      backgroundColor: windowBackground(),
      icon: path.join(ASSETS, 'icon.png'),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
      ...savedBounds(),
    });

    win.on('resize', rememberBounds);
    win.on('move', rememberBounds);

    // Closing the window does not quit — the app keeps watching from the menubar.
    win.on('close', (e) => {
      if (quitting) return;
      e.preventDefault();
      rememberBounds();
      win.hide();
    });

    // Anything that is not our own server opens in the user's normal browser
    // (this is how "Open in Slack" links behave).
    win.webContents.setWindowOpenHandler(({ url }) => {
      openExternally(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (url.startsWith(baseUrl()) || url.startsWith('file://')) return;
      e.preventDefault();
      openExternally(url);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3 /* aborted */) return;
      log(`page failed to load (${desc}); showing the waiting screen`);
      showLocalPage();
    });
    win.webContents.on('render-process-gone', () => {
      log('the window crashed; reloading it');
      showLocalPage();
      setTimeout(refreshPage, 1500);
    });

    showLocalPage();
  }

  function openExternally(url) {
    if (/^https?:\/\//i.test(url) || /^slack:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
  }

  function showWindow() {
    if (!win || win.isDestroyed()) createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    app.focus({ steal: true });
  }

  /* ------------------------------------------------- what the window shows -- */

  function showLocalPage() {
    if (!win || win.isDestroyed()) return;
    pageMode = 'local';
    const s = supervisor.status();
    const state =
      s.server === 'conflict' || s.server === 'misconfigured' ? s.server
        : s.server === 'up' ? 'starting'
        : s.server === 'down' ? 'down'
        : 'starting';
    // The page already carries the right words for 'conflict' and 'misconfigured';
    // only the "it keeps stopping" case needs extra detail spelled out.
    const msg = state === 'down' && s.problem ? `&msg=${encodeURIComponent(s.problem)}` : '';
    win.loadFile(STARTING_PAGE, { hash: `state=${state}${msg}` }).catch(() => {});
  }

  /**
   * The web UI reads '#/t/<id>' out of the address when it loads and opens that
   * thread, so a notification click just needs to load the right address.
   */
  function serverUrlFor(threadId) {
    return Number.isInteger(threadId) && threadId > 0
      ? `${baseUrl()}/#/t/${threadId}`
      : baseUrl();
  }

  function showServerPage(threadId) {
    if (!win || win.isDestroyed()) return;
    pageMode = 'server';
    const id = threadId != null ? threadId : pendingThreadId;
    pendingThreadId = null;
    win.loadURL(serverUrlFor(id)).catch(() => {});
  }

  function refreshPage() {
    if (supervisor.status().server !== 'up') {
      showLocalPage();
      return;
    }
    // Reload in place so a refresh keeps whichever thread is open.
    if (pageMode === 'server' && win && !win.isDestroyed()) {
      win.webContents.reload();
      return;
    }
    showServerPage();
  }

  /* ------------------------------------------------------ deep linking ----- */

  /**
   * Open the window on a particular thread. Nothing is clicked on the user's
   * behalf — the address alone tells the UI which thread to show. If the server
   * is not answering yet, the thread is remembered until it is.
   */
  function openThread(id) {
    showWindow();
    if (!Number.isInteger(id) || id <= 0) return;
    if (supervisor.status().server !== 'up') {
      pendingThreadId = id;
      return;
    }
    showServerPage(id);
  }

  /* --------------------------------------------------------------- tray ---- */

  function trayImage(name) {
    const img = nativeImage.createFromPath(path.join(ASSETS, `${name}.png`));
    img.setTemplateImage(true);
    return img;
  }

  let lastTrayShown = null;

  /**
   * Both mouse buttons open the same menu.
   *
   * It used to be: left-click opens the window, right-click shows the status menu. Nobody
   * who has not been told about the right-click will ever find it — so when something was
   * wrong, all the app offered was an odd-looking icon and no way to ask why. Everything
   * that matters is now one ordinary click away, and "Open Slack Copilot" is the first item
   * in the menu, so the old habit still lands on the window in one more click.
   */
  function createTray() {
    tray = new Tray(trayImage('tray-startingTemplate'));
    tray.setIgnoreDoubleClickEvents(true);
    tray.on('click', () => tray.popUpContextMenu(buildTrayMenu()));
    tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
    updateTray();
  }

  /**
   * One sentence about Slack, from what the server itself reports (GET /api/status).
   * Returns null when there is no answer to go on, so the caller falls back to what it
   * could infer from the server's log.
   */
  function slackLineFromServer() {
    const list =
      serverStatus && Array.isArray(serverStatus.workspaces) ? serverStatus.workspaces : null;
    if (!list) return null;
    // registered:false means the server genuinely does not know yet — never treat that as
    // either good or bad news.
    const known = list.filter((w) => w && w.registered && w.state);
    if (known.length === 0) return null;
    const names = (l) => l.map((w) => w.teamName || w.key).join(' and ');
    const failing = known.filter((w) => w.state === 'error');
    if (failing.length) return `Can't sign in to ${names(failing)}`;
    const waiting = known.filter((w) => w.state === 'reconnecting');
    if (waiting.length) return `Disconnected from ${names(waiting)} — retrying`;
    const starting = known.filter((w) => w.state === 'connecting');
    if (starting.length) return `Connecting to ${names(starting)}…`;
    return `Connected to ${names(known)}`;
  }

  /** True only when every workspace the server knows about is connected. */
  function slackHealthyFromServer() {
    const list =
      serverStatus && Array.isArray(serverStatus.workspaces) ? serverStatus.workspaces : null;
    if (!list) return null;
    const known = list.filter((w) => w && w.registered && w.state);
    if (known.length === 0) return null;
    return known.every((w) => w.state === 'connected');
  }

  /** One short sentence a non-technical person can act on. */
  function healthLine() {
    const s = supervisor.status();
    switch (s.server) {
      case 'misconfigured':
        return s.problem || "Slack Copilot can't find its files";
      case 'conflict':
        return 'Something else is using the connection this app needs';
      case 'starting':
        return 'Starting up…';
      case 'down':
        return s.problem || 'Not running — retrying…';
      default:
        break;
    }
    // First-hand beats inferred: this works even when we attached to a server we did not
    // start, whose log we cannot read at all.
    const fromServer = slackLineFromServer();
    if (fromServer) return fromServer;
    switch (s.slack) {
      case 'not-configured':
        return 'Running — Slack is not set up yet';
      case 'error':
        return "Running — can't sign in to Slack";
      case 'reconnecting':
        return 'Disconnected from Slack — retrying';
      case 'connected':
        return s.slackTeams.length
          ? `Connected to ${s.slackTeams.join(' and ')}`
          : 'Connected to Slack';
      default:
        return feedReachable ? 'Running' : 'Running — checking…';
    }
  }

  function healthy() {
    const s = supervisor.status();
    if (s.server !== 'up') return false;
    const fromServer = slackHealthyFromServer();
    if (fromServer !== null) return fromServer;
    return s.slack !== 'reconnecting' && s.slack !== 'error' && s.slack !== 'not-configured';
  }

  function updateTray() {
    if (!tray) return;
    const s = supervisor.status();
    const icon =
      s.server === 'starting' ? 'tray-startingTemplate' : healthy() ? 'trayTemplate' : 'tray-offTemplate';
    tray.setImage(trayImage(icon));

    // The title next to the icon is the at-a-glance signal: a number when things
    // need you, an exclamation mark when the app itself needs you.
    let title = '';
    if (!healthy() && s.server !== 'starting') title = ' !';
    else if (counts.urgent > 0) title = ` ${counts.urgent}`;
    tray.setTitle(title, { fontType: 'monospacedDigit' });

    tray.setToolTip(`Slack Copilot — ${healthLine()}\nClick for how things are going, and to open it`);

    if (app.dock) app.dock.setBadge(counts.urgent > 0 ? String(counts.urgent) : '');

    const shown = `${icon}|${title}|${healthLine()}`;
    if (shown !== lastTrayShown) {
      lastTrayShown = shown;
      log(`menubar: ${icon.replace('Template', '')} icon, label "${title.trim()}" — ${healthLine()}`);
    }
  }

  function urgentLine() {
    if (supervisor.status().server !== 'up') return 'Waiting for the app to start…';
    if (counts.urgent === 0) return 'Nothing urgent right now';
    return counts.urgent === 1 ? '1 urgent message waiting' : `${counts.urgent} urgent messages waiting`;
  }

  function buildTrayMenu() {
    const s = supervisor.status();
    // "Open Slack Copilot" is deliberately first: it is what almost every click is for, it
    // is the item under the cursor when the menu appears, and it means a left-click still
    // reaches the window without the user having to read anything. The two status lines sit
    // directly under it so the answer to "is this thing working?" is never hidden.
    const status = [
      { label: healthLine(), enabled: false },
      { label: urgentLine(), enabled: false },
    ];
    if (s.owner === 'external') {
      status.push({ label: 'Using the copy already running on this Mac', enabled: false });
    }
    const items = [
      { label: 'Open Slack Copilot', click: () => showWindow() },
      { type: 'separator' },
      ...status,
      { type: 'separator' },
      {
        label: 'Start automatically when I log in',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => setLoginItem(item.checked),
      },
      {
        label: 'Restart Slack Copilot',
        enabled: s.owner !== 'external',
        click: () => {
          supervisor.restart();
          watcher.forgetToken();
          showLocalPage();
        },
      },
      { label: 'Show the activity log', click: () => shell.openPath(logDir()) },
      { type: 'separator' },
      { label: 'Quit Slack Copilot', accelerator: 'Command+Q', click: () => app.quit() },
    ];
    return Menu.buildFromTemplate(items);
  }

  /**
   * Lets someone check, in one click, that macOS is actually allowed to show
   * notifications from this app — the setting lives in System Settings, not here,
   * and a silent "off" would be invisible otherwise.
   */
  function testNotification() {
    if (!Notification.isSupported()) {
      log('this Mac cannot show notifications');
      return;
    }
    const n = new Notification({
      title: 'Slack Copilot notifications are working',
      subtitle: 'Test message',
      body: 'This is what an urgent Slack message will look like. Click it to open Slack Copilot.',
    });
    n.on('show', () => log('test notification: shown by macOS'));
    n.on('failed', (_e, err) => log('test notification failed:', String(err)));
    n.on('click', () => showWindow());
    n.show();
    log('test notification: sent');
  }

  /* --------------------------------------------------------- login item ---- */

  function buildStamp() {
    const info = readJson(path.join(__dirname, 'project-path.json'));
    return (info && info.generatedAt) || 'unknown';
  }

  function setLoginItem(enabled) {
    if (!app.isPackaged) {
      // Running from source: registering would point macOS at the development
      // Electron binary, not the installed app. Never do that.
      log(`start at login: ignored (running from source), requested ${enabled}`);
      return;
    }
    try {
      app.setLoginItemSettings({ openAtLogin: enabled });
      const readback = app.getLoginItemSettings().openAtLogin;
      log(`start at login: requested ${enabled}, now ${readback}`);
      writeJson(userDataFile('login-item.json'), {
        chosen: enabled,
        build: buildStamp(),
        at: new Date().toISOString(),
      });
    } catch (err) {
      log('could not change the start-at-login setting:', String(err && err.message));
    }
  }

  /**
   * Turn "open at login" on the first time, and put it back after a reinstall —
   * macOS drops the registration when the app bundle is replaced. A deliberate
   * change made in System Settings is respected, because that arrives without a
   * new build behind it.
   */
  function reconcileLoginItem() {
    const build = buildStamp();
    const saved = readJson(userDataFile('login-item.json'));
    const have = app.getLoginItemSettings().openAtLogin;
    log(`start at login is currently ${have ? 'on' : 'off'}`);

    if (!saved) {
      setLoginItem(true);
      return;
    }
    if (saved.build !== build) {
      if (saved.chosen && !have) {
        log('the app was reinstalled and macOS dropped the setting — putting it back');
        setLoginItem(true);
        return;
      }
      writeJson(userDataFile('login-item.json'), { ...saved, build });
    }
  }

  /* ---------------------------------------------------------- app menu ----- */

  function buildAppMenu() {
    return Menu.buildFromTemplate([
      {
        label: 'Slack Copilot',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: 'Send a test notification', click: () => testNotification() },
          { label: 'Show the activity log', click: () => shell.openPath(logDir()) },
          {
            label: 'Restart Slack Copilot',
            click: () => {
              supervisor.restart();
              watcher.forgetToken();
              showLocalPage();
            },
          },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { type: 'separator' },
          { label: 'Quit Slack Copilot', accelerator: 'Command+Q', click: () => app.quit() },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { label: 'Refresh', accelerator: 'Command+R', click: () => refreshPage() },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }, { role: 'front' }] },
    ]);
  }

  /* ------------------------------------------------------------- wiring ---- */

  app.whenReady().then(() => {
    const cfg = config();
    log(`--- Slack Copilot starting (packaged: ${app.isPackaged}) ---`);
    log(`project folder: ${cfg.projectDir || 'NOT FOUND'}`);
    log(`window address: ${baseUrl()}`);

    // The page is served from our own machine, but it renders text written by other
    // people in Slack — so it gets no privileges of any kind.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false),
    );

    app.setAboutPanelOptions({
      applicationName: 'Slack Copilot',
      applicationVersion: app.getVersion(),
      credits: 'Your Slack messages, sorted by what matters.',
    });

    Menu.setApplicationMenu(buildAppMenu());
    createWindow();
    createTray();
    reconcileLoginItem();

    // macOS flips appearance on its own at sunset for anyone on "Auto", so an
    // already-open window has to keep up. The pages re-paint themselves from
    // CSS; only the window's own backdrop needs telling.
    nativeTheme.on('updated', () => {
      if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground());
    });

    supervisor.on('status', (s) => {
      updateTray();
      if (s.server === 'up') {
        downSince = 0;
        if (pageMode !== 'server') showServerPage();
      } else {
        if (!downSince) downSince = Date.now();
        // Don't flap the window on a blip; only fall back after it really is gone.
        if (pageMode === 'server' && Date.now() - downSince > 15_000) showLocalPage();
      }
      if (pageMode === 'local' && win && !win.isDestroyed()) {
        showLocalPage(); // refresh the wording on the waiting screen
      }
    });

    watcher.on('counts', (c) => {
      counts = c;
      updateTray();
    });
    watcher.on('status', (s) => {
      serverStatus = s;
      updateTray();
    });
    watcher.on('ok', () => {
      if (!feedReachable) {
        feedReachable = true;
        updateTray();
      }
    });
    watcher.on('error', (err) => {
      // Stale news is worse than none: if we cannot reach the server we cannot claim
      // anything about Slack either.
      serverStatus = null;
      if (feedReachable) {
        feedReachable = false;
        updateTray();
      }
      log('could not read the feed:', String(err && err.message));
    });
    watcher.on('open-thread', (id) => (id === null ? showWindow() : openThread(id)));

    supervisor.start();
    watcher.start();

    // A laptop lid closing should be a non-event: pause while asleep, re-check on wake.
    powerMonitor.on('suspend', () => {
      log('Mac going to sleep');
      supervisor.pause();
      watcher.pause();
    });
    powerMonitor.on('resume', () => {
      log('Mac woke up — rechecking');
      supervisor.resume();
      watcher.resume();
      setTimeout(() => {
        if (supervisor.status().server === 'up' && pageMode === 'server') {
          win && !win.isDestroyed() && win.webContents.reload();
        }
      }, 4000);
    });

    if (!app.getLoginItemSettings().wasOpenedAtLogin) showWindow();

    // Support-only: `Slack Copilot --test-notification` proves the notification
    // path end-to-end without waiting for a real urgent message.
    if (process.argv.includes('--test-notification')) setTimeout(testNotification, 2500);
  });

  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());
  app.on('window-all-closed', () => {
    /* stay alive in the menubar */
  });

  let shuttingDown = false;
  app.on('before-quit', (e) => {
    quitting = true;
    if (shuttingDown) return;
    shuttingDown = true;
    e.preventDefault();
    log('quitting');
    watcher.stop();
    supervisor.stop().finally(() => app.exit(0));
  });

  if (!Notification.isSupported()) {
    log('this Mac does not support notifications');
  }
}
