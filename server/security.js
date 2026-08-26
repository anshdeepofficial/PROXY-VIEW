'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'kubernetes.default',
  'kubernetes.default.svc'
]);

const blocked = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
].forEach(([network, prefix]) => blocked.addSubnet(network, prefix, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32]
].forEach(([network, prefix]) => blocked.addSubnet(network, prefix, 'ipv6'));

function normalizeUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw publicError('INVALID_URL', 'Enter a website URL.');
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)) raw = `https://${raw}`;

  let url;
  try { url = new URL(raw); }
  catch { throw publicError('INVALID_URL', 'That URL is not valid.'); }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw publicError('BLOCKED_SCHEME', 'Only HTTP and HTTPS websites are allowed.');
  }
  if (url.username || url.password) throw publicError('INVALID_URL', 'Credentials inside the URL are not allowed.');
  if (!url.hostname) throw publicError('INVALID_URL', 'The URL must include a hostname.');
  return url;
}

function hostnameLooksInternal(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTS.has(h)) return true;
  if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home') || h.endsWith('.corp')) return true;
  if (h === '0' || h === '0.0.0.0') return true;
  return false;
}

function isPublicAddress(address) {
  const type = net.isIP(address);
  if (!type) return false;
  if (type === 6) {
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return isPublicAddress(mapped[1]);
    return !blocked.check(address, 'ipv6');
  }
  return !blocked.check(address, 'ipv4');
}

async function assertPublicHost(host) {
  const cleanHost = host.replace(/^\[|\]$/g, '');
  if (hostnameLooksInternal(cleanHost)) throw publicError('BLOCKED_ADDRESS', 'Private or internal network addresses are blocked.');

  if (net.isIP(cleanHost)) {
    if (!isPublicAddress(cleanHost)) throw publicError('BLOCKED_ADDRESS', 'Private or internal network addresses are blocked.');
    return;
  }

  let records;
  try { records = await dns.lookup(cleanHost, { all: true, verbatim: true }); }
  catch { throw publicError('DNS_ERROR', 'The hostname could not be resolved.'); }

  if (!records.length || records.some(({ address }) => !isPublicAddress(address))) {
    throw publicError('BLOCKED_ADDRESS', 'The hostname resolves to a private, local, or reserved address.');
  }
}

async function assertSafeRemoteUrl(input) {
  const url = input instanceof URL ? input : normalizeUrl(input);
  await assertPublicHost(url.hostname);
  return url;
}

async function assertSafeWebSocketUrl(input) {
  let url;
  try { url = new URL(String(input)); }
  catch { throw publicError('INVALID_URL', 'Invalid WebSocket destination.'); }
  if (!['ws:', 'wss:'].includes(url.protocol)) throw publicError('BLOCKED_SCHEME', 'Unsupported WebSocket destination.');
  await assertPublicHost(url.hostname);
  return url;
}

async function guardRoute(route) {
  const request = route.request();
  let url;
  try { url = new URL(request.url()); }
  catch { return route.abort('blockedbyclient'); }

  if (['http:', 'https:'].includes(url.protocol)) {
    try { await assertSafeRemoteUrl(url); return route.continue(); }
    catch { return route.abort('blockedbyclient'); }
  }

  if (['data:', 'blob:', 'about:'].includes(url.protocol) && !request.isNavigationRequest()) return route.continue();
  return route.abort('blockedbyclient');
}

function publicError(code, message, status = 400) {
  const error = new Error(message);
  error.publicCode = code;
  error.status = status;
  return error;
}

function toPublicError(error) {
  if (error?.publicCode) return { code: error.publicCode, message: error.message };
  const text = String(error?.message || 'Unexpected browser error.');
  if (/timeout/i.test(text)) return { code: 'NAVIGATION_TIMEOUT', message: 'The website took too long to respond.' };
  if (/proxy/i.test(text) && /auth/i.test(text)) return { code: 'PROXY_AUTH_FAILED', message: 'Proxy authentication failed.' };
  if (/proxy/i.test(text)) return { code: 'PROXY_UNAVAILABLE', message: 'The configured proxy is unavailable.' };
  if (/certificate|ssl|ERR_CERT/i.test(text)) return { code: 'SSL_ERROR', message: 'The website returned an SSL/TLS error.' };
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|dns/i.test(text)) return { code: 'DNS_ERROR', message: 'The hostname could not be resolved.' };
  if (/Target page, context or browser has been closed|crash/i.test(text)) return { code: 'BROWSER_CRASH', message: 'The remote browser session stopped unexpectedly.' };
  return { code: 'WEBSITE_UNREACHABLE', message: 'The website could not be opened.' };
}

module.exports = { normalizeUrl, assertSafeRemoteUrl, assertSafeWebSocketUrl, guardRoute, publicError, toPublicError, isPublicAddress };
