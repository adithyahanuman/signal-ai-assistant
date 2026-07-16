// handTracker.js — SIGNAL gesture engine v4
//
// ZOOM:   Pinch ratio (thumb↔index distance) tracked over a short window.
//         If consistently INCREASING over last N frames → fire one zoom-in step.
//         If consistently DECREASING over last N frames → fire one zoom-out step.
//         Holds still? Nothing fires. Jitter? Nothing fires.
//         Works like a button: one deliberate open = one zoom in.
//
// ROTATE: Palm centroid motion (when no zoom is firing).

const WASM_CDN  = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// ── Landmark indices ──────────────────────────────────────────────────────────
const WRIST      = 0;
const THUMB_TIP  = 4;
const INDEX_TIP  = 8;
const MIDDLE_MCP = 9;
const PALM_IDS   = [0, 5, 9, 13, 17];

// ── Zoom gesture config ───────────────────────────────────────────────────────
const TREND_WINDOW      = 5;     // frames to confirm a consistent direction
const TREND_MIN_CHANGE  = 0.018; // total ratio change needed across the window
const ZOOM_STEP         = 0.92;  // how much to zoom per confirmed gesture (< 1 = in, > 1 = out)
const ZOOM_COOLDOWN     = 12;    // frames to wait after each zoom fire before next

// ── Rotation config ───────────────────────────────────────────────────────────
const ROTATE_SPEED = 1.6;
const SMOOTHING    = 0.50;
const DEAD_ZONE    = 0.007;
const MAX_DELTA    = 0.020;

// ── Helpers ───────────────────────────────────────────────────────────────────
function palmCenter(lm) {
  let x = 0, y = 0;
  for (const id of PALM_IDS) { x += lm[id].x; y += lm[id].y; }
  return { x: 1 - x / PALM_IDS.length, y: y / PALM_IDS.length };
}

function dist2d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getPinchRatio(lm) {
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

    this._reset();
    this.lastStatus = { hands: 0, mode: "idle" };
  }

  _reset() {
    this.grab         = null;   // smoothed palm centroid
    this._prevGrab    = null;
    this.pinchHistory = [];     // rolling window of pinch ratios
    this.zoomCooldown = 0;      // frames until zoom can fire again
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
    this._reset();
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
      this._reset();
      this._emitStatus({ hands: 0, mode: "idle" });
      return;
    }

    // Always use first detected hand only
    const lm = landmarks[0];
    const pr  = getPinchRatio(lm);
    const raw = palmCenter(lm);

    // ── Smooth palm centroid ───────────────────────────────────────────────────
    if (!this.grab) {
      this.grab = { x: raw.x, y: raw.y };
    } else {
      this.grab.x += (raw.x - this.grab.x) * SMOOTHING;
      this.grab.y += (raw.y - this.grab.y) * SMOOTHING;
    }

    // ── Rolling pinch history window ──────────────────────────────────────────
    this.pinchHistory.push(pr);
    if (this.pinchHistory.length > TREND_WINDOW) {
      this.pinchHistory.shift();
    }

    // ── Zoom: fire only when trend is consistent across the whole window ───────
    let mode = "idle";
    if (this.zoomCooldown > 0) {
      this.zoomCooldown--;
    }

    if (this.pinchHistory.length === TREND_WINDOW && this.zoomCooldown === 0) {
      const oldest = this.pinchHistory[0];
      const newest = this.pinchHistory[TREND_WINDOW - 1];
      const totalChange = newest - oldest;

      // Check that ALL consecutive pairs move in the same direction (no reversals)
      let consistent = true;
      for (let i = 1; i < this.pinchHistory.length; i++) {
        const step = this.pinchHistory[i] - this.pinchHistory[i - 1];
        if (Math.sign(step) !== Math.sign(totalChange) && Math.abs(step) > 0.002) {
          consistent = false;
          break;
        }
      }

      if (consistent && Math.abs(totalChange) >= TREND_MIN_CHANGE) {
        if (totalChange > 0) {
          // Fingers opened → ZOOM IN (factor < 1 = camera closer = orb bigger)
          this.callbacks.onZoom(ZOOM_STEP);
        } else {
          // Fingers closed → ZOOM OUT (factor > 1 = camera further = orb smaller)
          this.callbacks.onZoom(1 / ZOOM_STEP);
        }
        mode = "zoom";
        this.zoomCooldown = ZOOM_COOLDOWN;
        // Clear history so next gesture starts fresh
        this.pinchHistory = [];
      }
    }

    // ── Rotate: palm centroid motion when not zooming ─────────────────────────
    if (mode !== "zoom") {
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

    const lm = landmarks[0];
    const pr = getPinchRatio(lm);

    const tx = (1 - lm[THUMB_TIP].x) * width;
    const ty = lm[THUMB_TIP].y * height;
    const ix = (1 - lm[INDEX_TIP].x) * width;
    const iy = lm[INDEX_TIP].y * height;

    // Detect zoom direction from history trend
    const history  = this.pinchHistory;
    const trending = history.length >= 2
      ? history[history.length - 1] - history[0]
      : 0;
    const isActive  = this.zoomCooldown > 0;
    const lineColor = isActive
      ? (trending >= 0 ? "#66ffcc" : "#ffaa44")
      : "rgba(127,232,255,0.6)";

    // Thumb ↔ index line
    ctx.strokeStyle = lineColor;
    ctx.lineWidth   = isActive ? 2.5 : 1.5;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(ix, iy);
    ctx.stroke();

    // Thumb dot
    ctx.beginPath();
    ctx.arc(tx, ty, isActive ? 6 : 4, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();

    // Index dot
    ctx.beginPath();
    ctx.arc(ix, iy, isActive ? 6 : 4, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();

    // Palm centroid
    if (this.grab) {
      ctx.beginPath();
      ctx.arc(this.grab.x * width, this.grab.y * height, 4, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(77,184,255,0.45)";
      ctx.fill();
    }
  }
}
