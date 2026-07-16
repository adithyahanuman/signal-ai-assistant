// handTracker.js — SIGNAL gesture engine v6
//
// ZOOM:   Track the smoothed thumb↔index distance each frame.
//         Fingers moving APART  → zoom in  (orb bigger)
//         Fingers moving TOGETHER → zoom out (orb smaller)
//         Fingers STILL → nothing (no drift, no auto-zoom)
//
// ROTATE: Track palm centroid movement.
//         Move hand in any direction → rotate orb.
//         Works independently of zoom — both can happen at once.

const WASM_CDN  = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// ── Landmark indices ──────────────────────────────────────────────────────────
const WRIST      = 0;
const THUMB_TIP  = 4;
const INDEX_TIP  = 8;
const MIDDLE_MCP = 9;
const PALM_IDS   = [0, 5, 9, 13, 17];

// ── Zoom (delta-based) ────────────────────────────────────────────────────────
const PINCH_SMOOTH   = 0.30;   // EMA on pinch distance (lower = smoother, less jitter)
const ZOOM_DEAD      = 0.006;  // min delta per frame to count as intentional movement
const ZOOM_SCALE     = 18.0;   // how strongly delta maps to zoom factor
const ZOOM_MAX_STEP  = 0.10;   // max zoom change per frame (clamped)

// ── Rotation (palm motion) ────────────────────────────────────────────────────
const PALM_SMOOTH    = 0.40;   // EMA on palm centroid
const ROTATE_DEAD    = 0.005;  // min palm movement per frame to count as intentional
const ROTATE_SCALE   = 2.2;    // rotation speed multiplier
const ROTATE_MAX     = 0.025;  // max delta per frame (clamp jump artifacts)

// ── Helpers ───────────────────────────────────────────────────────────────────
function palmCenter(lm) {
  let x = 0, y = 0;
  for (const id of PALM_IDS) { x += lm[id].x; y += lm[id].y; }
  return { x: 1 - x / PALM_IDS.length, y: y / PALM_IDS.length };
}

function dist2d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Normalized pinch distance: thumb↔index / hand scale
function rawPinch(lm) {
  const scale = dist2d(lm[WRIST], lm[MIDDLE_MCP]);
  return scale < 1e-6 ? 0.4 : dist2d(lm[THUMB_TIP], lm[INDEX_TIP]) / scale;
}


export class HandTracker {
  constructor(video, overlay, callbacks) {
    this.video     = video;
    this.overlay   = overlay;
    this.callbacks = callbacks;

    this.landmarker    = null;
    this.stream        = null;
    this.rafId         = 0;
    this.running       = false;
    this.lastVideoTime = -1;

    this._clear();
    this.lastStatus = { hands: 0, mode: "idle" };
  }

  _clear() {
    this.pinch     = null;   // smoothed pinch distance
    this.palm      = null;   // smoothed palm centroid
    this.prevPalm  = null;
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
        ...opts, baseOptions: { ...opts.baseOptions, delegate: "CPU" },
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
    this._clear();
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
    this._process(result.landmarks);
    this._draw(result.landmarks);
  }

  _process(landmarks) {
    if (landmarks.length === 0) {
      this._clear();
      this._emitStatus({ hands: 0, mode: "idle" });
      return;
    }

    const lm = landmarks[0]; // first hand only

    // ── 1. Smooth pinch distance ─────────────────────────────────────────────
    const rp = rawPinch(lm);
    const prevPinch = this.pinch;
    this.pinch = this.pinch === null
      ? rp
      : this.pinch + (rp - this.pinch) * PINCH_SMOOTH;

    // ── 2. Smooth palm centroid ──────────────────────────────────────────────
    const rawPalm = palmCenter(lm);
    this.prevPalm = this.palm ? { ...this.palm } : null;
    this.palm = this.palm === null
      ? rawPalm
      : { x: this.palm.x + (rawPalm.x - this.palm.x) * PALM_SMOOTH,
          y: this.palm.y + (rawPalm.y - this.palm.y) * PALM_SMOOTH };

    let mode = "idle";

    // ── 3. ZOOM from pinch delta ─────────────────────────────────────────────
    // Only fires when fingers are actively moving, not when held still.
    if (prevPinch !== null) {
      const delta = this.pinch - prevPinch;  // +ve = apart = zoom in, -ve = together = zoom out

      if (Math.abs(delta) > ZOOM_DEAD) {
        // Scale delta to a zoom step, clamped to max
        const step = Math.min(Math.abs(delta) * ZOOM_SCALE, ZOOM_MAX_STEP);
        // delta > 0 (fingers opening) → factor < 1 → zoom in (camera closer = orb bigger)
        // delta < 0 (fingers closing) → factor > 1 → zoom out (camera further = orb smaller)
        const factor = delta > 0
          ? Math.max(1.0 - step, 0.85)
          : Math.min(1.0 + step, 1.15);
        this.callbacks.onZoom(factor);
        mode = delta > 0 ? "zoom-in" : "zoom-out";
      }
    }

    // ── 4. ROTATE from palm motion ───────────────────────────────────────────
    // Independent of zoom — works at the same time.
    if (this.prevPalm) {
      let dx = this.palm.x - this.prevPalm.x;
      let dy = this.palm.y - this.prevPalm.y;

      // Clamp jump artifacts (dropped detection frames)
      dx = Math.max(-ROTATE_MAX, Math.min(ROTATE_MAX, dx));
      dy = Math.max(-ROTATE_MAX, Math.min(ROTATE_MAX, dy));

      if (Math.abs(dx) > ROTATE_DEAD || Math.abs(dy) > ROTATE_DEAD) {
        this.callbacks.onRotate(dx * ROTATE_SCALE, dy * ROTATE_SCALE);
        if (mode === "idle") mode = "spin";
      }
    }

    this._emitStatus({ hands: landmarks.length, mode });
  }

  _emitStatus(s) {
    if (s.hands !== this.lastStatus.hands || s.mode !== this.lastStatus.mode) {
      this.lastStatus = s;
      this.callbacks.onStatus(s);
    }
  }

  _draw(landmarks) {
    const ctx = this.overlay.getContext("2d");
    if (!ctx) return;
    const { width, height } = this.overlay;
    ctx.clearRect(0, 0, width, height);
    if (!landmarks.length) return;

    const lm = landmarks[0];
    const tx = (1 - lm[THUMB_TIP].x) * width,  ty = lm[THUMB_TIP].y * height;
    const ix = (1 - lm[INDEX_TIP].x) * width,   iy = lm[INDEX_TIP].y * height;

    // Color based on mode
    const m = this.lastStatus.mode;
    const color = m === "zoom-in"  ? "#66ffcc"
                : m === "zoom-out" ? "#ffaa44"
                : m === "spin"     ? "#7fe8ff"
                :                    "rgba(127,232,255,0.4)";
    const active = m !== "idle";

    // Thumb ↔ index line
    ctx.strokeStyle = color;
    ctx.lineWidth   = active ? 2.5 : 1.5;
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(ix, iy); ctx.stroke();

    // Thumb dot
    ctx.beginPath(); ctx.arc(tx, ty, active ? 7 : 4, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();

    // Index dot
    ctx.beginPath(); ctx.arc(ix, iy, active ? 7 : 4, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();

    // Palm centroid dot
    if (this.palm) {
      ctx.beginPath();
      ctx.arc(this.palm.x * width, this.palm.y * height, 5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(77,184,255,0.5)";
      ctx.fill();
    }
  }
}
