# Private Browser`n`n<p align="center">`n  <a href="https://github.com/sponsors/anshdeepofficial"><img src="https://img.shields.io/badge/Sponsor-%E2%9D%A4-EA4AAA?style=for-the-badge&logo=githubsponsors&logoColor=white" alt="Sponsor on GitHub" height="40" /></a>`n  <a href="https://buymeacoffee.com/anshdeepofficial"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me a Coffee" height="40" /></a>`n</p>

A privacy-focused remote browser. The target website runs in a temporary isolated Chromium context on the server and the rendered viewport is streamed to the client over WebSocket. It does not rely on an iframe.

## GitHub-ready repository

This repository is prepared to be pushed directly to GitHub:

- no Windows `.bat` setup files
- no committed secrets
- `.env` files are ignored
- GitHub Actions validation is included
- Vercel configuration is included
- frontend lives in `public/`
- Vercel WebSocket backend lives in `api/browser.mjs`
- local development backend remains available through `npm start`

## Project structure

```text
private-browser/
├── .github/workflows/ci.yml
├── api/browser.mjs
├── public/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── server/
│   ├── browserManager.js
│   ├── proxyManager.js
│   ├── realtime.js
│   ├── security.js
│   ├── server.js
│   └── sessionManager.js
├── tests/security.test.js
├── .env.example
├── .gitignore
├── package.json
├── vercel.json
└── README.md
```

## Push to GitHub

Create an empty GitHub repository, then from this project folder run:

```bash
git init
git add .
git commit -m "Initial Private Browser deployment"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```

Do not commit a real `.env` file or proxy credentials.

## Deploy from GitHub to Vercel

1. Push the repository to GitHub.
2. Open Vercel and choose **Add New → Project**.
3. Import the GitHub repository.
4. Keep the repository root as the Vercel root directory.
5. Vercel will use `vercel.json`; the static output is `public`.
6. Add any required environment variables in **Project → Settings → Environment Variables**.
7. Deploy.

No Windows setup file, Dockerfile, custom build server, or manual `npm start` command is required on Vercel.

### Vercel environment variables

For direct browsing, none of the proxy variables are required.

For one authorized proxy:

```env
PROXY_MODE=single
PROXY_URL=http://username:password@proxy.example:8080
```

For rotation with **New Identity**:

```env
PROXY_MODE=pool
PROXY_POOL=["http://user:pass@proxy1.example:8080","socks5://proxy2.example:1080"]
```

Never place proxy credentials in `public/app.js`, `index.html`, `vercel.json`, or another public frontend file.

## Important Vercel runtime behavior

Vercel WebSocket support is currently a platform Public Beta. A WebSocket connection is pinned to one Vercel Function instance for that Function's maximum duration. This repository therefore keeps all stateful browser commands for a temporary Chromium session on the same WebSocket instead of creating a session through one REST invocation and attempting to control it from later invocations.

`vercel.json` sets the browser WebSocket Function to a 60-second maximum duration so the repository remains compatible with the Vercel Hobby ceiling documented at the time this project was prepared. This means a single Vercel-hosted browser connection can be terminated after about one minute; Retry creates a new temporary Chromium session. If your Vercel plan permits a longer Function duration, increase `functions.api/browser.mjs.maxDuration` up to your plan's supported limit.

For an always-on remote browser with long uninterrupted sessions, a persistent container/VM host is still a better deployment target than a duration-limited Function platform.

## Chromium on Vercel

The Vercel Function uses:

- `playwright-core` 1.61.1
- `@sparticuz/chromium` 149

When `VERCEL` is present, the backend automatically launches the serverless Chromium executable supplied by `@sparticuz/chromium`. You do not run `npx playwright install chromium` on Vercel.

## Local development

Requirements:

- Node.js 20+
- npm

Install and run:

```bash
npm install
npx playwright install chromium
cp .env.example .env
npm start
```

On Windows PowerShell, use:

```powershell
npm install
npx playwright install chromium
Copy-Item .env.example .env
npm start
```

Then open `http://localhost:3000`.

The old `SETUP_WINDOWS.bat` and `START_WINDOWS.bat` files are intentionally removed because GitHub/Vercel deployment does not use them.

## What is implemented

- Real Chromium rendering for normal JavaScript pages, forms, redirects and client-side applications
- Browser viewport streamed over WebSocket
- Click, mouse movement, scroll, keyboard input and mobile touch scrolling
- Back, Forward, Reload and New Identity
- Temporary isolated Playwright browser context per connected user session
- Real proxy selection/rotation using administrator-supplied HTTP, HTTPS or SOCKS5 proxies
- Proxy credentials remain server-side
- SSRF checks for HTTP(S) and WebSocket destinations
- blocking of loopback, RFC1918, link-local, metadata/internal hostnames and reserved destinations
- destination revalidation on intercepted browser requests
- automatic session cleanup when the WebSocket closes, the session idles, or the user ends it
- responsive desktop/mobile interface and fullscreen mode
- Vercel security headers

## Privacy behavior

The application intentionally does not create a persistent browsing-history database. A new browser context is temporary; destroying it clears its cookies, localStorage, sessionStorage, IndexedDB and cache state. The application does not claim complete anonymity. Destination sites, hosting providers and proxy providers may still observe traffic according to their own systems and policies.

## Technical limitations

This is a streamed remote browser viewport, not a native browser engine embedded in the phone. Page audio is not streamed. Downloads are disabled. Websites that depend on DRM, WebAuthn/hardware keys, CAPTCHA, advanced anti-bot systems, protected media, banking security systems or browser-automation restrictions can fail. This project does not bypass those controls.

Vercel also has Function execution-duration limits. A persistent container host is recommended if long remote-browser sessions are required.

## Security notes before public launch

A public browser proxy consumes significant CPU/RAM and can be abused. Before sharing the deployment widely:

- enable appropriate Vercel deployment/access protection or add application authentication
- keep `MAX_SESSIONS` low
- use rate/abuse controls appropriate to your audience
- use only authorized proxy providers
- add network-level egress restrictions if deploying on infrastructure that supports them
- do not weaken the SSRF protections

## Validation

Run:

```bash
npm run check
npm test
```

GitHub Actions runs the same validation on pushes and pull requests.
