'use strict';

const crypto = require('node:crypto');
const { toPublicError } = require('./security');

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || min));

class BrowserSession {
  constructor({ id, owner, csrf, manager, proxyManager, proxy, viewport, idleMs, disconnectGraceMs, maxViewport, maxPages }) {
    this.id = id;
    this.owner = owner;
    this.csrf = csrf;
    this.manager = manager;
    this.proxyManager = proxyManager;
    this.proxy = proxy;
    this.viewport = viewport;
    this.maxViewport = maxViewport;
    this.maxPages = maxPages;
    this.idleMs = idleMs;
    this.disconnectGraceMs = disconnectGraceMs;
    this.context = null;
    this.page = null;
    this.cdp = null;
    this.wsClients = new Set();
    this.closed = false;
    this.lastActivity = Date.now();
    this.disconnectTimer = null;
    this.idleTimer = null;
    this.replacingContext = false;
  }

  async init() {
    this.context = await this.manager.createContext({ proxy: this.proxy, viewport: this.viewport });
    const page = await this.context.newPage();
    await this.#activatePage(page);
    this.context.on('page', (newPage) => { if (newPage !== this.page) this.#activatePage(newPage).catch(() => {}); });
    this.#armIdleTimer();
  }

  async #activatePage(page) {
    if (this.closed) return;
    this.page = page;
    page.setDefaultNavigationTimeout(this.manager.navigationTimeoutMs);
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && page === this.page) this.broadcastState();
    });
    page.on('close', () => {
      if (!this.closed && !this.replacingContext && this.page === page) this.broadcastJson({ type: 'error', code: 'PAGE_CLOSED', message: 'The remote page was closed.' });
    });
    page.on('crash', () => { if (!this.closed && !this.replacingContext && this.page === page) this.broadcastJson({ type: 'error', code: 'BROWSER_CRASH', message: 'The remote page crashed.' }); });
    await this.#startScreencast(page);
    await this.#trimPages();
    this.broadcastState();
  }

  async #trimPages() {
    if (!this.context) return;
    const pages = this.context.pages();
    if (pages.length <= this.maxPages) return;
    const removable = pages.filter((candidate) => candidate !== this.page).slice(0, pages.length - this.maxPages);
    await Promise.allSettled(removable.map((candidate) => candidate.close()));
  }

  async #startScreencast(page) {
    if (this.cdp) {
      try { await this.cdp.send('Page.stopScreencast'); } catch {}
      try { await this.cdp.detach(); } catch {}
    }
    this.cdp = await this.context.newCDPSession(page);
    this.cdp.on('Page.screencastFrame', async ({ data, sessionId, metadata }) => {
      try {
        const frame = Buffer.from(data, 'base64');
        for (const ws of this.wsClients) {
          if (ws.readyState === 1 && ws.bufferedAmount < 2_000_000) ws.send(frame, { binary: true });
        }
        if (metadata?.deviceWidth && metadata?.deviceHeight) {
          this.lastFrameSize = { width: metadata.deviceWidth, height: metadata.deviceHeight };
        }
      } finally {
        try { await this.cdp.send('Page.screencastFrameAck', { sessionId }); } catch {}
      }
    });
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 68,
      maxWidth: this.viewport.width,
      maxHeight: this.viewport.height,
      everyNthFrame: 1
    });
  }

  touch() {
    this.lastActivity = Date.now();
    this.#armIdleTimer();
  }

  #armIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.destroy('idle').catch(() => {}), this.idleMs);
    this.idleTimer.unref?.();
  }

  addClient(ws) {
    clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
    this.wsClients.add(ws);
    this.touch();
    this.broadcastState(ws);
    if (this.page && !this.page.isClosed()) {
      this.page.screenshot({ type: 'jpeg', quality: 68 }).then((frame) => {
        if (ws.readyState === 1 && ws.bufferedAmount < 2_000_000) ws.send(frame, { binary: true });
      }).catch(() => {});
    }
  }

  removeClient(ws) {
    this.wsClients.delete(ws);
    if (this.wsClients.size === 0 && !this.closed) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = setTimeout(() => this.destroy('disconnected').catch(() => {}), this.disconnectGraceMs);
      this.disconnectTimer.unref?.();
    }
  }

  broadcastJson(payload, only = null) {
    const text = JSON.stringify(payload);
    const targets = only ? [only] : this.wsClients;
    for (const ws of targets) if (ws.readyState === 1) ws.send(text);
  }

  broadcastState(only = null) {
    const state = {
      type: 'state',
      url: this.page && !this.page.isClosed() ? this.page.url() : '',
      title: '',
      proxy: this.proxyManager.describe(this.proxy),
      viewport: this.viewport
    };
    this.broadcastJson(state, only);
    if (this.page && !this.page.isClosed()) {
      this.page.title().then((title) => this.broadcastJson({ type: 'title', title }, only)).catch(() => {});
    }
  }

  async navigate(url) {
    this.touch();
    this.broadcastJson({ type: 'loading', message: 'Loading website…' });
    try {
      const result = await this.manager.navigate(this.page, url);
      this.broadcastState();
      return result;
    } catch (error) {
      const view = error.publicView || toPublicError(error);
      this.broadcastJson({ type: 'error', ...view });
      throw error;
    }
  }

  async back() {
    this.touch();
    await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: this.manager.navigationTimeoutMs }).catch(() => null);
    this.broadcastState();
  }

  async forward() {
    this.touch();
    await this.page.goForward({ waitUntil: 'domcontentloaded', timeout: this.manager.navigationTimeoutMs }).catch(() => null);
    this.broadcastState();
  }

  async reload() {
    this.touch();
    this.broadcastJson({ type: 'loading', message: 'Reloading…' });
    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: this.manager.navigationTimeoutMs });
    this.broadcastState();
  }

  async newIdentity() {
    this.touch();
    const currentUrl = this.page && !this.page.isClosed() ? this.page.url() : '';
    this.broadcastJson({ type: 'identity', message: 'Creating new private session…' });
    this.replacingContext = true;

    try {
      if (this.cdp) {
        try { await this.cdp.send('Page.stopScreencast'); } catch {}
        try { await this.cdp.detach(); } catch {}
        this.cdp = null;
      }
      if (this.context) await this.context.close().catch(() => {});
      this.context = null;
      this.page = null;

      this.proxy = this.proxyManager.next();
      this.broadcastJson({ type: 'identity', message: this.proxy ? 'Connecting through new proxy…' : 'Creating fresh direct session…' });
      this.context = await this.manager.createContext({ proxy: this.proxy, viewport: this.viewport });
      const page = await this.context.newPage();
      await this.#activatePage(page);
      this.context.on('page', (newPage) => { if (newPage !== this.page) this.#activatePage(newPage).catch(() => {}); });
    } finally {
      this.replacingContext = false;
    }

    if (currentUrl && /^https?:/i.test(currentUrl)) await this.navigate(currentUrl);
    return this.proxyManager.describe(this.proxy);
  }

  async handleInput(message) {
    if (!this.page || this.page.isClosed()) return;
    this.touch();
    switch (message.action) {
      case 'click':
        await this.page.mouse.click(Number(message.x), Number(message.y), { button: message.button || 'left' });
        break;
      case 'move':
        await this.page.mouse.move(Number(message.x), Number(message.y));
        break;
      case 'wheel':
        await this.page.mouse.wheel(Number(message.deltaX) || 0, Number(message.deltaY) || 0);
        break;
      case 'key':
        if (message.key) await this.page.keyboard.press(String(message.key));
        break;
      case 'text':
        if (typeof message.text === 'string') await this.page.keyboard.insertText(message.text.slice(0, 4000));
        break;
      case 'resize': {
        const width = clamp(message.width, 320, this.maxViewport.width);
        const height = clamp(message.height, 360, this.maxViewport.height);
        this.viewport = { width, height };
        await this.page.setViewportSize(this.viewport);
        await this.#startScreencast(this.page);
        this.broadcastState();
        break;
      }
      default:
        break;
    }
  }

  async destroy(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.disconnectTimer);
    this.broadcastJson({ type: 'expired', reason, message: 'Browser session ended and temporary state was cleared.' });
    if (this.cdp) {
      try { await this.cdp.send('Page.stopScreencast'); } catch {}
      try { await this.cdp.detach(); } catch {}
      this.cdp = null;
    }
    if (this.context) await this.context.close().catch(() => {});
    this.context = null;
    this.page = null;
    for (const ws of this.wsClients) {
      try { ws.close(1000, 'session-ended'); } catch {}
    }
    this.wsClients.clear();
  }
}

class SessionManager {
  constructor({ browserManager, proxyManager, maxSessions, idleMs, disconnectGraceMs, maxViewport, maxPages }) {
    this.browserManager = browserManager;
    this.proxyManager = proxyManager;
    this.maxSessions = maxSessions;
    this.idleMs = idleMs;
    this.disconnectGraceMs = disconnectGraceMs;
    this.maxViewport = maxViewport;
    this.maxPages = maxPages;
    this.sessions = new Map();
  }

  async create({ owner, csrf, viewport }) {
    this.#purgeClosed();
    if (this.sessions.size >= this.maxSessions) {
      const error = new Error('The server has reached its active-session limit.');
      error.status = 503;
      error.publicCode = 'SESSION_LIMIT';
      throw error;
    }
    const id = crypto.randomBytes(24).toString('base64url');
    const proxy = this.proxyManager.next();
    const session = new BrowserSession({
      id,
      owner,
      csrf,
      manager: this.browserManager,
      proxyManager: this.proxyManager,
      proxy,
      viewport,
      idleMs: this.idleMs,
      disconnectGraceMs: this.disconnectGraceMs,
      maxViewport: this.maxViewport,
      maxPages: this.maxPages
    });
    await session.init();
    this.sessions.set(id, session);
    return session;
  }

  get(id, owner) {
    const session = this.sessions.get(id);
    if (!session || session.closed || session.owner !== owner) return null;
    return session;
  }

  async destroy(id, owner, reason = 'closed') {
    const session = this.get(id, owner);
    if (!session) return false;
    await session.destroy(reason);
    this.sessions.delete(id);
    return true;
  }

  async closeAll() {
    await Promise.allSettled([...this.sessions.values()].map((session) => session.destroy('server-shutdown')));
    this.sessions.clear();
  }

  #purgeClosed() {
    for (const [id, session] of this.sessions) if (session.closed) this.sessions.delete(id);
  }
}

module.exports = { SessionManager };
