# Design live app fixture

A Vite + React 19 app for the live-frame E2E (`tests/e2e/design-live-frames.spec.ts`) and the Phase 3a probes. No lockfile and no install: tests copy it to a temp folder and symlink `node_modules` to the repo root's, which counts as the person's install, so design mode's detection finds Vite (`devDependencies`) and starts `npm run dev` without installing. `cacheDir` is `.vite-cache` inside the copy so nothing is written into the repo's `node_modules`.

Routes (no router; `App.tsx` switches on `location.pathname`, and Vite's SPA fallback serves `index.html`):

- `/`: "Fixture home", a counter, and links to `/pricing`, `/go-login`, `/go-out` and `/framed`.
- `/pricing`: `<h1>Pricing</h1>` on a fixed line of `src/Pricing.tsx`, and `PriceCard` twice (the React source-mapping check).
- `/probe?target=127.0.0.1:P&alt=127.0.0.2:P2&udp=U&own=O`: Run tries every way out of the frame (fetch, img, WebSocket, EventSource, CSS, prefetch hints, ping, beacon, WebTransport, workers, Aiden's custom schemes, redirects, popups, dialogs, permissions, Picture-in-Picture, fullscreen, clipboard, a YouTube iframe, top navigation, `mailto:`, a download and a service worker) and writes each outcome to `#result` as JSON. `thief=1` (or the Focus thief button) calls `input.focus()` every 50 ms. `auto=export` runs the export-window subset on load.
- `/login`: a form that posts to `/api/login`; `#me` shows `/api/me`.

Server routes (`vite.config.ts`): `/go-out` → 302 `https://example.com/`; `/go-login` → 302 `/login`; `/r-own?port=N` → 307 `http://127.0.0.1:N/`; `/r-evil` → 302 `http://localhost.evil.test/`; `POST /api/login` sets `sid=fixture` with no `SameSite`; `/api/me` answers the cookie or 401; `/framed` sends `X-Frame-Options: DENY` and `frame-ancestors 'none'`; `/reporting?to=URL` sends reporting headers; `/f.zip` is an attachment. `public/sw.js` is the probe's service worker.
