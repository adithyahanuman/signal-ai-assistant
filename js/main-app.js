// main-app.js — App page: full SIGNAL orb + hand tracking + Gemini Live voice/text
//
// Wires together:
//   • Three.js orb (orbScene.js)
//   • Hand gesture tracking (handTracker.js)
//   • Gemini Live WebSocket session (geminiLive.js)
//   • Mic capture via AudioWorklet (audioCapture.js)
//   • Audio playback via AudioWorklet (audioPlayback.js)

import { createOrbScene } from './orbScene.js';
import { HandTracker }    from './handTracker.js';
import { GeminiLiveClient } from './geminiLive.js';
import { AudioCapture }   from './audioCapture.js';
import { AudioPlayback }  from './audioPlayback.js';

// ── Configuration ──────────────────────────────────────────────────────────
// TOKEN_URL points at the local Node server running on this machine.
// To switch to the Cloudflare Worker (production), set:
//   window.SIGNAL_TOKEN_URL = 'https://signal-token-service.YOUR-SUBDOMAIN.workers.dev/api/token'
// before the page loads, or update this string directly.
const CONFIG = {
  TOKEN_URL: window.SIGNAL_TOKEN_URL || 'http://localhost:3001/api/token',
};

// ── Mode labels ────────────────────────────────────────────────────────────
const CONV_LABELS = {
  idle:      'STANDBY',
  listening: 'LISTENING',
  thinking:  'PROCESSING',
  speaking:  'SPEAKING',
};
const GESTURE_LABELS = { idle: 'STANDBY', spin: 'SPIN', zoom: 'ZOOM' };

window.addEventListener('DOMContentLoaded', init);

function init() {
  // ── DOM refs ──────────────────────────────────────────────────────────
  const container      = document.getElementById('app-orb-container');
  if (!container) { console.error('[SIGNAL] #app-orb-container not found'); return; }

  const videoEl        = document.getElementById('camera-video');
  const overlayEl      = document.getElementById('camera-overlay');
  const gestureBtn     = document.getElementById('gesture-btn');
  const cameraPanel    = document.getElementById('camera-panel');
  const cameraStatus   = document.getElementById('camera-status');
  const errorEl        = document.getElementById('hud-error');
  const modeLabelEl    = document.getElementById('mode-label');
  const convStatusEl   = document.getElementById('conv-status');
  const micBtn         = document.getElementById('mic-btn');
  const textToggleBtn  = document.getElementById('text-toggle-btn');
  const textInputRow   = document.getElementById('text-input-row');
  const textInput      = document.getElementById('text-input');
  const textSendBtn    = document.getElementById('text-send-btn');
  const subtitleBar    = document.getElementById('subtitle-bar');
  const subtitleText   = document.getElementById('subtitle-text');
  const chatPanel      = document.getElementById('chat-panel');

  // ── Orb scene ─────────────────────────────────────────────────────────
  const scene = createOrbScene(container, { interactive: true });

  // ── State ─────────────────────────────────────────────────────────────
  let convState       = 'idle';   // 'idle' | 'listening' | 'thinking' | 'speaking'
  let cameraState     = 'off';    // 'off' | 'starting' | 'on' | 'error'
  let tracker         = null;
  let micCapturing    = false;    // true when AudioCapture is actively streaming
  let sessionReady    = false;    // true once Gemini WS setupComplete received
  let ampPollId       = null;     // setInterval id for amplitude polling
  let subtitleTimer   = null;     // timeout to hide subtitle after turn ends
  let currentAiMsg    = null;     // current AI chat bubble being built

  // ── Audio modules (created lazily on first user gesture) ─────────────
  const capture  = new AudioCapture({
    onChunk:            (buf) => gemini.sendAudioChunk(buf),
    onPermissionDenied: ()    => showError('MIC ACCESS DENIED'),
    onError:            (err) => showError('MIC ERROR: ' + err.message),
  });

  const playback = new AudioPlayback();
  playback.onSpeakingChange = (isSpeaking) => {
    if (!isSpeaking && convState === 'speaking') {
      setConvState('idle');
    }
  };

  // ── Gemini Live client ─────────────────────────────────────────────
  const gemini = new GeminiLiveClient({
    tokenUrl: CONFIG.TOKEN_URL,

    onSessionOpen: () => {
      sessionReady = true;
      clearError();
      console.log('[SIGNAL] Session open');
    },

    onModelTurnStart: () => {
      // Barge-in: if old audio is still playing, cut it off immediately
      playback.flush();
      setConvState('speaking');
      // Start a new AI chat bubble
      currentAiMsg = null;
    },

    onAudioChunk: (buffer) => {
      // Ensure playback context is running (may be suspended after tab blur)
      playback.resume();
      playback.enqueue(buffer);
      setConvState('speaking');
    },

    onTranscript: (text) => {
      // Show subtitle bar
      if (subtitleText) subtitleText.textContent = text;
      if (subtitleBar)  subtitleBar.classList.add('visible');
      clearTimeout(subtitleTimer);

      // Append to / create AI chat bubble
      if (chatPanel) {
        if (!currentAiMsg) {
          currentAiMsg = document.createElement('div');
          currentAiMsg.className = 'chat-msg ai';
          chatPanel.appendChild(currentAiMsg);
        }
        currentAiMsg.textContent = (currentAiMsg.textContent || '') + text;
        chatPanel.scrollTop = chatPanel.scrollHeight;
      }
    },

    onTurnComplete: () => {
      // Keep 'speaking' until the ring buffer drains (onSpeakingChange handles idle)
      if (!playback.isSpeaking) setConvState('idle');
      // Hide subtitle after a short delay so user can finish reading
      clearTimeout(subtitleTimer);
      subtitleTimer = setTimeout(() => {
        if (subtitleBar) subtitleBar.classList.remove('visible');
      }, 3500);
      currentAiMsg = null;
    },

    onError: (err) => {
      showError('SIGNAL ERROR: ' + err.message);
      setConvState('idle');
    },

    onSessionClose: ({ reason, willReconnect }) => {
      sessionReady = false;
      if (reason === 'session_cap') {
        showError('SESSION LIMIT REACHED — CLICK MIC TO RECONNECT');
        setConvState('idle');
        stopMic();
        setMicBtn(false);
      } else if (!willReconnect) {
        setConvState('idle');
      }
    },
  });

  // ── Amplitude polling (orb pulse sync while speaking) ─────────────────
  function startAmpPoll() {
    if (ampPollId !== null) return;
    ampPollId = setInterval(() => {
      if (convState === 'speaking') {
        scene.setConversationState('speaking', playback.amplitude);
      }
    }, 80); // ~12 fps — enough for smooth orb pulse without thrashing
  }

  function stopAmpPoll() {
    if (ampPollId !== null) {
      clearInterval(ampPollId);
      ampPollId = null;
    }
  }

  // ── Conversation state management ─────────────────────────────────────
  function setConvState(state) {
    convState = state;
    scene.setConversationState(state, state === 'speaking' ? playback.amplitude : 0);
    if (modeLabelEl)   modeLabelEl.textContent  = CONV_LABELS[state] || 'STANDBY';
    if (convStatusEl) {
      convStatusEl.textContent  = CONV_LABELS[state] || '';
      convStatusEl.className    = state === 'idle' ? '' : state;
    }
    if (state === 'speaking') {
      startAmpPoll();
    } else {
      stopAmpPoll();
    }
  }

  // ── Error display (reuses existing #hud-error element) ────────────────
  function showError(msg) {
    if (errorEl) errorEl.textContent = msg;
  }
  function clearError() {
    if (errorEl) errorEl.textContent = '';
  }

  // ── Mic button state ──────────────────────────────────────────────────
  function setMicBtn(on) {
    if (!micBtn) return;
    micBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    micBtn.title = on ? 'Stop mic (M)' : 'Start mic (M)';
  }

  // ── Start microphone (opens session first if needed) ──────────────────
  async function startMic() {
    if (micCapturing) return;

    // Initialise playback on the first user gesture (browser policy)
    if (!playback.isReady) {
      try { await playback.init(); }
      catch (err) { showError('AUDIO OUTPUT FAILED: ' + err.message); return; }
    }

    // Connect to Gemini if not already connected
    if (!sessionReady) {
      await gemini.connect();
      // connect() is async but onSessionOpen fires via WS callback.
      // We wait up to 5 s for session to be ready before starting capture.
      const timeout = 5000;
      const step    = 100;
      let   waited  = 0;
      while (!sessionReady && waited < timeout) {
        await new Promise(r => setTimeout(r, step));
        waited += step;
      }
      if (!sessionReady) {
        showError('SESSION CONNECT TIMEOUT — TRY AGAIN');
        return;
      }
    }

    // Start mic capture
    try {
      await capture.start();
      micCapturing = true;
      setMicBtn(true);
      setConvState('listening');
      clearError();
    } catch (_) {
      // Error already reported via capture.onPermissionDenied / onError
      setConvState('idle');
    }
  }

  function stopMic() {
    if (!micCapturing) return;
    capture.stop();
    micCapturing = false;
    setMicBtn(false);
    if (convState === 'listening') setConvState('idle');
  }

  async function toggleMic() {
    if (micCapturing) {
      stopMic();
    } else {
      await startMic();
    }
  }

  // ── Text input toggle ─────────────────────────────────────────────────
  function setTextVisible(on) {
    textVisible = on;
    if (textInputRow) textInputRow.classList.toggle('visible', on);
    if (textToggleBtn) textToggleBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on && textInput) {
      textInput.focus();
    }
  }

  function toggleTextInput() {
    setTextVisible(!textVisible);
  }

  // ── Send a text message ───────────────────────────────────────────────
  async function sendText() {
    const text = textInput?.value?.trim();
    if (!text) return;

    // Initialise playback on first user gesture
    if (!playback.isReady) {
      try { await playback.init(); }
      catch (err) { showError('AUDIO OUTPUT FAILED: ' + err.message); return; }
    }

    // Open session if not already connected
    if (!sessionReady) {
      setConvState('thinking');
      await gemini.connect();
      const timeout = 5000;
      const step    = 100;
      let   waited  = 0;
      while (!sessionReady && waited < timeout) {
        await new Promise(r => setTimeout(r, step));
        waited += step;
      }
      if (!sessionReady) {
        showError('SESSION CONNECT TIMEOUT — TRY AGAIN');
        setConvState('idle');
        return;
      }
    }

    // Temporarily pause mic capture so audio and text don't collide on same turn
    const wasCapturing = micCapturing;
    if (wasCapturing) capture.mute();

    // Add user message to chat panel
    if (chatPanel) {
      const bubble = document.createElement('div');
      bubble.className = 'chat-msg user';
      bubble.textContent = text;
      chatPanel.appendChild(bubble);
      chatPanel.scrollTop = chatPanel.scrollHeight;
    }

    // Send the text turn
    gemini.sendTextMessage(text);

    // Clear input and give keyboard focus back to the orb (so shortcuts work)
    textInput.value = '';
    textInput.blur();

    setConvState('thinking');

    // Resume mic after a brief moment (time for the model to start responding)
    if (wasCapturing) {
      setTimeout(() => {
        if (micCapturing) capture.unmute();
      }, 500);
    }
  }

  // ── HUD button wiring ─────────────────────────────────────────────────
  if (micBtn)        micBtn.addEventListener('click',        () => void toggleMic());
  if (textToggleBtn) textToggleBtn.addEventListener('click', () => toggleTextInput());
  if (textSendBtn)   textSendBtn.addEventListener('click',   () => void sendText());

  if (textInput) {
    textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void sendText(); }
      // Stop all other keydown events from bubbling to the orb shortcuts
      // while the text input is focused
      e.stopPropagation();
    });
  }

  document.getElementById('zoom-in-btn')?.addEventListener('click',  () => scene.zoomIn());
  document.getElementById('zoom-out-btn')?.addEventListener('click', () => scene.zoomOut());
  document.getElementById('reset-btn')?.addEventListener('click',    () => scene.resetView());

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  window.addEventListener('keydown', (e) => {
    // Don't steal shortcuts while typing in the text input
    if (document.activeElement === textInput) return;

    switch (e.key) {
      case '+': case '=': scene.zoomIn();    break;
      case '-': case '_': scene.zoomOut();   break;
      case 'r': case 'R': scene.resetView(); break;
      case 'g': case 'G': toggleGestures();  break;
      case 'm': case 'M': void toggleMic();  break;
      case 't': case 'T': toggleTextInput(); break;
    }
  });

  // ── Hand-tracking (unchanged from original) ───────────────────────────
  function setCameraState(s) {
    cameraState = s;
    if (gestureBtn) {
      gestureBtn.disabled = s === 'starting';
      gestureBtn.setAttribute('aria-pressed', s === 'on' ? 'true' : 'false');
      gestureBtn.textContent =
        s === 'starting' ? 'INITIALIZING…' :
        s === 'on'       ? 'GESTURES ON'   : 'GESTURES OFF';
    }
    if (cameraPanel) cameraPanel.classList.toggle('visible', s === 'on');
  }

  function updateGestureStatus(status) {
    // Only update mode label if not in a voice conversation state
    if (convState === 'idle' && modeLabelEl) {
      modeLabelEl.textContent = GESTURE_LABELS[status.mode] || 'STANDBY';
    }
    if (cameraStatus) {
      cameraStatus.textContent = status.hands > 0
        ? `${status.hands} HAND${status.hands > 1 ? 'S' : ''} · ${GESTURE_LABELS[status.mode]}`
        : 'SHOW HANDS';
    }
  }

  async function startGestures() {
    if (tracker || !videoEl || !overlayEl) return;
    setCameraState('starting');
    clearError();

    tracker = new HandTracker(videoEl, overlayEl, {
      onRotate: (dt, dp) => scene.rotateBy(dt, dp),
      onZoom:   (factor) => scene.zoomBy(factor),
      onStatus: updateGestureStatus,
    });

    try {
      await tracker.start();
      setCameraState('on');
    } catch (err) {
      tracker = null;
      setCameraState('error');
      showError(
        (err instanceof DOMException && err.name === 'NotAllowedError')
          ? 'CAMERA ACCESS DENIED'
          : 'TRACKING INIT FAILED'
      );
    }
  }

  function stopGestures() {
    if (tracker) { tracker.stop(); tracker = null; }
    setCameraState('off');
    updateGestureStatus({ hands: 0, mode: 'idle' });
  }

  function toggleGestures() {
    if (tracker) stopGestures(); else void startGestures();
  }

  if (gestureBtn) gestureBtn.addEventListener('click', toggleGestures);
}
