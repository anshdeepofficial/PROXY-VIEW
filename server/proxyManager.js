'use strict';

class ProxyManager {
  constructor(env = process.env) {
    this.mode = String(env.PROXY_MODE || 'none').toLowerCase();
    this.items = this.#load(env);
    this.index = 0;
  }

  #load(env) {
    const values = [];
    if (env.PROXY_URL && env.PROXY_URL.trim()) values.push(env.PROXY_URL.trim());

    if (env.PROXY_POOL && env.PROXY_POOL.trim()) {
      try {
        const parsed = JSON.parse(env.PROXY_POOL);
        if (!Array.isArray(parsed)) throw new Error('PROXY_POOL must be a JSON array.');
        for (const entry of parsed) {
          if (typeof entry === 'string' && entry.trim()) values.push(entry.trim());
          else if (entry && typeof entry === 'object') values.push(entry);
        }
      } catch (error) {
        throw new Error(`Invalid PROXY_POOL: ${error.message}`);
      }
    }

    const unique = [];
    const seen = new Set();
    for (const value of values) {
      const normalized = this.#normalize(value);
      const key = JSON.stringify(normalized);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(normalized);
      }
    }
    return unique;
  }

  #normalize(value) {
    if (typeof value === 'string') {
      let url;
      try {
        url = new URL(value);
      } catch {
        throw new Error('Proxy URLs must be valid absolute URLs.');
      }
      if (!['http:', 'https:', 'socks5:'].includes(url.protocol)) {
        throw new Error(`Unsupported proxy protocol: ${url.protocol}`);
      }
      if (!url.hostname || !url.port) throw new Error('Proxy URL must include host and port.');
      return {
        server: `${url.protocol}//${url.hostname}:${url.port}`,
        username: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined
      };
    }

    if (!value || typeof value !== 'object') throw new Error('Invalid proxy entry.');
    const protocol = String(value.protocol || 'http').replace(/:$/, '').toLowerCase();
    if (!['http', 'https', 'socks5'].includes(protocol)) throw new Error(`Unsupported proxy protocol: ${protocol}`);
    if (!value.host || !value.port) throw new Error('Proxy object requires host and port.');
    return {
      server: `${protocol}://${value.host}:${value.port}`,
      username: value.username || undefined,
      password: value.password || undefined
    };
  }

  hasProxy() {
    return this.items.length > 0 && this.mode !== 'none';
  }

  next() {
    if (!this.hasProxy()) return null;
    const proxy = this.items[this.index % this.items.length];
    this.index = (this.index + 1) % this.items.length;
    return { ...proxy };
  }

  describe(proxy) {
    if (!proxy) return { connected: false, label: 'Direct connection' };
    const protocol = proxy.server.split(':')[0].toUpperCase();
    return { connected: true, label: `Proxy connected (${protocol})` };
  }

  redact(proxy) {
    if (!proxy) return null;
    return { server: proxy.server, hasAuthentication: Boolean(proxy.username || proxy.password) };
  }
}

module.exports = { ProxyManager };
