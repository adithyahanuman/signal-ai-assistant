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
// response_modalities: ["AUDIO"] — voice-only output; typed text from the user
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

const GEMINI_MODEL = 'models/gemini-2.5-flash-native-audio';
const SIGNAL_VOICE = 'Aoede';

// WebSocket endpoint using ephemeral token (v1alpha, constrained)
const WS_ENDPOINT  =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage' +
  '.v1alpha.GenerativeService.BidiGenerateContentConstrained';

// Audio-only session cap is 15 minutes. Warn at 14:30 and close cleanly.
const SESSION_CAP_MS      = 15 * 60 * 1000;
const SESSION_WARN_MS     = 14.5 * 60 * 1000;

// Reconnect backoff config (exponential, seconds)
const BACKOFF_BASE_MS     = 1000;
const BACKOFF_MAX_MS      = 30_000;
const BACKOFF_MULTIPLIER  = 2;

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
   * @param {string}   opts.tokenUrl        — Backend URL for GET /api/token
   * @param {Function} [opts.onSessionOpen]     — () => void
   * @param {Function} [opts.onModelTurnStart]  — () => void  (barge-in trigger)
   * @param {Function} [opts.onAudioChunk]      — (ArrayBuffer) => void
   * @param {Function} [opts.onTurnComplete]    — () => void
   * @param {Function} [opts.onError]           — (Error) => void
   * @param {Function} [opts.onSessionClose]    — ({ reason: string, willReconnect: bool }) => void
   *   reason: 'clean' | 'session_cap' | 'error' | 'network'
   */
  constructor({
    tokenUrl,
    onSessionOpen    = () => {},
    onModelTurnStart = () => {},
    onAudioChunk     = () => {},
    onTurnComplete   = () => {},
    onError          = () => {},
    onSessionClose   = () => {},
  } = {}) {
    this._tokenUrl        = tokenUrl;
    this.onSessionOpen    = onSessionOpen;
    this.onModelTurnStart = onModelTurnStart;
    this.onAudioChunk     = onAudioChunk;
    this.onTurnComplete   = onTurnComplete;
    this.onError          = onError;
    this.onSessionClose   = onSessionClose;

    this._ws             = null;
    this._intentionalClose = false;
    this._connected      = false;
    this._backoffMs      = BACKOFF_BASE_MS;
    this._reconnectTimer = null;
    this._sessionTimer   = null;
    this._sessionWarnTimer = null;
    this._inModelTurn    = false; // track whether we're mid-response
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Fetch an ephemeral token and open the Gemini Live WebSocket session.
   * Safe to call multiple times — will no-op if already connected.
   */
  async connect() {
    if (this._connected || this._ws) return;

    let token;
    try {
      token = await this._fetchToken();
    } catch (err) {
      this.onError(new Error(`Token fetch failed: ${err.message}`));
      return;
    }

    this._openWebSocket(token);
  }

  /**
   * Stream a PCM16 audio chunk (from audioCapture) to the live session.
   * @param {ArrayBuffer} int16Buffer
   */
  sendAudioChunk(int16Buffer) {
    if (!this._connected) return;
    const b64 = arrayBufferToBase64(int16Buffer);
    this._send({
      realtime_input: {
        media_chunks: [{
          mime_type: 'audio/pcm;rate=16000',
          data:       b64,
        }],
      },
    });
  }

  /**
   * Send a typed message as a complete conversational turn.
   * The session's response_modalities is AUDIO, so the reply is always spoken.
   * @param {string} text
   */
  sendTextMessage(text) {
    if (!this._connected) return;
    this._send({
      client_content: {
        turns: [{
          role:  'user',
          parts: [{ text }],
        }],
        turn_complete: true,
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
  // To add live video: capture video frames (e.g., from getUserMedia video
  // track), encode as JPEG, base64-encode, and call this method.
  // The existing WebSocket session supports audio + video concurrently —
  // no session refactoring is needed.
  //
  // sendVideoChunk(base64Jpeg) {
  //   if (!this._connected) return;
  //   this._send({
  //     realtime_input: {
  //       media_chunks: [{
  //         mime_type: 'image/jpeg',
  //         data: base64Jpeg,
  //       }],
  //     },
  //   });
  // }

  // ── Private ───────────────────────────────────────────────────────────

  async _fetchToken() {
    const resp = await fetch(this._tokenUrl, { cache: 'no-store' });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (!data.token) throw new Error('No token in response');
    return data.token;
  }

  _openWebSocket(token) {
    const url = `${WS_ENDPOINT}?access_token=${encodeURIComponent(token)}`;
    this._ws  = new WebSocket(url);

    this._ws.onopen = () => {
      // Send the setup handshake immediately on open
      this._send({
        setup: {
          model: GEMINI_MODEL,
          generation_config: {
            response_modalities:    ['AUDIO'],
            // Enable output transcription so a captions layer can be added
            // later without requiring a new session. Not displayed in UI now.
            enable_affective_dialog: true,
          },
          output_audio_transcription: {},
          system_instruction: {
            parts: [{ text: SYSTEM_INSTRUCTION }],
          },
          speech_config: {
            voice_config: {
              prebuilt_voice_config: { voice_name: SIGNAL_VOICE },
            },
          },
        },
      });
      // onSessionOpen is fired after server sends setupComplete
    };

    this._ws.onmessage = (evt) => {
      this._handleMessage(evt.data);
    };

    this._ws.onerror = (evt) => {
      console.error('[GeminiLive] WebSocket error', evt);
      this.onError(new Error('WebSocket error'));
    };

    this._ws.onclose = (evt) => {
      this._connected = false;
      this._ws        = null;
      this._clearTimers();

      if (this._intentionalClose) {
        this.onSessionClose({ reason: 'clean', willReconnect: false });
        return;
      }

      // Unexpected close — attempt reconnect with backoff
      console.warn(`[GeminiLive] Closed unexpectedly (code ${evt.code}). Reconnecting in ${this._backoffMs}ms`);
      this.onSessionClose({ reason: 'network', willReconnect: true });
      this._scheduleReconnect();
    };
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(new TextDecoder().decode(raw));
    } catch (err) {
      console.warn('[GeminiLive] Could not parse message', err);
      return;
    }

    // ── Setup complete ──────────────────────────────────────────────────
    if (msg.setup_complete !== undefined) {
      this._connected  = true;
      this._backoffMs  = BACKOFF_BASE_MS; // reset backoff on successful connect
      this._intentionalClose = false;
      this._startSessionTimers();
      this.onSessionOpen();
      return;
    }

    // ── Server content (model response) ────────────────────────────────
    if (msg.server_content) {
      const sc = msg.server_content;

      // Model turn start: fire barge-in event so old audio gets flushed
      if (sc.model_turn && !this._inModelTurn) {
        this._inModelTurn = true;
        this.onModelTurnStart();
      }

      // Audio chunks in the model turn
      if (sc.model_turn?.parts) {
        for (const part of sc.model_turn.parts) {
          if (part.inline_data?.mime_type?.startsWith('audio/pcm')) {
            const buffer = base64ToArrayBuffer(part.inline_data.data);
            this.onAudioChunk(buffer);
          }
        }
      }

      // Turn complete
      if (sc.turn_complete) {
        this._inModelTurn = false;
        this.onTurnComplete();
      }

      return;
    }

    // ── Tool / error frames ─────────────────────────────────────────────
    if (msg.error) {
      console.error('[GeminiLive] Server error:', msg.error);
      this.onError(new Error(msg.error.message || 'Unknown server error'));
    }
  }

  _startSessionTimers() {
    this._clearTimers();

    // Warn close to the 15-minute audio-only session cap
    this._sessionWarnTimer = setTimeout(() => {
      console.warn('[GeminiLive] Approaching 15-minute session cap');
      this.onSessionClose({ reason: 'session_cap', willReconnect: false });
      // Clean disconnect; the UI layer decides whether to auto-reconnect
      this.disconnect();
    }, SESSION_WARN_MS);
  }

  _scheduleReconnect() {
    this._reconnectTimer = setTimeout(async () => {
      if (this._intentionalClose) return;
      console.log(`[GeminiLive] Reconnecting…`);
      this._backoffMs = Math.min(this._backoffMs * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
      await this.connect();
    }, this._backoffMs);
  }

  _clearTimers() {
    clearTimeout(this._sessionTimer);
    clearTimeout(this._sessionWarnTimer);
    clearTimeout(this._reconnectTimer);
    this._sessionTimer     = null;
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
