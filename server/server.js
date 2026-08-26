'use strict';

require('dotenv').config();
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const helmet = require('helmet');
const { attachBrowserWebSocket } = require('./realtime');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'blob:', 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginEmbedderPolicy: false
}));

app.get('/api/health', (_req, res) => res.json({ ok: true, transport: 'websocket' }));
app.get('/api/browser', (_req, res) => res.status(426).json({ error: 'WebSocket upgrade required.' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], maxAge: 0 }));
app.use((_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const server = http.createServer(app);
const runtime = attachBrowserWebSocket(server);

async function shutdown(signal) {
  console.log(`[server] ${signal}: shutting down`);
  server.close();
  await runtime.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  console.log(`[server] Private Browser running at http://${HOST}:${PORT}`);
  console.log('[server] Browser transport: WebSocket /api/browser');
});
