// handTracker.js — SIGNAL gesture engine v2
// Single hand: spread fingers wide = zoom in, close fingers = zoom out.
//              Pinch (thumb+index together) + move hand = rotate the orb.
// Two hands:   Both detected simultaneously — handled as independent gesture inputs.
//              Either hand can rotate (pinch+move) or spread-zoom independently.
//              If both are pinched and moving, average their motion for rotation.
//
// Tuning vs v1:
//  - ROTATE_SPEED lowered from 5.5 → 1.8  (much slower, more controlled spin)
//  - SMOOTHING raised to 0.55              (more lag = smoother, less twitchy)
//  - DEAD_ZONE raised to 0.006             (absorbs more jitter before acting)
//  - MAX_DELTA lowered to 0.018            (tighter jump clamp)
//  - Zoom from finger spread (one hand), not two-hand pinch distance
//  - Two-hand support: each hand contributes independently

const WASM_CDN  = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// ── Landmark indices ─────────────────────────────────────────────────────────
const WRIST       = 0;
const THUMB_TIP   = 4;
const INDEX_TIP   = 8;
const MIDDLE_TIP  = 12;
const RING_TIP    = 16;
const PINKY_TIP   = 20;
const INDEX_MCP   = 5;
const MIDDLE_MCP  = 9;
const RING_MCP    = 13;
const PINKY_MCP   = 17;

// Palm anchor IDs — stable across all gestures (never move with fingers)
const PALM_IDS = [0, 5, 9, 13, 17];


// ── Pinch detection (thumb ↔ index) ───────────────────────────────────
const PINCH_ON  = 0.30;  // ratio below this → pinching
const PINCH_OFF = 0.44;  // ratio above this → released

// Spread thresholds — open hand ≈ 1.2–1.5, closed fist ≈ 0.5–0.7
const SPREAD_ZOOM_IN  = 1.15;  // fingers fairly open → zoom in
const SPREAD_ZOOM_OUT = 0.80;  // fingers fairly closed → zoom out

// ── Motion tracking parameters ─────────────────────────────────────────
const ROTATE_SPEED = 1.8;    // much slower than before (was 5.5)
const SMOOTHING    = 0.55;   // EMA alpha — lower = smoother but more lag
const DEAD_ZONE    = 0.006;  // normalized — suppresses micro-jitter
const MAX_DELTA    = 0.018;  // single-frame clamp — prevents jump artifacts
const ZOOM_SPEED   = 0.025;  // zoom amount per frame when spreading/closing

// ── Helpers ──────────────────────────────────────────────────────────────────
function palmCenter(lm) {
  let x = 0, y = 0;
  for (const id of PALM_IDS) { x += lm[id].x; y += lm[id].y; }
  return {
    x: 1 - x / PALM_IDS.length, // mirror x
    y:     y / PALM_IDS.length,
  };
}

function dist2d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Computes finger spread ratio for a single hand.
 * Returns the average distance of all 4 fingertips from the palm center,
 * normalized by hand scale (wrist→middleMCP).
 * All coordinates kept in raw (un-mirrored) landmark space for consistency.
 */
function fingerSpreadRatio(lm) {
  const handScale = dist2d(lm[WRIST], lm[MIDDLE_MCP]);
  if (handScale < 1e-6) return 1.0;

  // Palm centroid in raw (un-mirrored) coords
  let px = 0, py = 0;
  for (const id of PALM_IDS) { px += lm[id].x; py += lm[id].y; }
  px /= PALM_IDS.length;
  py /= PALM_IDS.length;
  const palmRaw = { x: px, y: py };

  const tips = [INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP];
  let totalDist = 0;
  for (const tip of tips) {
    totalDist += dist2d(lm[tip], palmRaw);
  }
  return (totalDist / tips.length) / handScale;
}


export class HandTracker {
  /**
   * @param {HTMLVideoElement} video
   * @param {HTMLCanvasElement} overlay
   * @param {{ onRotate: Function, onZoom: Function, onStatus: Function }} callbacks
   */
  constructor(video, overlay, callbacks) {
    this.video     = video;
    this.overlay   = overlay;
    this.callbacks = callbacks;

    this.landmarker    = null;
    this.stream        = null;
    this.rafId         = 0;
    this.running       = false;
    this.lastVideoTime = -1;

    // Per-hand state keyed by label ("Left" / "Right")
    this.handStates = new Map();
    this.lastStatus = { hands: 0, mode: "idle" };
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();

    const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks(WASM_CDN);
    const opts = {
      baseOptions:                { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode:                "VIDEO",
      numHands:                   2,
      minHandDetectionConfidence: 0.65,
      minHandPresenceConfidence:  0.65,
      minTrackingConfidence:      0.65,
    };

    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, opts);
    } catch {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        ...opts,
        baseOptions: { ...opts.baseOptions, delegate: "CPU" },
      });
    }

    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    if (this.landmarker) { this.landmarker.close(); this.landmarker = null; }
    if (this.stream)     { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.video.srcObject = null;
    this.handStates.clear();
    const ctx = this.overlay.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this._emitStatus({ hands: 0, mode: "idle" });
  }

  _loop() {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(() => this._loop());
    if (!this.landmarker || this.video.readyState < 2) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    const result = this.landmarker.detectForVideo(this.video, performance.now());
    this._processHands(
      result.landmarks,
      result.handedness.map(h => h[0]?.categoryName ?? "?"),
    );
    this._drawOverlay(result.landmarks, result.handedness.map(h => h[0]?.categoryName ?? "?"));
  }

  _processHands(landmarks, labels) {
    const seen = new Set();

    // ── Per-hand processing ───────────────────────────────────────────────────
    const handData = []; // { label, pinching, grab, spread }

    landmarks.forEach((lm, i) => {
      const label = labels[i];
      seen.add(label);

      const handScale  = dist2d(lm[WRIST], lm[MIDDLE_MCP]);
      if (handScale < 1e-6) return;

      const pinchRatio = dist2d(lm[THUMB_TIP], lm[INDEX_TIP]) / handScale;
      const spread     = fingerSpreadRatio(lm);
      const raw        = palmCenter(lm);

      let state = this.handStates.get(label);
      if (!state) {
        state = { pinching: false, grab: raw, prevGrab: null };
        this.handStates.set(label, state);
      }

      // Pinch hysteresis
      if ( state.pinching && pinchRatio > PINCH_OFF) state.pinching = false;
      if (!state.pinching && pinchRatio < PINCH_ON)  state.pinching = true;

      // EMA smoothing on palm centroid
      state.grab = {
        x: state.grab.x + (raw.x - state.grab.x) * SMOOTHING,
        y: state.grab.y + (raw.y - state.grab.y) * SMOOTHING,
      };

      handData.push({ label, pinching: state.pinching, grab: state.grab, spread, state });
    });

    // Drop state for hands that left frame
    for (const key of this.handStates.keys()) {
      if (!seen.has(key)) this.handStates.delete(key);
    }

    // ── Always use only the first detected hand, ignore any second hand ────────
    const numHands = handData.length;
    const h        = handData[0]; // primary hand only

    let mode = "idle";

    if (!h) {
      mode = "idle";
    } else if (h.pinching) {
      // Pinch + move → ROTATE
      mode = "spin";
      this._handleSpin([h]);
    } else {
      // Open hand: spread ratio controls zoom
      mode = this._handleSpread(h.spread);
    }

    this._emitStatus({ hands: numHands, mode });
  }

  /**
   * Spin the orb using the given set of pinched hands.
   * If multiple hands, uses their averaged position.
   */
  _handleSpin(pinched) {
    // Average grab position across all pinched hands
    let ax = 0, ay = 0;
    for (const h of pinched) { ax += h.grab.x; ay += h.grab.y; }
    ax /= pinched.length;
    ay /= pinched.length;

    // Use first hand's state for prevGrab tracking
    const state = pinched[0].state;

    if (state.prevGrab) {
      let dx = ax - state.prevGrab.x;
      let dy = ay - state.prevGrab.y;

      // Clamp jump artifacts
      dx = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, dx));
      dy = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, dy));

      if (Math.abs(dx) > DEAD_ZONE || Math.abs(dy) > DEAD_ZONE) {
        this.callbacks.onRotate(dx * ROTATE_SPEED, dy * ROTATE_SPEED);
      }
    }

    state.prevGrab = { x: ax, y: ay };

    // Reset prevGrab on non-pinched hands to avoid jump when they pinch later
    this.handStates.forEach((s, key) => {
      if (!pinched.find(h => h.label === key)) s.prevGrab = null;
    });
  }

  /**
   * Handle spread/close zoom for a single hand's spread ratio.
   * factor < 1 = camera moves IN  (zoom in)  — orbScene convention
   * factor > 1 = camera moves OUT (zoom out)
   */
  _handleSpread(spread) {
    if (spread > SPREAD_ZOOM_IN) {
      // Fingers wide → zoom IN (factor < 1 moves camera closer)
      const intensity = Math.min((spread - SPREAD_ZOOM_IN) / 0.4, 1.0);
      const factor = 1.0 - ZOOM_SPEED * intensity;  // e.g. 0.975
      this.callbacks.onZoom(Math.max(0.88, factor));
      return "zoom";
    } else if (spread < SPREAD_ZOOM_OUT) {
      // Fingers closed → zoom OUT (factor > 1 moves camera further)
      const intensity = Math.min((SPREAD_ZOOM_OUT - spread) / 0.3, 1.0);
      const factor = 1.0 + ZOOM_SPEED * intensity;  // e.g. 1.025
      this.callbacks.onZoom(Math.min(1.12, factor));
      return "zoom";
    }
    return "idle";
  }

  _emitStatus(status) {
    if (status.hands !== this.lastStatus.hands || status.mode !== this.lastStatus.mode) {
      this.lastStatus = status;
      this.callbacks.onStatus(status);
    }
  }

  _drawOverlay(landmarks, labels) {
    const ctx = this.overlay.getContext("2d");
    if (!ctx) return;
    const { width, height } = this.overlay;
    ctx.clearRect(0, 0, width, height);

    landmarks.forEach((lm, i) => {
      const handScale  = dist2d(lm[WRIST], lm[MIDDLE_MCP]);
      if (handScale < 1e-6) return;

      const pinchRatio = dist2d(lm[THUMB_TIP], lm[INDEX_TIP]) / handScale;
      const state      = this.handStates.get(labels[i]);
      const pinched    = state?.pinching ?? (pinchRatio < PINCH_ON);
      const spread     = fingerSpreadRatio(lm);
      const zooming    = !pinched && (spread > SPREAD_ZOOM_IN || spread < SPREAD_ZOOM_OUT);

      // ── Draw all fingertip dots ─────────────────────────────────────────────
      const tips = [THUMB_TIP, INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP];
      tips.forEach(tip => {
        const x = (1 - lm[tip].x) * width;
        const y = lm[tip].y * height;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = pinched
          ? "#b8f0ff"
          : zooming
            ? "#7fe8ff"
            : "rgba(127,232,255,0.5)";
        ctx.fill();
      });

      // ── Draw pinch line (thumb ↔ index) ─────────────────────────────────────
      const tx = (1 - lm[THUMB_TIP].x) * width,  ty = lm[THUMB_TIP].y * height;
      const ix = (1 - lm[INDEX_TIP].x) * width,   iy = lm[INDEX_TIP].y * height;
      ctx.strokeStyle = pinched ? "#b8f0ff" : "rgba(127,232,255,0.3)";
      ctx.lineWidth   = pinched ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(ix, iy);
      ctx.stroke();

      // ── Draw spread fan lines (fingertip → palm center) when zooming ─────────
      if (zooming) {
        const pc  = palmCenter(lm);
        const pcx = pc.x * width;
        const pcy = pc.y * height;
        const fanColor = spread > SPREAD_ZOOM_IN
          ? "rgba(77,232,200,0.35)"   // cyan-green = zoom in
          : "rgba(255,180,100,0.35)"; // amber = zoom out
        ctx.strokeStyle = fanColor;
        ctx.lineWidth   = 1;
        [INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP].forEach(tip => {
          const fx = (1 - lm[tip].x) * width;
          const fy = lm[tip].y * height;
          ctx.beginPath();
          ctx.moveTo(pcx, pcy);
          ctx.lineTo(fx, fy);
          ctx.stroke();
        });
        // Pulse circle at palm center
        ctx.beginPath();
        ctx.arc(pcx, pcy, 5, 0, Math.PI * 2);
        ctx.fillStyle = fanColor;
        ctx.fill();
      }

      // ── Palm centroid dot (tracking anchor) ──────────────────────────────────
      const pc  = palmCenter(lm);
      const pcx = pc.x * width;
      const pcy = pc.y * height;
      ctx.beginPath();
      ctx.arc(pcx, pcy, pinched ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = pinched
        ? "rgba(127,232,255,0.9)"
        : "rgba(77,184,255,0.4)";
      ctx.fill();
    });
  }
}
