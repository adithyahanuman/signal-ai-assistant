// handTracker.js — SIGNAL gesture engine v3
//
// Gesture map (single hand, first hand wins if two visible):
//
//   ZOOM:   Track thumb ↔ index distance over time.
//           Fingers opening apart  → zoom IN  (orb gets bigger)
//           Fingers closing together → zoom OUT (orb gets smaller)
//           (Like pinch-to-zoom on a phone, with one hand)
//
//   ROTATE: Move whole hand (palm centroid) while NOT zooming.
//           Slow, smooth, low sensitivity.

const WASM_CDN  = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// ── Landmark indices ──────────────────────────────────────────────────────────
const WRIST      = 0;
const THUMB_TIP  = 4;
const INDEX_TIP  = 8;
const MIDDLE_MCP = 9;
const PALM_IDS   = [0, 5, 9, 13, 17]; // wrist + all 4 MCPs (stable anchors)

// ── Zoom via pinch-distance delta ─────────────────────────────────────────────
// We track the normalized thumb↔index distance each frame.
// If it increases → fingers opening → zoom in.
// If it decreases → fingers closing → zoom out.
const ZOOM_DELTA_DEAD  = 0.008;  // min change in ratio per frame to act (kills jitter)
const ZOOM_SENSITIVITY = 12.0;   // multiplier: higher = faster zoom response
const ZOOM_MAX_FACTOR  = 0.06;   // max zoom step per frame (clamped)

// ── Rotation via palm motion ──────────────────────────────────────────────────
const ROTATE_SPEED = 1.6;   // multiplier on palm delta (was 5.5 — now much slower)
const SMOOTHING    = 0.50;  // EMA alpha on palm centroid (lower = smoother)
const DEAD_ZONE    = 0.007; // min palm delta to count as intentional motion
const MAX_DELTA    = 0.020; // single-frame clamp — prevents jump artifacts on lost frames

// ── Zoom/rotate mode switch ───────────────────────────────────────────────────
// If the pinch distance is actively changing we're zooming, not rotating.
// This prevents conflicting commands on the same gesture.
const ZOOM_LOCK_FRAMES = 4; // frames of no zoom change before rotation re-enables

// ── Helpers ───────────────────────────────────────────────────────────────────
function palmCenter(lm) {
  let x = 0, y = 0;
  for (const id of PALM_IDS) { x += lm[id].x; y += lm[id].y; }
  return {
    x: 1 - x / PALM_IDS.length, // mirror x so right-move = screen-right
    y:     y / PALM_IDS.length,
  };
}

function dist2d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Normalized pinch ratio: thumb↔index distance / hand scale (wrist→middleMCP). */
function pinchRatio(lm) {
  const scale = dist2d(lm[WRIST], lm[MIDDLE_MCP]);
  if (scale < 1e-6) return 0.5;
  return dist2d(lm[THUMB_TIP], lm[INDEX_TIP]) / scale;
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

    // Per-hand persistent state
    this.grab          = null;   // smoothed palm centroid
    this.prevPinch     = null;   // previous frame's pinch ratio
    this.zoomLock      = 0;      // countdown: frames until rotation re-enables
    this.lastStatus    = { hands: 0, mode: "idle" };
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
    this.grab = null;
    this.prevPinch = null;
    this.zoomLock = 0;
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
    this._processHands(result.landmarks);
    this._drawOverlay(result.landmarks);
  }

  _processHands(landmarks) {
    if (landmarks.length === 0) {
      // No hand — reset state
      this.grab      = null;
      this.prevPinch = null;
      this.zoomLock  = 0;
      this._emitStatus({ hands: 0, mode: "idle" });
      return;
    }

    // Always use only the FIRST detected hand
    const lm = landmarks[0];

    // ── 1. Compute this frame's pinch ratio ────────────────────────────────────
    const pr  = pinchRatio(lm);
    const raw = palmCenter(lm);

    // ── 2. Smooth palm centroid (EMA) ─────────────────────────────────────────
    if (!this.grab) {
      this.grab = { x: raw.x, y: raw.y };
    } else {
      this.grab.x += (raw.x - this.grab.x) * SMOOTHING;
      this.grab.y += (raw.y - this.grab.y) * SMOOTHING;
    }

    // ── 3. Zoom from pinch-distance delta ────────────────────────────────────
    // delta > 0 → fingers moved apart  → zoom IN  (factor < 1)
    // delta < 0 → fingers moved closer → zoom OUT (factor > 1)
    let mode = "idle";

    if (this.prevPinch !== null) {
      const delta = pr - this.prevPinch; // positive = opened, negative = closed

      if (Math.abs(delta) > ZOOM_DELTA_DEAD) {
        // Clamp step size
        const step   = Math.min(Math.abs(delta) * ZOOM_SENSITIVITY, ZOOM_MAX_FACTOR);
        // delta > 0 (opening) → zoom in → factor < 1
        // delta < 0 (closing) → zoom out → factor > 1
        const factor = delta > 0
          ? Math.max(1 - step, 0.88)   // zoom in: shrink distance to target
          : Math.min(1 + step, 1.12);  // zoom out: grow distance to target

        this.callbacks.onZoom(factor);
        this.zoomLock = ZOOM_LOCK_FRAMES;
        mode = "zoom";
      }
    }
    this.prevPinch = pr;

    // ── 4. Rotate from palm motion (only when not actively zooming) ───────────
    if (mode !== "zoom" && this.zoomLock <= 0) {
      // Compare smoothed grab to stored previous grab position
      if (this._prevGrab) {
        let dx = this.grab.x - this._prevGrab.x;
        let dy = this.grab.y - this._prevGrab.y;

        dx = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, dx));
        dy = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, dy));

        if (Math.abs(dx) > DEAD_ZONE || Math.abs(dy) > DEAD_ZONE) {
          this.callbacks.onRotate(dx * ROTATE_SPEED, dy * ROTATE_SPEED);
          mode = "spin";
        }
      }
    }

    if (this.zoomLock > 0) this.zoomLock--;
    this._prevGrab = { x: this.grab.x, y: this.grab.y };

    this._emitStatus({ hands: landmarks.length, mode });
  }

  _emitStatus(status) {
    if (status.hands !== this.lastStatus.hands || status.mode !== this.lastStatus.mode) {
      this.lastStatus = status;
      this.callbacks.onStatus(status);
    }
  }

  _drawOverlay(landmarks) {
    const ctx = this.overlay.getContext("2d");
    if (!ctx) return;
    const { width, height } = this.overlay;
    ctx.clearRect(0, 0, width, height);

    if (landmarks.length === 0) return;

    // Draw first hand only
    const lm = landmarks[0];
    const pr = pinchRatio(lm);

    const tx = (1 - lm[THUMB_TIP].x) * width,  ty = lm[THUMB_TIP].y * height;
    const ix = (1 - lm[INDEX_TIP].x) * width,   iy = lm[INDEX_TIP].y * height;

    // Color: cyan-green when opening (zoom in), amber when closing (zoom out), cyan default
    const delta = this.prevPinch !== null ? pr - this.prevPinch : 0;
    const isZooming = Math.abs(delta) > ZOOM_DELTA_DEAD;
    const lineColor = isZooming
      ? (delta > 0 ? "#66ffcc" : "#ffaa44")  // green=in, amber=out
      : "rgba(127,232,255,0.6)";

    // Line between thumb and index
    ctx.strokeStyle = lineColor;
    ctx.lineWidth   = isZooming ? 2.5 : 1.5;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(ix, iy);
    ctx.stroke();

    // Thumb dot
    ctx.beginPath();
    ctx.arc(tx, ty, isZooming ? 6 : 4, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();

    // Index dot
    ctx.beginPath();
    ctx.arc(ix, iy, isZooming ? 6 : 4, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();

    // Palm centroid (rotation anchor)
    if (this.grab) {
      ctx.beginPath();
      ctx.arc(this.grab.x * width, this.grab.y * height, 4, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(77,184,255,0.5)";
      ctx.fill();
    }
  }
}
