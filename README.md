# Live CSS/HTML/JS Editor Extension

## Overview

This project is a browser extension (Chrome + Firefox) that allows **live** editing of a page's HTML, CSS, and JS — similar in concept to tools like **Violentmonkey** or **Stylus**, but with one key difference: editing happens from an **external companion app**, not inside the extension itself.

Core idea: the extension and the editor app **connect to each other** through a unique pairing code — similar to how Bluetooth pairing or AnyDesk works — and any change made in the editor is applied **instantly**, in real time, to the page you're viewing.

## Architecture

The project consists of 3 separate components that communicate with each other via WebSocket:

```
my-project/
├── extension/            ← loaded into Chrome/Firefox
│   ├── manifest.json      (2 versions: chrome/firefox)
│   ├── background.js      (keeps the WebSocket connection, gets/stores the code)
│   ├── content-script.js  (injects CSS/HTML/JS into the page)
│   └── popup.html/js      ← UI when you click the icon (shows the pairing code)
│
├── relay-server/          ← hosted on Railway
│   └── server.js          ← WebSocket relay (Node.js)
│
└── editor-app/            ← the editor app (web app, opened in another tab)
    ├── index.html
    ├── style.css
    └── app.js
```

## How it works (full flow)

1. **Installation** — the first time the extension opens, it generates its own unique code (e.g. `X7K2M9`) and stores it locally (`browser.storage.local`). This code stays **fixed forever** for that install.
2. **Extension connects** — the extension automatically connects to the relay server and says "I'm code X7K2M9."
3. **Opening the editor** — the editor app enters the same code and connects to the same server.
4. **The "room"** — the server pairs both parties inside a "room" named after the code; messages between them go only to each other, not to other clients.
5. **Making an edit** — you write CSS/HTML/JS in the editor → it's sent to the server → the server forwards it to the extension → the content script applies it immediately on the page, no refresh needed.

```
[Editor App] --WebSocket--> [Relay Server] --WebSocket--> [Extension] --> [Page updates live]
```

## Tech stack

| Component | Language / Technology |
|---|---|
| Extension (Chrome + Firefox) | JavaScript (WebExtensions API) |
| Relay server | Node.js + `ws` (WebSocket library) |
| Editor app | JavaScript + HTML/CSS |
| Chrome/Firefox compatibility | `webextension-polyfill` (1 codebase, 2 manifests) |

> **Note:** Python **cannot** be used inside the extension or the content script, since the browser only executes JavaScript. The relay server could theoretically be written in Python instead, but for simplicity the whole stack stays on Node.js.

## Hosting

- **Relay server** → **Railway** (supports "always-on" processes, required for WebSocket)
- **Editor app** → can also stay on Railway, or separately on Vercel/Netlify (static)

## Testing

**Phase 1 — Local (during development):**
```
Relay server   → localhost:8080
Editor app     → localhost:3000  (e.g. npx serve editor-app)
Extension      → connected to localhost:8080
```

**Phase 2 — Real (two devices, anywhere on the internet):**
- Deploy the relay server to Railway → public URL
- Change the addresses in the extension/app from `localhost` to the public URL
- (Optional, for quick testing before final deploy: **ngrok**)

## Publishing

| Platform | Cost |
|---|---|
| Chrome Web Store | $5 (one-time, forever, covers your entire catalog) |
| Firefox Add-ons (AMO) | Free |

## Security

- Pairing verification: the server only allows 2 members per room (extension + editor), rejects/regenerates a code on collision
- HTTPS/WSS (not HTTP/WS) — provided automatically by Railway
- The pairing code is generated locally (not from a central database) for simplicity — the collision probability is negligible at this project's scale