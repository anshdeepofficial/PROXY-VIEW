import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { attachBrowserWebSocket } = require('../server/realtime');

const server = http.createServer((req, res) => {
  res.statusCode = 426;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify({ error: 'WebSocket upgrade required.' }));
});

const runtime = attachBrowserWebSocket(server);

process.on('SIGTERM', () => {
  runtime.close().catch(() => {});
});

export default server;
