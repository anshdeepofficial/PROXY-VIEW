# Validation

## Repository validation

Run:

```bash
npm run check
npm test
```

These checks validate JavaScript syntax and the included URL/SSRF/proxy security cases without requiring Chromium to launch.

## Local Chromium smoke test

After installing dependencies and the browser:

```bash
npm install
npx playwright install chromium
npm start
```

Open `http://localhost:3000`, enter `https://example.com`, and verify:

1. the WebSocket connects at `/api/browser`
2. Chromium starts
3. the page appears in the remote canvas
4. click/scroll/text input work
5. Back/Forward/Reload work
6. New Identity destroys the old browser context and creates a new one
7. End Session closes the temporary context

## Vercel smoke test

After importing the GitHub repository into Vercel:

1. open the deployment URL
2. confirm the static UI loads from `public/`
3. enter `https://example.com`
4. confirm `/api/browser` upgrades to a WebSocket
5. confirm the remote Chromium viewport starts rendering
6. verify the session ends cleanly when the Function duration is reached

The Vercel deployment uses `@sparticuz/chromium`; local development uses a Playwright-installed Chromium unless `CHROMIUM_EXECUTABLE_PATH` is supplied.
