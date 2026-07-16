// handTracker.js — SIGNAL gesture engine v5
//
// ZOOM IN:  Pinch fingers CLOSED/TOGETHER → continuously zooms in while held
// ZOOM OUT: Hold fingers OPEN/WIDE        → continuously zooms out while held
// NEUTRAL:  Relaxed hand in middle zone   → no zoom, rotation allowed
// ROTATE:   Close fist + move hand        → rotates orb
//
// Pinch ratio = thumb↔index distance / hand scale
//   Pinched     ≈ 0–0.28  → ZOOM IN  zone
//   Neutral     ≈ 0.28–0.65 → dead zone (rotation / fist move)
//   Open wide   ≈ 0.65+  → ZOOM OUT zone

const WASM_CDN  = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// ── Landmark indices ──────────────────────────────────────────────────────────
const WRIST      = 0;
const THUMB_TIP  = 4;
const INDEX_TIP  = 8;
const MIDDLE_MCP = 9;
const PALM_IDS   = [0, 5, 9, 13, 17];

// ── Zoom thresholds ────────────────────────────────────────────────
// Pinch ratio for a relaxed/neutral hand is roughly 0.35-0.55.
// These thresholds must be clearly outside that range.
const ZOOM_IN_THRESHOLD  = 0.82;  // ratio ABOVE this → zoom out (fingers very wide)
const ZOOM_OUT_THRESHOLD = 0.14;  // ratio BELOW this → zoom in  (very deliberate pinch)

// Must stay in the zone for this many frames before zoom activates
// Prevents accidental/transient triggers when just showing the hand
const ZONE_ENTRY_FRAMES = 10;

// ── Zoom speed ────────────────────────────────────────────────
// factor < 1 = camera closer = orb bigger  (zoom in)
// factor > 1 = camera further = orb smaller (zoom out)
const ZOOM_IN_FACTOR  = 0.92;  // zoom in step  (8% closer per interval)
const ZOOM_OUT_FACTOR = 1.08;  // zoom out step (8% further per interval)
const ZOOM_INTERVAL   = 3;     // fire every N frames while in zone

// ── Rotation ────────────────────────────────────────────────
const ROTATE_SPEED = 1.6;
const SMOOTHING    = 0.50;
const DEAD_ZONE    = 0.007;
const MAX_DELTA    = 0.020;

// Heavy smoothing on pinch ratio — kills jitter at zone boundaries
const PINCH_SMOOTHING = 0.20;  // lower = slower to cross threshold = fewer false triggers

// ── Helpers ───────────────────────────────────────────────────────────────────
function palmCenter(lm) {
  let x = 0, y = 0;
  for (const id of PALM_IDS) { x += lm[id].x; y += lm[id].y; }
  return { x: 1 - x / PALM_IDS.length, y: y / PALM_IDS.length };
}

function dist2d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getRawPinchRatio(lm) {
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

    this._resetState();
    this.lastStatus = { hands: 0, mode: "idle" };
  }

  _resetState() {
    this.grab        = null;
    this._prevGrab   = null;
    this.smoothPinch = 0.45;  // start in neutral zone
    this.frameCount  = 0;
    this.zoneFrames  = 0;     // consecutive frames spent in current zoom zone
    this.activeZone  = null;  // 'in', 'out', or null
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
    this._resetState();
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
    this.frameCount++;

    if (landmarks.length === 0) {
      this._resetState();
      this._emitStatus({ hands: 0, mode: "idle" });
      return;
    }

    // Use only first detected hand
    const lm  = landmarks[0];
    const raw = palmCenter(lm);

    // ── Smooth palm centroid ──────────────────────────────────────────────────
    if (!this.grab) {
      this.grab = { x: raw.x, y: raw.y };
    } else {
      this.grab.x += (raw.x - this.grab.x) * SMOOTHING;
      this.grab.y += (raw.y - this.grab.y) * SMOOTHING;
    }

    // ── Smooth pinch ratio (kills zone-boundary jitter) ───────────────────────
    const rawRatio = getRawPinchRatio(lm);
    this.smoothPinch += (rawRatio - this.smoothPinch) * PINCH_SMOOTHING;

    // ── Determine gesture zone ────────────────────────────────────────────────
    let mode = "idle";

    if (this.smoothPinch <= ZOOM_OUT_THRESHOLD) {
      // ── ZOOM IN: fingers pinched/closed ───────────────────────────
      if (this.activeZone !== "in") { this.activeZone = "in"; this.zoneFrames = 0; }
      this.zoneFrames++;
      mode = "zoom-in";
      // Only fire after holding the gesture for ZONE_ENTRY_FRAMES frames
      if (this.zoneFrames >= ZONE_ENTRY_FRAMES && this.frameCount % ZOOM_INTERVAL === 0) {
        this.callbacks.onZoom(ZOOM_IN_FACTOR);
      }

    } else if (this.smoothPinch >= ZOOM_IN_THRESHOLD) {
      // ── ZOOM OUT: fingers wide/open ───────────────────────────────
      if (this.activeZone !== "out") { this.activeZone = "out"; this.zoneFrames = 0; }
      this.zoneFrames++;
      mode = "zoom-out";
      // Only fire after holding the gesture for ZONE_ENTRY_FRAMES frames
      if (this.zoneFrames >= ZONE_ENTRY_FRAMES && this.frameCount % ZOOM_INTERVAL === 0) {
        this.callbacks.onZoom(ZOOM_OUT_FACTOR);
      }

    } else {
      // ── NEUTRAL zone: reset zone state, allow rotation ────────────
      this.activeZone = null;
      this.zoneFrames = 0;
      mode = "idle";
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
    const tx = (1 - lm[THUMB_TIP].x) * width;
    const ty = lm[THUMB_TIP].y * height;
    const ix = (1 - lm[INDEX_TIP].x) * width;
    const iy = lm[INDEX_TIP].y * height;

    // Color shows current zone
    const r = this.smoothPinch;
    const isZoomIn  = r >= ZOOM_IN_THRESHOLD;
    const isZoomOut = r <= ZOOM_OUT_THRESHOLD;
    const color = isZoomIn  ? "#66ffcc"                 // cyan-green = zoom in
                : isZoomOut ? "#ffaa44"                 // amber = zoom out
                :             "rgba(127,232,255,0.55)"; // neutral

    // Thumb ↔ index line
    ctx.strokeStyle = color;
    ctx.lineWidth   = (isZoomIn || isZoomOut) ? 2.5 : 1.5;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(ix, iy);
    ctx.stroke();

    // Thumb dot
    ctx.beginPath();
    ctx.arc(tx, ty, (isZoomIn || isZoomOut) ? 7 : 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // Index dot
    ctx.beginPath();
    ctx.arc(ix, iy, (isZoomIn || isZoomOut) ? 7 : 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // Palm centroid dot
    if (this.grab) {
      ctx.beginPath();
      ctx.arc(this.grab.x * width, this.grab.y * height, 5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(77,184,255,0.5)";
      ctx.fill();
    }

    // Zoom ratio indicator bar at bottom of overlay
    const barW = width * 0.6;
    const barX = (width - barW) / 2;
    const barY = height - 14;
    const barH = 4;
    // Background
    ctx.fillStyle = "rgba(127,232,255,0.12)";
    ctx.fillRect(barX, barY, barW, barH);
    // Fill — ratio mapped 0→1 across bar
    const fill = Math.min(r / 1.2, 1.0) * barW;
    ctx.fillStyle = color;
    ctx.fillRect(barX, barY, fill, barH);
    // Threshold markers
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.fillRect(barX + (ZOOM_OUT_THRESHOLD / 1.2) * barW, barY - 1, 2, barH + 2);
    ctx.fillRect(barX + (ZOOM_IN_THRESHOLD  / 1.2) * barW, barY - 1, 2, barH + 2);
  }
}
