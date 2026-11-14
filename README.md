# Stepwise Ventures Utility Portal (demo)

A simulated utility customer and dispatch portal. The back end runs in the browser (localStorage), so there is no server or database to set up. Payments, tokens, tickets and grid data are all simulated. Nothing here is a real utility, payment or dispatch system.

## What's in the package

| Path | Purpose |
|---|---|
| `dist/index.html` | Standalone portal, with offline support, icons and manifest. Serve it over https or localhost. |
| `dist/artifact.html` | Version for the Artifact viewer. No service worker or manifest, because the viewer blocks them. |
| `dist/manifest.webmanifest`, `dist/sw.js`, `dist/icons/` | Installable app files: manifest, service worker and icon set. |
| `src/` | Source: template, styles, UI screens, assistant, PWA files. |
| `engine.js`, `src/engine.p*.js` | Back end (rules, billing, tickets, staff API). `engine.js` is built from the parts. |
| `assets/` | Stepwise Ventures logo (`logo-source.png`) and the generated icons. |
| `tests/` | Unit tests, browser smoke test, PWA check. |
| `serve.js` | Local server for `dist/` (HTTP or HTTPS). |
| `scripts/` | Icon generator (`make-icons.py`) and certificate script (`make-cert.sh`). |
| `shots/` | Screenshots of the screens from the last browser test. |

## Run it

Requires Node.js 18 or later. There are no runtime dependencies. The browser tests use Playwright and Chrome.

```bash
npm run build      # rebuild dist/ from src/ (also rebuilds engine.js)
npm start          # http://localhost:8080  (service workers work on localhost)
```

### HTTPS (for testing on a secure origin)

```bash
npm run cert           # creates a self-signed certificate in certs/
npm run start:https    # https://localhost:8443
```

Your browser will warn that the certificate is self-signed. Accept the warning for local testing. For offline mode to work over HTTPS, the browser must trust the certificate, so you may need to add `certs/local.crt` to your trusted certificates. Chrome and Edge accept the local certificate if you import it into the operating system's trust store.

### Hosting a demo online

Upload the contents of `dist/` to any static host that serves HTTPS (for example Netlify, Cloudflare Pages or GitHub Pages). Upload `index.html`, `manifest.webmanifest`, `sw.js` and `icons/`. Do not upload `artifact.html` to a public host, because it is meant only for the Artifact viewer.

## Tests

```bash
npm test          # 35 unit tests for the engine and assistant
npm run test:browser   # needs `npm start` running, or runs against dist/index.html via file://
npm run test:pwa       # starts its own HTTP and HTTPS servers; HTTPS needs npm run cert
```

## Demo codes

These are fake and work only in this demo. The dashboard shows them under **Demo codes** and each one has a copy button. Staff can hide them in **Brand & settings**.

- **Meters:** 11-digit numbers with PINs (shown on the dashboard).
- **Postpaid account:** account number and PIN.
- **Fault ticket:** a sample open area blackout, for tracking.
- **Tip-off:** a sample confidential report, with its access code, for checking progress.
- **Staff logins:** `dispatcher / dispatch123` and `supervisor / super123`.

## Limits

- Tariffs, fees, USSD codes, office addresses and hours, and grid figures are sample values. Replace them with verified figures before any pitch.
- Tokens are random 20-digit numbers, not real STS tokens. Real vending needs a certified vending system.
- Password and PIN hashing is demo-grade.
- Data is stored per browser. Two people on two computers do not share data.
- The service worker caches the app shell only. Data stays in localStorage and is never cached or changed by the worker.

## Regenerate the icons

```bash
npm run icons     # needs Python 3 with Pillow; reads assets/logo-source.png
```
