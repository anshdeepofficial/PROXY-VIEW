'use strict';

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { BrowserManager } = require('./browserManager');
const { ProxyManager } = require('./proxyManager');
const { SessionManager } = require('./sessionManager');
const { toPublicError } = require('./security');

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || min));

function createRuntime(env = process.env) {
  const navigationTimeoutMs = Number(env.NAVIGATION_TIMEOUT_MS || 30000);
  const maxViewport = {
    width: Number(env.MAX_VIEWPORT_WIDTH || 1920),
    height: Number(env.MAX_VIEWPORT_HEIGHT || 1080)
  };
  const maxDpr = clamp(env.MAX_STREAM_DPR || 2, 1, 2.5);
  const maxTransferBytes = Math.max(1_048_576, Number(env.MAX_TRANSFER_BYTES || 25 * 1024 * 1024));

  const browserManager = new BrowserManager({ navigationTimeoutMs });
  const proxyManager = new ProxyManager(env);
  const sessions = new SessionManager({
    browserManager,
    proxyManager,
    maxSessions: Number(env.MAX_SESSIONS || (env.VERCEL ? 2 : 10)),
    idleMs: Number(env.SESSION_TIMEOUT_MINUTES || 20) * 60_000,
    disconnectGraceMs: 0,
    maxViewport,
    maxPages: Number(env.MAX_PAGES_PER_SESSION || 4),
    maxDpr,
    maxTransferBytes
  });

  return { browserManager, proxyManager, sessions, maxViewport, maxDpr };
}

function isAllowedBrowserOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const host = forwardedHost || req.headers.host;
    return Boolean(host) && originUrl.host === host;
  } catch {
    return false;
  }
}

function attachBrowserWebSocket(server, options = {}) {
  const runtime = options.runtime || createRuntime(options.env || process.env);
  const maxPayload = 512 * 1024;
  const wss = new WebSocketServer({ server, maxPayload, perMessageDeflate: false });

  wss.on('connection', (ws, req) => {
    if (!isAllowedBrowserOrigin(req)) {
      ws.close(1008, 'origin-not-allowed');
      return;
    }

    let session = null;
    let initInProgress = false;
    let closed = false;

    const initTimer = setTimeout(() => {
      if (!session && ws.readyState === 1) ws.close(1008, 'initialization-required');
    }, 10_000);
    initTimer.unref?.();

    const sendJson = (payload) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(payload));
    };

    const destroySession = async (reason) => {
      if (!session) return;
      const current = session;
      session = null;
      await runtime.sessions.destroy(current.id, current.owner, reason).catch(() => {});
    };

    ws.on('message', async (data, isBinary) => {
      if (isBinary || data.length > maxPayload) return;

      let message;
      try { message = JSON.parse(data.toString('utf8')); } catch { return; }

      try {
        if (!session) {
          if (message.type !== 'init' || initInProgress) return;
          initInProgress = true;
          const width = clamp(message.width, 320, runtime.maxViewport.width);
          const height = clamp(message.height, 360, runtime.maxViewport.height);
          const dpr = clamp(message.dpr || 1, 1, runtime.maxDpr);
          const owner = crypto.randomBytes(24).toString('base64url');
          const csrf = crypto.randomBytes(24).toString('base64url');

          session = await runtime.sessions.create({ owner, csrf, viewport: { width, height }, dpr });
          clearTimeout(initTimer);
          session.addClient(ws);
          sendJson({
            type: 'ready',
            sessionId: session.id,
            proxy: runtime.proxyManager.describe(session.proxy),
            timeoutMinutes: Number(process.env.SESSION_TIMEOUT_MINUTES || 20),
            dpr: session.dpr
          });
          initInProgress = false;
          return;
        }

        if (message.type === 'navigate') {
          await session.navigate(message.url);
          return;
        }

        if (message.type === 'browser') {
          if (message.action === 'back') await session.back();
          else if (message.action === 'forward') await session.forward();
          else if (message.action === 'reload') await session.reload();
          else if (message.action === 'newIdentity') await session.newIdentity();
          else sendJson({ type: 'error', code: 'BAD_ACTION', message: 'Unknown browser action.' });
          return;
        }

        if (message.type === 'input') {
          await session.handleInput(message);
          return;
        }

        if (message.type === 'uploadStart') {
          await session.beginUpload(message);
          return;
        }

        if (message.type === 'uploadChunk') {
          await session.appendUploadChunk(message);
          return;
        }

        if (message.type === 'uploadEnd') {
          await session.finishUpload();
          return;
        }

        if (message.type === 'uploadCancel') {
          await session.cancelUpload();
          return;
        }

        if (message.type === 'end') {
          await destroySession('user-ended');
          if (ws.readyState === 1) ws.close(1000, 'session-ended');
        }
      } catch (error) {
        const failedDuringInit = initInProgress && !session;
        initInProgress = false;
        sendJson({ type: 'error', ...toPublicError(error) });
        if (failedDuringInit && ws.readyState === 1) ws.close(1011, 'browser-initialization-failed');
      }
    });

    ws.on('close', async () => {
      if (closed) return;
      closed = true;
      clearTimeout(initTimer);
      await destroySession('disconnected');
    });

    ws.on('error', () => {});
  });

  return {
    ...runtime,
    wss,
    async close() {
      for (const client of wss.clients) {
        try { client.close(1001, 'server-shutdown'); } catch {}
      }
      await runtime.sessions.closeAll();
      await runtime.browserManager.close();
      try { wss.close(); } catch {}
    }
  };
}

module.exports = { createRuntime, attachBrowserWebSocket, isAllowedBrowserOrigin };
