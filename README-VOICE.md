# SIGNAL — Voice Integration Guide

SIGNAL uses the **Gemini Live API** for real-time, speech-to-speech conversation.
The user speaks (or types) into the orb interface; SIGNAL always responds with **spoken audio**.

---

## Architecture

```
Browser (GitHub Pages)
  app.html + js/*
      │
      │  1. GET /api/token  (one HTTPS call per session)
      ▼
Cloudflare Worker  ←── GEMINI_API_KEY (secret, never exposed)
  server/src/index.js
      │
      │  returns { token, expireTime }
      ▼
Browser opens WebSocket directly to:
  generativelanguage.googleapis.com  (Gemini Live API)
      ▲▼
  audio chunks stream bidirectionally
  (backend is NOT a relay — only token minting)
```

The backend is only hit **once per session**, to mint a short-lived ephemeral token.
All audio flows directly between the browser and Google's servers for minimum latency.

---

## Quick Start (Local Development)

### 1. Run the token backend locally

```bash
cd server/

# Install Wrangler if you haven't
npm install -g wrangler

# Create .dev.vars with your real API key (git-ignored)
echo "GEMINI_API_KEY=your_key_here" > .dev.vars

# Start local Worker
npx wrangler dev
# → Worker running at http://localhost:8787
```

### 2. Serve the frontend

```bash
# From repo root
python serve.py
# → Frontend at http://localhost:8080
```

### 3. Point the frontend at your local Worker

Open browser DevTools console on `http://localhost:8080/app.html` and run:

```js
window.SIGNAL_TOKEN_URL = 'http://localhost:8787/api/token';
```

Then reload the page. The `window.SIGNAL_TOKEN_URL` override is read at startup.

> **Note:** The Worker's CORS policy only allows `https://adithyahanuman.github.io` by default.
> For local dev, uncomment the `http://localhost:8080` line in `server/src/index.js` before running `wrangler dev`.

---

## Production Deployment

See [`server/DEPLOY.md`](./server/DEPLOY.md) for full step-by-step instructions.

Quick version:
```bash
cd server/
npx wrangler login
npx wrangler secret put GEMINI_API_KEY   # paste key when prompted
npx wrangler deploy
```

Then update `TOKEN_URL` in `js/main-app.js` with your Worker's URL.

---

## How Voice Input Works

1. **Click the 🎙 mic button** (or press **M**) — triggers `getUserMedia` for mic access.
2. An `AudioWorklet` captures mic audio, downsamples it to **16 kHz PCM16**, and streams
   chunks over the Gemini Live WebSocket.
3. Gemini responds with **spoken audio** (24 kHz PCM16), played back via a second `AudioWorklet`
   with a ring buffer for gap-free playback.
4. **Barge-in** is native: if you speak while SIGNAL is talking, playback stops immediately
   and the model starts listening.

---

## How Text Input Works

1. **Click the ⌨ button** (or press **T**) to reveal the text input field.
2. Type your message and press **Enter** or **▶**.
3. The message is sent as a complete conversational turn on the **same WebSocket session** —
   no separate TTS step, no separate session. The model's `response_modalities` is set to
   `["AUDIO"]`, so the reply is always spoken regardless of how input arrived.
4. If the mic is active when you send a text message, mic capture is briefly paused to
   prevent the two input paths from colliding on the same turn, then resumed.
5. If no session is open when you send text, one is opened automatically first.

---

## Orb State Transitions

| State      | Mode label  | Orb visual                                     |
|------------|-------------|------------------------------------------------|
| idle       | STANDBY     | Default ambient pulse                          |
| listening  | LISTENING   | Bloom +, scan rings brighten with slow ripple  |
| thinking   | PROCESSING  | Chromatic aberration ++, rapid scan rings      |
| speaking   | SPEAKING    | Core pulse synced to audio amplitude, bloom ++ |

State transitions are **identical** whether the conversation turn came from voice or text.

---

## Known Limitations

| Limitation | Notes |
|---|---|
| **15-minute session cap** | Audio-only Gemini Live sessions are capped at 15 minutes. SIGNAL warns at ~14:30 and closes cleanly. Click the mic button to start a new session. |
| **No camera streaming** | `js/geminiLive.js` includes a `sendVideoChunk()` stub — camera video can be added without refactoring the WebSocket session. |
| **No transcript UI** | By design: SIGNAL is speech-only output. The text input is an alternate *input* path, not a chat interface. |
| **No persistent user auth** | The token endpoint has a `// TODO` for real auth. Keep the Worker URL private until auth is added to avoid quota abuse. |
| **HTTPS required** | `getUserMedia` and `AudioWorklet` require a secure context (HTTPS or localhost). GitHub Pages satisfies this for production. |
| **One modality per session** | Gemini Live allows only one `response_modalities` value per session (`"AUDIO"`). Switching to text output would require a new session. |

---

## Model

```
models/gemini-2.5-flash-native-audio
```

Voice: **Aoede** (can be changed in `js/geminiLive.js` → `SIGNAL_VOICE`)

If Google deprecates this model, update `GEMINI_MODEL` in both `js/geminiLive.js` **and**
`server/src/index.js`, then redeploy the Worker (the model is locked into the ephemeral token's
`live_connect_constraints`).

---

## File Map

```
js/
  geminiLive.js        — WebSocket session manager
  audioCapture.js      — getUserMedia + worklet orchestration
  capture-worklet.js   — AudioWorklet: mic → PCM16 @ 16 kHz
  audioPlayback.js     — Playback queue wrapper
  playback-worklet.js  — AudioWorklet: PCM16 @ 24 kHz → speakers
  main-app.js          — Wires everything to the orb UI
  orbScene.js          — Three.js orb (setConversationState added)
server/
  src/index.js         — Cloudflare Worker (token minting)
  wrangler.toml        — Worker config
  DEPLOY.md            — Deployment guide
```
