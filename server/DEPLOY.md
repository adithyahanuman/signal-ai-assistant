# SIGNAL Token Service — Deployment Guide

## Prerequisites
- Node.js 18+ installed
- A Google AI Studio API key with Gemini Live API access
- A Cloudflare account (free tier is fine)

---

## 1. Install Wrangler

```bash
npm install -g wrangler
# or use npx without installing globally
```

---

## 2. Log in to Cloudflare

```bash
npx wrangler login
```

This opens a browser tab to authenticate with your Cloudflare account.

---

## 3. Set the API key secret

**Never** put the key in `wrangler.toml` or any committed file.

```bash
cd server/
npx wrangler secret put GEMINI_API_KEY
# Paste your Google AI Studio key when prompted
```

---

## 4. Deploy the Worker

```bash
cd server/
npx wrangler deploy
```

After deploying, Wrangler prints your Worker URL, e.g.:
```
https://signal-token-service.YOUR-SUBDOMAIN.workers.dev
```

---

## 5. Verify

```bash
curl -H "Origin: https://adithyahanuman.github.io" \
     "https://signal-token-service.YOUR-SUBDOMAIN.workers.dev/api/token"
```

Expected response (token value is a long string):
```json
{ "token": "...", "expireTime": "2026-07-20T12:05:00Z" }
```

---

## 6. Point the frontend at your Worker

Open `js/main-app.js` and update the `TOKEN_URL` in the `CONFIG` object at the top:

```js
const CONFIG = {
  TOKEN_URL: 'https://signal-token-service.YOUR-SUBDOMAIN.workers.dev/api/token',
};
```

Or, without touching committed code, set it from the browser console before the app loads:
```js
window.SIGNAL_TOKEN_URL = 'https://signal-token-service.YOUR-SUBDOMAIN.workers.dev/api/token';
```

---

## Local Development

For local dev, Wrangler can run the Worker locally. Create `server/.dev.vars` (git-ignored):

```
GEMINI_API_KEY=your_key_here
```

Then run:
```bash
cd server/
npx wrangler dev
# Worker available at http://localhost:8787
```

In the browser console (while `serve.py` serves the frontend):
```js
window.SIGNAL_TOKEN_URL = 'http://localhost:8787/api/token';
```

Note: the CORS `ALLOWED_ORIGINS` in `server/src/index.js` may need `http://localhost:8080`
(or whatever port `serve.py` uses) added for local dev. Uncomment the relevant line.

---

## Updating the model

If Google deprecates `models/gemini-2.5-flash-native-audio`, update `GEMINI_MODEL` in
`server/src/index.js`, then redeploy:

```bash
cd server/
npx wrangler deploy
```

No frontend changes needed — the model is locked into the token's `live_connect_constraints`.
