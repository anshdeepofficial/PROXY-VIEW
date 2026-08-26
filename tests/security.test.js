'use strict';
const assert = require('node:assert/strict');
const { normalizeUrl, assertSafeRemoteUrl, assertSafeWebSocketUrl, isPublicAddress } = require('../server/security');
const { ProxyManager } = require('../server/proxyManager');

(async () => {
  assert.equal(normalizeUrl('example.com').toString(), 'https://example.com/');
  assert.throws(() => normalizeUrl('file:///etc/passwd'), /Only HTTP and HTTPS/);

  assert.equal(isPublicAddress('8.8.8.8'), true);
  for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fc00::1', 'fe80::1']) {
    assert.equal(isPublicAddress(ip), false, `${ip} must be blocked`);
  }

  await assert.rejects(() => assertSafeRemoteUrl('http://127.0.0.1'), /Private or internal/);
  await assert.rejects(() => assertSafeRemoteUrl('http://localhost'), /Private or internal/);
  await assert.rejects(() => assertSafeWebSocketUrl('ws://169.254.169.254/socket'), /Private or internal/);
  await assert.doesNotReject(() => assertSafeRemoteUrl('https://8.8.8.8/'));

  const proxies = new ProxyManager({
    PROXY_MODE: 'pool',
    PROXY_URL: '',
    PROXY_POOL: '["http://user:pass@one.example:8080","socks5://two.example:1080"]'
  });
  assert.equal(proxies.next().server, 'http://one.example:8080');
  assert.equal(proxies.next().server, 'socks5://two.example:1080');
  assert.equal(proxies.next().server, 'http://one.example:8080');

  console.log('All security/proxy tests passed.');
})().catch((error) => { console.error(error); process.exit(1); });
