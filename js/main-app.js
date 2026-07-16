// main-app.js — App page: full SIGNAL orb + live hand tracking

import { createOrbScene } from './orbScene.js';
import { HandTracker }    from './handTracker.js';

const MODE_LABEL = { idle: 'STANDBY', spin: 'SPIN', zoom: 'ZOOM' };

window.addEventListener('DOMContentLoaded', init);

function init() {
  const container = document.getElementById('app-orb-container');
  if (!container) { console.error('[SIGNAL] #app-orb-container not found'); return; }

  // Full interactive orb with OrbitControls
  const scene = createOrbScene(container, { interactive: true });

  // ── Hand-tracking state ──────────────────────────────────────────────────
  const videoEl    = document.getElementById('camera-video');
  const overlayEl  = document.getElementById('camera-overlay');
  const gestureBtn = document.getElementById('gesture-btn');
  const cameraPanel = document.getElementById('camera-panel');
  const statusEl   = document.getElementById('camera-status');
  const errorEl    = document.getElementById('hud-error');
  const modeLabelEl = document.getElementById('mode-label');

  let tracker     = null;
  let cameraState = 'off'; // 'off' | 'starting' | 'on' | 'error'

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

  function updateStatus(status) {
    if (modeLabelEl) modeLabelEl.textContent = MODE_LABEL[status.mode] || 'STANDBY';
    if (statusEl) {
      statusEl.textContent = status.hands > 0
        ? `${status.hands} HAND${status.hands > 1 ? 'S' : ''} · ${MODE_LABEL[status.mode]}`
        : 'SHOW HANDS';
    }
  }

  async function startGestures() {
    if (tracker || !videoEl || !overlayEl) return;
    setCameraState('starting');
    if (errorEl) errorEl.textContent = '';

    tracker = new HandTracker(videoEl, overlayEl, {
      onRotate: (dt, dp) => scene.rotateBy(dt, dp),
      onZoom:   (factor) => scene.zoomBy(factor),
      onStatus: updateStatus,
    });

    try {
      await tracker.start();
      setCameraState('on');
    } catch (err) {
      tracker = null;
      setCameraState('error');
      if (errorEl) {
        errorEl.textContent =
          (err instanceof DOMException && err.name === 'NotAllowedError')
            ? 'CAMERA ACCESS DENIED'
            : 'TRACKING INIT FAILED';
      }
    }
  }

  function stopGestures() {
    if (tracker) { tracker.stop(); tracker = null; }
    setCameraState('off');
    updateStatus({ hands: 0, mode: 'idle' });
  }

  function toggleGestures() {
    if (tracker) stopGestures(); else void startGestures();
  }

  // Buttons
  if (gestureBtn) gestureBtn.addEventListener('click', toggleGestures);
  document.getElementById('zoom-in-btn')?.addEventListener('click',  () => scene.zoomIn());
  document.getElementById('zoom-out-btn')?.addEventListener('click', () => scene.zoomOut());
  document.getElementById('reset-btn')?.addEventListener('click',    () => scene.resetView());

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    switch (e.key) {
      case '+': case '=': scene.zoomIn();    break;
      case '-': case '_': scene.zoomOut();   break;
      case 'r': case 'R': scene.resetView(); break;
      case 'g': case 'G': toggleGestures();  break;
    }
  });
}
