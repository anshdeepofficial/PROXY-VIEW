'use strict';

const { chromium } = require('playwright-core');
const { guardRoute, assertSafeRemoteUrl, assertSafeWebSocketUrl, toPublicError } = require('./security');

class BrowserManager {
  constructor({ navigationTimeoutMs = 30000 } = {}) {
    this.browser = null;
    this.navigationTimeoutMs = navigationTimeoutMs;
  }

  async start() {
    if (this.browser?.isConnected()) return this.browser;

    const customArgs = [
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'
    ];

    const launchOptions = { headless: true, args: customArgs };

    if (process.env.VERCEL || process.env.SERVERLESS_CHROMIUM === '1') {
      const serverlessChromium = require('@sparticuz/chromium');
      launchOptions.executablePath = await serverlessChromium.executablePath();
      launchOptions.args = [...serverlessChromium.args, ...customArgs];
    } else if (process.env.CHROMIUM_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
    }

    this.browser = await chromium.launch(launchOptions);
    return this.browser;
  }

  async createContext({ proxy, viewport }) {
    await this.start();
    const context = await this.browser.newContext({
      viewport,
      proxy: proxy || undefined,
      ignoreHTTPSErrors: false,
      acceptDownloads: false,
      javaScriptEnabled: true,
      serviceWorkers: 'block'
    });

    await context.route('**/*', guardRoute);
    await context.routeWebSocket('**/*', async (ws) => {
      try {
        await assertSafeWebSocketUrl(ws.url());
        ws.connectToServer();
      } catch {
        await ws.close({ code: 1008, reason: 'Blocked destination' });
      }
    });

    return context;
  }

  async navigate(page, rawUrl) {
    try {
      const url = await assertSafeRemoteUrl(rawUrl);
      await page.goto(url.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: this.navigationTimeoutMs
      });
      return page.url();
    } catch (error) {
      throw Object.assign(error, { publicView: toPublicError(error) });
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

module.exports = { BrowserManager };
