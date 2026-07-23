// geminiLive.js — SIGNAL Gemini Live API WebSocket session manager
//
// Wraps the full lifecycle of a Gemini Live bidirectional WebSocket session:
//   • Fetching an ephemeral token from the backend (never exposes the real API key)
//   • Opening the WebSocket and sending the setup handshake
//   • Streaming mic audio chunks and typed text messages on the same session
//   • Parsing server messages and firing typed callbacks
//   • Handling session cap (15-min audio-only limit) and reconnect backoff
//
// ── Model & config ─────────────────────────────────────────────────────────
// Model: models/gemini-2.5-flash-native-audio (stable as of July 2026).
// Check https://ai.google.dev/api/live for updates when this becomes deprecated.
//
// responseModalities: ["AUDIO"] — voice-only output; typed text from the user
// is a second *input* path on the same session, not a separate TTS step.
//
// Voice: "Aoede" — clear, natural-sounding HD voice well-suited for a
// conversational AI assistant. Change SIGNAL_VOICE below to try others:
//   Charon, Fenrir, Kore, Puck, Leda, Orus, Schedar, Zephyr (check docs for full list)
//
// ── Camera extension point ─────────────────────────────────────────────────
// To add camera video streaming later, implement sendVideoChunk() — the
// existing WebSocket session already supports audio + video concurrently.
// No session refactoring is needed; just uncomment the stub below and
// wire in a video capture source.

const GEMINI_MODEL = 'models/gemini-2.0-flash-live-001'; // stable Live API model
const SIGNAL_VOICE = 'Aoede';

// WebSocket endpoints — v1alpha is required for gemini-2.0-flash-live-001
const WS_BASE        = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.';
const WS_UNCONSTRAINED = WS_BASE + 'BidiGenerateContent';          // API key auth (?key=)
const WS_CONSTRAINED   = WS_BASE + 'BidiGenerateContentConstrained'; // ephemeral token auth

// Audio-only session cap is 15 minutes. Warn at 14:30 and close cleanly.
const SESSION_WARN_MS    = 14.5 * 60 * 1000;

// Reconnect backoff config (exponential)
const BACKOFF_BASE_MS    = 1000;
const BACKOFF_MAX_MS     = 30_000;
const BACKOFF_MULTIPLIER = 2;

// System instruction for SIGNAL's persona.
// Keep concise and voice-appropriate: no markdown, no long lists.
// Everything here will be *spoken*, so avoid symbols that TTS reads oddly.
const SYSTEM_INSTRUCTION =
  'You are SIGNAL, a voice-first AI assistant with a calm, precise, and ' +
  'slightly futuristic personality. You are displayed as a glowing neural orb. ' +
  'Keep responses concise and conversational — typically one to three sentences ' +
  'unless the user explicitly asks for detail. Never use markdown, bullet points, ' +
  'or formatting symbols in your replies, as your output is always spoken aloud. ' +
  'If you are unsure, say so briefly and offer to help further.';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Convert an ArrayBuffer to a base64 string for the WebSocket message. */
function arrayBufferToBase64(buffer) {
  const bytes  = new Uint8Array(buffer);
  let   binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Convert a base64 string to an ArrayBuffer. */
function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ── GeminiLiveClient ───────────────────────────────────────────────────────

export class GeminiLiveClient {
  /**
   * @param {object} opts
   * @param {string}   opts.tokenUrl           — Backend URL for GET /api/token
   * @param {Function} [opts.onSessionOpen]     — () => void
   * @param {Function} [opts.onModelTurnStart]  — () => void  (barge-in trigger)
   * @param {Function} [opts.onAudioChunk]      — (ArrayBuffer) => void
   * @param {Function} [opts.onTurnComplete]    — () => void
   * @param {Function} [opts.onTranscript]      — (text: string) => void  (AI subtitle)
   * @param {Function} [opts.onError]           — (Error) => void
   * @param {Function} [opts.onSessionClose]    — ({ reason, willReconnect }) => void
   *   reason: 'clean' | 'session_cap' | 'network'
   */
  constructor({
    tokenUrl,
    onSessionOpen    = () => {},
    onModelTurnStart = () => {},
    onAudioChunk     = () => {},
    onTurnComplete   = () => {},
    onTranscript     = () => {},
    onError          = () => {},
    onSessionClose   = () => {},
  } = {}) {
    this._tokenUrl        = tokenUrl;
    this.onSessionOpen    = onSessionOpen;
    this.onModelTurnStart = onModelTurnStart;
    this.onAudioChunk     = onAudioChunk;
    this.onTurnComplete   = onTurnComplete;
    this.onTranscript     = onTranscript;
    this.onError          = onError;
    this.onSessionClose   = onSessionClose;

    this._ws               = null;
    this._intentionalClose = false;
    this._connected        = false;
    this._backoffMs        = BACKOFF_BASE_MS;
    this._reconnectTimer   = null;
    this._sessionWarnTimer = null;
    this._inModelTurn      = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Fetch an ephemeral token and open the Gemini Live WebSocket session.
   * Safe to call multiple times — no-ops if already connected.
   */
  async connect() {
    if (this._connected || this._ws) return;

    let tokenData;
    try {
      tokenData = await this._fetchToken();
    } catch (err) {
      this.onError(new Error(`Token fetch failed: ${err.message}`));
      return;
    }

    this._intentionalClose = false;
    this._openWebSocket(tokenData);
  }

  /**
   * Stream a PCM16 audio chunk (from audioCapture) to the live session.
   * @param {ArrayBuffer} int16Buffer
   */
  sendAudioChunk(int16Buffer) {
    if (!this._connected) return;
    const b64 = arrayBufferToBase64(int16Buffer);
    // NOTE: Gemini Live WebSocket protocol uses camelCase JSON field names
    // (proto3 JSON encoding). snake_case will be silently ignored by the API.
    this._send({
      realtimeInput: {
        mediaChunks: [{
          mimeType: 'audio/pcm;rate=16000',
          data:     b64,
        }],
      },
    });
  }

  /**
   * Send a typed text message during an active conversation.
   * Gemini 3.1+ requires realtimeInput.text — clientContent is only for
   * seeding initial history context, NOT for live conversation turns.
   * @param {string} text
   */
  sendTextMessage(text) {
    if (!this._connected) return;
    this._send({
      realtimeInput: {
        text,
      },
    });
  }

  /**
   * Clean teardown. Does not trigger reconnect.
   */
  disconnect() {
    this._intentionalClose = true;
    this._clearTimers();
    if (this._ws) {
      try { this._ws.close(1000, 'Client disconnect'); } catch (_) {}
      this._ws = null;
    }
    this._connected = false;
  }

  get isConnected() { return this._connected; }

  // ── Camera extension stub (future work) ─────────────────────────────────
  // To add live video: capture frames from getUserMedia video track,
  // encode as JPEG, base64-encode, and call this method.
  // The existing WebSocket session supports audio + video concurrently —
  // no session refactoring needed.
  //
  // sendVideoChunk(base64Jpeg) {
  //   if (!this._connected) return;
  //   this._send({
  //     realtimeInput: {
  //       mediaChunks: [{
  //         mimeType: 'image/jpeg',
  //         data: base64Jpeg,
  //       }],
  //     },
  //   });
  // }

  // ── Private ───────────────────────────────────────────────────────────

  async _fetchToken() {
    const resp = await fetch(this._tokenUrl, { cache: 'no-store' });
    if (!resp.ok) {
      // Try to parse a structured error from the server
      let errMsg = `HTTP ${resp.status}`;
      try {
        const errData = await resp.json();
        if (errData.expired) {
          errMsg = 'TOKEN EXPIRED — paste a fresh AQ. key from aistudio.google.com into server/.env and restart the server';
        } else if (errData.error) {
          errMsg = errData.error;
        }
      } catch (_) {
        const body = await resp.text().catch(() => '');
        if (body) errMsg += ': ' + body;
      }
      throw new Error(errMsg);
    }
    const data = await resp.json();
    if (!data.token) throw new Error('No token in response');
    // Server sets type='oauth' for AQ. passthrough, 'ephemeral' for minted tokens
    return { token: data.token, type: data.type || 'ephemeral' };
  }

  _openWebSocket({ token, type }) {
    // Always use constrained endpoint with ephemeral token (access_token param)
    const url = `${WS_CONSTRAINED}?access_token=${encodeURIComponent(token)}`;
    console.log('[GeminiLive] Connecting → BidiGenerateContentConstrained (v1alpha)');
    this._ws = new WebSocket(url);

    this._ws.onopen = () => {
      // Send the setup handshake immediately on open.
      // ALL field names must be camelCase — the Gemini Live API uses proto3
      // JSON encoding which maps proto field names to camelCase.
      this._send({
        setup: {
          model: GEMINI_MODEL,
          generationConfig: {
            responseModalities: ['AUDIO'],
          },
          systemInstruction: {
            parts: [{ text: SYSTEM_INSTRUCTION }],
          },
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: SIGNAL_VOICE },
            },
          },
          // Note: outputAudioTranscription is not supported by gemini-3.1-flash-live-preview
          // Transcript text arrives via inline text parts in modelTurn.parts instead
        },
      });
      // onSessionOpen fires after the server sends setupComplete
    };

    this._ws.onmessage = (evt) => {
      this._handleMessage(evt.data);
    };

    this._ws.onerror = (evt) => {
      console.error('[GeminiLive] WebSocket error', evt);
      this.onError(new Error('WebSocket connection error'));
    };

    this._ws.onclose = (evt) => {
      this._connected = false;
      this._ws        = null;
      this._clearTimers();

      if (this._intentionalClose) {
        this.onSessionClose({ reason: 'clean', willReconnect: false });
        return;
      }

      console.warn(`[GeminiLive] Closed unexpectedly (code ${evt.code}). Reconnecting in ${this._backoffMs}ms`);
      this.onSessionClose({ reason: 'network', willReconnect: true });
      this._scheduleReconnect();
    };
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = typeof raw === 'string'
        ? JSON.parse(raw)
        : JSON.parse(new TextDecoder().decode(raw));
    } catch (err) {
      console.warn('[GeminiLive] Could not parse message', err);
      return;
    }

    // Log every raw server message — shows field names and structure in DevTools Console
    console.debug('[GeminiLive] ←', JSON.stringify(msg).slice(0, 300));

    // ── Setup complete ──────────────────────────────────────────────────
    // Server sends { setupComplete: {} } after accepting the setup message.
    if (msg.setupComplete !== undefined) {
      this._connected  = true;
      this._backoffMs  = BACKOFF_BASE_MS; // reset backoff on successful connect
      this._startSessionTimers();
      this.onSessionOpen();
      return;
    }

    // ── Server content (model audio response) ──────────────────────────
    if (msg.serverContent) {
      const sc = msg.serverContent;

      // Model turn start → fire barge-in so old audio gets flushed
      if (sc.modelTurn && !this._inModelTurn) {
        this._inModelTurn = true;
        this.onModelTurnStart();
      }

      // Audio parts — each inlineData blob is a chunk of PCM audio
      if (sc.modelTurn?.parts) {
        for (const part of sc.modelTurn.parts) {
          if (part.inlineData?.mimeType?.startsWith('audio/pcm')) {
            const buffer = base64ToArrayBuffer(part.inlineData.data);
            this.onAudioChunk(buffer);
          }
          // Inline text parts (some models return text + audio together)
          if (part.text) {
            this.onTranscript(part.text);
          }
        }
      }

      // Output audio transcription — text version of what the model spoke
      // Arrives as a separate serverContent message alongside audio chunks
      if (sc.outputTranscription?.parts) {
        const text = sc.outputTranscription.parts
          .map(p => p.text || '').join('');
        if (text) this.onTranscript(text);
      }

      // Turn complete
      if (sc.turnComplete) {
        this._inModelTurn = false;
        this.onTurnComplete();
      }

      return;
    }

    // ── Error frames ────────────────────────────────────────────────────
    if (msg.error) {
      console.error('[GeminiLive] Server error:', msg.error);
      this.onError(new Error(msg.error.message || 'Unknown server error'));
    }
  }

  _startSessionTimers() {
    this._clearTimers();
    // Fire just before the 15-minute audio-only session cap
    this._sessionWarnTimer = setTimeout(() => {
      console.warn('[GeminiLive] Approaching 15-minute session cap — closing cleanly');
      this.onSessionClose({ reason: 'session_cap', willReconnect: false });
      this._intentionalClose = true; // prevent the onclose handler from reconnecting
      this.disconnect();
    }, SESSION_WARN_MS);
  }

  _scheduleReconnect() {
    this._reconnectTimer = setTimeout(async () => {
      if (this._intentionalClose) return;
      console.log('[GeminiLive] Reconnecting…');
      this._backoffMs = Math.min(this._backoffMs * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
      await this.connect();
    }, this._backoffMs);
  }

  _clearTimers() {
    clearTimeout(this._sessionWarnTimer);
    clearTimeout(this._reconnectTimer);
    this._sessionWarnTimer = null;
    this._reconnectTimer   = null;
  }

  _send(obj) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    try {
      this._ws.send(JSON.stringify(obj));
    } catch (err) {
      console.error('[GeminiLive] Send failed:', err);
    }
  }
}
