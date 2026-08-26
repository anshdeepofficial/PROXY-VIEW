'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { toPublicError } = require('./security');

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || min));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeFilename(value, fallback = 'file') {
  const base = path.basename(String(value || fallback)).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (base || fallback).slice(0, 180);
}

function transferError(code, message, status = 400) {
  const error = new Error(message);
  error.status = status;
  error.publicCode = code;
  return error;
}

class BrowserSession {
  constructor({ id, owner, csrf, manager, proxyManager, proxy, viewport, dpr, idleMs, disconnectGraceMs, maxViewport, maxPages, maxTransferBytes }) {
    this.id = id;
    this.owner = owner;
    this.csrf = csrf;
    this.manager = manager;
    this.proxyManager = proxyManager;
    this.proxy = proxy;
    this.viewport = viewport;
    this.dpr = dpr;
    this.maxViewport = maxViewport;
    this.maxPages = maxPages;
    this.maxTransferBytes = maxTransferBytes;
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
    this.pendingFileChooser = null;
    this.uploadTransfer = null;
    this.regionRefreshTimer = null;
  }

  async init() {
    this.context = await this.manager.createContext({ proxy: this.proxy, viewport: this.viewport, deviceScaleFactor: this.dpr });
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
      if (frame === page.mainFrame() && page === this.page) {
        this.broadcastState();
        this.#scheduleEditableRegions(120);
      }
    });
    page.on('filechooser', (chooser) => this.#handleFileChooser(chooser).catch(() => {}));
    page.on('download', (download) => this.#handleDownload(download).catch((error) => {
      this.broadcastJson({ type: 'downloadError', message: error?.message || 'The remote download failed.' });
    }));
    page.on('close', () => {
      if (!this.closed && !this.replacingContext && this.page === page) this.broadcastJson({ type: 'error', code: 'PAGE_CLOSED', message: 'The remote page was closed.' });
    });
    page.on('crash', () => { if (!this.closed && !this.replacingContext && this.page === page) this.broadcastJson({ type: 'error', code: 'BROWSER_CRASH', message: 'The remote page crashed.' }); });
    await this.#startScreencast(page);
    await this.#trimPages();
    this.broadcastState();
    this.#scheduleEditableRegions(40);
    setTimeout(() => this.#broadcastEditableRegions().catch(() => {}), 650).unref?.();
    setTimeout(() => this.#broadcastEditableRegions().catch(() => {}), 1800).unref?.();
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
          if (ws.readyState === 1 && ws.bufferedAmount < 4_000_000) ws.send(frame, { binary: true });
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
      quality: 96,
      maxWidth: Math.round(this.viewport.width * this.dpr),
      maxHeight: Math.round(this.viewport.height * this.dpr),
      everyNthFrame: 1,
      maxFramesInFlight: 2,
      sendLastFrame: true
    });
  }

  async #handleFileChooser(chooser) {
    if (this.closed) return;
    this.touch();
    this.pendingFileChooser = chooser;
    this.uploadTransfer = null;
    const element = chooser.element();
    const [accept, multiple] = await Promise.all([
      element.getAttribute('accept').catch(() => ''),
      Promise.resolve(chooser.isMultiple()).catch(() => false)
    ]);
    this.broadcastJson({ type: 'fileChooser', accept: accept || '', multiple: Boolean(multiple) });
  }

  async #handleDownload(download) {
    this.touch();
    const id = crypto.randomBytes(12).toString('base64url');
    const filename = safeFilename(download.suggestedFilename(), 'download');
    this.broadcastJson({ type: 'downloadBegin', id, filename });

    const stream = await download.createReadStream();
    if (!stream) throw new Error('The remote website did not provide downloadable data.');

    let transferred = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      transferred += buffer.length;
      if (transferred > this.maxTransferBytes) {
        await download.cancel().catch(() => {});
        this.broadcastJson({
          type: 'downloadError',
          id,
          message: `This download is larger than the ${Math.round(this.maxTransferBytes / 1024 / 1024)} MB transfer limit.`
        });
        return;
      }

      await this.#waitForSocketCapacity();
      this.broadcastJson({ type: 'downloadChunk', id, data: buffer.toString('base64') });
    }

    const failure = await download.failure().catch(() => null);
    if (failure) {
      this.broadcastJson({ type: 'downloadError', id, message: 'The remote website download failed.' });
      return;
    }
    this.broadcastJson({ type: 'downloadEnd', id, filename, bytes: transferred });
  }

  async #waitForSocketCapacity() {
    const started = Date.now();
    while ([...this.wsClients].some((ws) => ws.readyState === 1 && ws.bufferedAmount > 4_000_000)) {
      if (Date.now() - started > 5000) break;
      await sleep(15);
    }
  }


  async #collectEditableRegions() {
    if (!this.page || this.page.isClosed()) return [];
    try {
      return await this.page.evaluate(() => {
        const blocked = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);
        const candidates = [...document.querySelectorAll('input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')];
        const regions = [];
        for (const el of candidates) {
          const tag = el.tagName.toLowerCase();
          const type = tag === 'input' ? String(el.getAttribute('type') || 'text').toLowerCase() : tag;
          const editable = tag === 'textarea' || el.isContentEditable || (tag === 'input' && !blocked.has(type));
          if (!editable || el.disabled || el.readOnly) continue;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4 || rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) continue;
          let inputMode = String(el.getAttribute('inputmode') || '').toLowerCase();
          if (!inputMode) {
            if (type === 'email') inputMode = 'email';
            else if (type === 'url') inputMode = 'url';
            else if (type === 'tel') inputMode = 'tel';
            else if (type === 'number') inputMode = 'decimal';
            else inputMode = 'text';
          }
          regions.push({
            x: Math.max(0, rect.left),
            y: Math.max(0, rect.top),
            width: rect.width,
            height: rect.height,
            inputMode,
            multiline: tag === 'textarea' || el.isContentEditable,
            type
          });
          if (regions.length >= 80) break;
        }
        return regions;
      });
    } catch {
      return [];
    }
  }

  async #broadcastEditableRegions(only = null) {
    if (this.closed) return;
    const regions = await this.#collectEditableRegions();
    this.broadcastJson({ type: 'editableRegions', regions }, only);
  }

  #scheduleEditableRegions(delay = 80) {
    clearTimeout(this.regionRefreshTimer);
    this.regionRefreshTimer = setTimeout(() => this.#broadcastEditableRegions().catch(() => {}), delay);
    this.regionRefreshTimer.unref?.();
  }

  async #broadcastFocusedEditable(only = null) {
    if (!this.page || this.page.isClosed()) return;
    const frames = this.page.frames();
    for (const frame of frames) {
      try {
        const info = await frame.evaluate(() => {
          const el = document.activeElement;
          if (!el) return null;
          const tag = String(el.tagName || '').toLowerCase();
          const type = tag === 'input' ? String(el.getAttribute('type') || 'text').toLowerCase() : tag;
          const blocked = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);
          const editable = tag === 'textarea' || el.isContentEditable || (tag === 'input' && !blocked.has(type));
          if (!editable || el.disabled || el.readOnly) return null;
          let inputMode = String(el.getAttribute('inputmode') || '').toLowerCase();
          if (!inputMode) {
            if (type === 'email') inputMode = 'email';
            else if (type === 'url') inputMode = 'url';
            else if (type === 'tel') inputMode = 'tel';
            else if (type === 'number') inputMode = 'decimal';
            else inputMode = 'text';
          }
          return { editable: true, inputMode, multiline: tag === 'textarea' || el.isContentEditable, type };
        });
        if (info?.editable) {
          this.broadcastJson({ type: 'focusState', ...info }, only);
          return;
        }
      } catch {}
    }
    this.broadcastJson({ type: 'focusState', editable: false }, only);
  }

  #scheduleFocusProbe(delay = 45) {
    const timer = setTimeout(() => this.#broadcastFocusedEditable().catch(() => {}), delay);
    timer.unref?.();
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
    this.#broadcastEditableRegions(ws).catch(() => {});
    this.#broadcastFocusedEditable(ws).catch(() => {});
    if (this.page && !this.page.isClosed()) {
      this.page.screenshot({ type: 'jpeg', quality: 96, scale: 'device' }).then((frame) => {
        if (ws.readyState === 1 && ws.bufferedAmount < 4_000_000) ws.send(frame, { binary: true });
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
      viewport: this.viewport,
      dpr: this.dpr
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
    this.pendingFileChooser = null;
    this.uploadTransfer = null;

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
      this.context = await this.manager.createContext({ proxy: this.proxy, viewport: this.viewport, deviceScaleFactor: this.dpr });
      const page = await this.context.newPage();
      await this.#activatePage(page);
      this.context.on('page', (newPage) => { if (newPage !== this.page) this.#activatePage(newPage).catch(() => {}); });
    } finally {
      this.replacingContext = false;
    }

    if (currentUrl && /^https?:/i.test(currentUrl)) await this.navigate(currentUrl);
    return this.proxyManager.describe(this.proxy);
  }

  async beginUpload(message) {
    this.touch();
    if (!this.pendingFileChooser) throw transferError('NO_FILE_CHOOSER', 'The website is not currently asking for a file.');
    const files = Array.isArray(message.files) ? message.files : [];
    if (!files.length || files.length > 8) throw transferError('BAD_UPLOAD', 'Select between 1 and 8 files.');
    if (!this.pendingFileChooser.isMultiple() && files.length > 1) throw transferError('BAD_UPLOAD', 'This field accepts only one file.');

    let declaredTotal = 0;
    const normalized = files.map((file) => {
      const size = Math.max(0, Number(file?.size) || 0);
      declaredTotal += size;
      return {
        name: safeFilename(file?.name, 'upload'),
        type: String(file?.type || 'application/octet-stream').slice(0, 120),
        size,
        received: 0,
        chunks: []
      };
    });
    if (declaredTotal > this.maxTransferBytes) {
      throw transferError('UPLOAD_TOO_LARGE', `Selected files exceed the ${Math.round(this.maxTransferBytes / 1024 / 1024)} MB transfer limit.`, 413);
    }

    this.uploadTransfer = { files: normalized, receivedTotal: 0 };
    this.broadcastJson({ type: 'uploadReady' });
  }

  async appendUploadChunk(message) {
    this.touch();
    const transfer = this.uploadTransfer;
    if (!transfer) throw transferError('NO_UPLOAD', 'No file upload is currently active.');
    const index = Number(message.index);
    const file = transfer.files[index];
    if (!file || typeof message.data !== 'string') throw transferError('BAD_UPLOAD_CHUNK', 'Invalid upload data.');
    if (message.data.length > 400_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data)) {
      throw transferError('BAD_UPLOAD_CHUNK', 'Invalid upload chunk.');
    }

    const chunk = Buffer.from(message.data, 'base64');
    file.received += chunk.length;
    transfer.receivedTotal += chunk.length;
    if (transfer.receivedTotal > this.maxTransferBytes || file.received > file.size) {
      this.uploadTransfer = null;
      throw transferError('UPLOAD_TOO_LARGE', 'The upload exceeded its declared size or transfer limit.', 413);
    }
    file.chunks.push(chunk);
  }

  async finishUpload() {
    this.touch();
    const transfer = this.uploadTransfer;
    const chooser = this.pendingFileChooser;
    if (!transfer || !chooser) throw transferError('NO_UPLOAD', 'No file upload is currently active.');

    for (const file of transfer.files) {
      if (file.received !== file.size) throw transferError('INCOMPLETE_UPLOAD', 'The selected file did not finish uploading.');
    }

    const payload = transfer.files.map((file) => ({
      name: file.name,
      mimeType: file.type,
      buffer: Buffer.concat(file.chunks, file.received)
    }));

    this.uploadTransfer = null;
    this.pendingFileChooser = null;
    try {
      await chooser.setFiles(payload);
    } catch (error) {
      const element = chooser.element();
      await element.setInputFiles(payload);
    }
    this.#scheduleEditableRegions(120);
    this.broadcastJson({ type: 'uploadComplete', files: payload.length });
  }

  async cancelUpload() {
    this.touch();
    this.uploadTransfer = null;
    this.pendingFileChooser = null;
    this.broadcastJson({ type: 'uploadCancelled' });
  }

  async handleInput(message) {
    if (!this.page || this.page.isClosed()) return;
    this.touch();
    switch (message.action) {
      case 'click':
        await this.page.mouse.click(Number(message.x), Number(message.y), { button: message.button || 'left' });
        this.#scheduleFocusProbe(35);
        this.#scheduleEditableRegions(100);
        break;
      case 'move':
        await this.page.mouse.move(Number(message.x), Number(message.y));
        break;
      case 'wheel':
        await this.page.mouse.wheel(Number(message.deltaX) || 0, Number(message.deltaY) || 0);
        this.#scheduleEditableRegions(90);
        break;
      case 'key':
        if (message.key) await this.page.keyboard.press(String(message.key));
        if (['Tab', 'Enter', 'Escape'].includes(String(message.key || ''))) this.#scheduleFocusProbe(35);
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
        this.#scheduleEditableRegions(80);
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
    clearTimeout(this.regionRefreshTimer);
    this.pendingFileChooser = null;
    this.uploadTransfer = null;
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
  constructor({ browserManager, proxyManager, maxSessions, idleMs, disconnectGraceMs, maxViewport, maxPages, maxDpr = 3, maxTransferBytes = 25 * 1024 * 1024 }) {
    this.browserManager = browserManager;
    this.proxyManager = proxyManager;
    this.maxSessions = maxSessions;
    this.idleMs = idleMs;
    this.disconnectGraceMs = disconnectGraceMs;
    this.maxViewport = maxViewport;
    this.maxPages = maxPages;
    this.maxDpr = maxDpr;
    this.maxTransferBytes = maxTransferBytes;
    this.sessions = new Map();
  }

  async create({ owner, csrf, viewport, dpr = 1 }) {
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
      dpr: clamp(dpr, 1, this.maxDpr),
      idleMs: this.idleMs,
      disconnectGraceMs: this.disconnectGraceMs,
      maxViewport: this.maxViewport,
      maxPages: this.maxPages,
      maxTransferBytes: this.maxTransferBytes
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
