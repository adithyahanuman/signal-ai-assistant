// handTracker.js — SIGNAL gesture engine v7
//
// Uses ALL 5 fingertips for accurate hand-openness tracking.
//
// SPREAD RATIO = avg distance of all 5 fingertips from palm center / hand scale
//   Open hand  ≈ 1.2–1.6
//   Relaxed    ≈ 0.9–1.2
//   Fist       ≈ 0.4–0.8
//
// ZOOM:   Delta of spread ratio per frame.
//         Fingers spreading apart  → zoom in
//         Fingers closing together → zoom out
//         Hand held still         → nothing (no drift)
//
// ROTATE: When spread ratio is LOW (fist closed) + hand moves → rotate orb.

const WASM_CDN  = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// ── Landmark indices ──────────────────────────────────────────────────────────
const WRIST      = 0;
const THUMB_TIP  = 4;
const INDEX_TIP  = 8;
const MIDDLE_TIP = 12;
const RING_TIP   = 16;
const PINKY_TIP  = 20;
const MIDDLE_MCP = 9;
const PALM_IDS   = [0, 5, 9, 13, 17]; // wrist + all 4 MCPs (stable anchors)
const ALL_TIPS   = [THUMB_TIP, INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP];

// ── Fist threshold ────────────────────────────────────────────────────────────
// Spread ratio below this = fist closed = rotation allowed
const FIST_THRESHOLD = 0.88;

// ── Zoom (spread-delta based) ─────────────────────────────────────────────────
const SPREAD_SMOOTH  = 0.28;   // EMA on spread ratio (lower = smoother)
const ZOOM_DEAD      = 0.005;  // min spread delta per frame to count as intentional
const ZOOM_SCALE     = 16.0;   // delta → zoom factor multiplier
const ZOOM_MAX_STEP  = 0.10;   // max zoom change per frame

// ── Rotation ──────────────────────────────────────────────────────────────────
const PALM_SMOOTH    = 0.40;
const ROTATE_DEAD    = 0.005;
const ROTATE_SCALE   = 2.2;
const ROTATE_MAX     = 0.025;

// ── Helpers ───────────────────────────────────────────────────────────────────
function palmCenterRaw(lm) {
  let x = 0, y = 0;
  for (const id of PALM_IDS) { x += lm[id].x; y += lm[id].y; }
  return { x: x / PALM_IDS.length, y: y / PALM_IDS.length };
}

function palmCenterMirrored(lm) {
  const p = palmCenterRaw(lm);
  return { x: 1 - p.x, y: p.y };
}

function dist2d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Spread ratio: avg distance of ALL 5 fingertips from palm center / hand scale.
 * Single number representing how open the hand is.
 */
function spreadRatio(lm) {
  const scale = dist2d(lm[WRIST], lm[MIDDLE_MCP]);
  if (scale < 1e-6) return 1.0;
  const palm = palmCenterRaw(lm); // raw (un-mirrored) for tip comparison
  let total = 0;
  for (const tip of ALL_TIPS) total += dist2d(lm[tip], palm);
  return (total / ALL_TIPS.length) / scale;
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
    this.spread    = null;  // smoothed spread ratio
    this.palm      = null;  // smoothed palm centroid (mirrored)
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

    // ── 1. Spread ratio (all 5 tips) ─────────────────────────────────────────
    const rawSpread = spreadRatio(lm);
    const prevSpread = this.spread;
    this.spread = this.spread === null
      ? rawSpread
      : this.spread + (rawSpread - this.spread) * SPREAD_SMOOTH;

    // ── 2. Smooth palm centroid ──────────────────────────────────────────────
    const rawPalm = palmCenterMirrored(lm);
    this.prevPalm = this.palm ? { ...this.palm } : null;
    this.palm = this.palm === null
      ? rawPalm
      : { x: this.palm.x + (rawPalm.x - this.palm.x) * PALM_SMOOTH,
          y: this.palm.y + (rawPalm.y - this.palm.y) * PALM_SMOOTH };

    let mode = "idle";

    // ── 3. ZOOM from spread delta ────────────────────────────────────────────
    // Fires only when hand is actively opening or closing — not when still.
    if (prevSpread !== null) {
      const delta = this.spread - prevSpread; // +ve = opening = zoom in

      if (Math.abs(delta) > ZOOM_DEAD) {
        const step = Math.min(Math.abs(delta) * ZOOM_SCALE, ZOOM_MAX_STEP);
        // Opening (delta > 0) → zoom in → factor < 1 (camera closer = orb bigger)
        // Closing (delta < 0) → zoom out → factor > 1
        const factor = delta > 0
          ? Math.max(1.0 - step, 0.85)
          : Math.min(1.0 + step, 1.15);
        this.callbacks.onZoom(factor);
        mode = delta > 0 ? "zoom-in" : "zoom-out";
      }
    }

    // ── 4. ROTATE — only when fist is closed (spread ratio low) ─────────────
    const isFist = this.spread < FIST_THRESHOLD;

    if (isFist && this.prevPalm) {
      let dx = this.palm.x - this.prevPalm.x;
      let dy = this.palm.y - this.prevPalm.y;
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
    if (!landmarks.length || !this.spread) return;

    const lm     = landmarks[0];
    const isFist = this.spread < FIST_THRESHOLD;
    const m      = this.lastStatus.mode;

    // Color theme per mode
    const tipColor = m === "zoom-in"  ? "#66ffcc"
                   : m === "zoom-out" ? "#ffaa44"
                   : m === "spin"     ? "#7fe8ff"
                   : isFist           ? "rgba(127,232,255,0.7)"
                   :                    "rgba(127,232,255,0.35)";
    const active = m !== "idle";

    // Palm center (mirrored for display)
    const palm = palmCenterMirrored(lm);
    const pcx  = palm.x * width;
    const pcy  = palm.y * height;

    // Draw fan lines from palm to each of the 5 fingertips
    ALL_TIPS.forEach(tip => {
      const fx = (1 - lm[tip].x) * width;
      const fy = lm[tip].y * height;

      // Line palm → tip
      ctx.strokeStyle = active ? tipColor : "rgba(127,232,255,0.18)";
      ctx.lineWidth   = active ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(pcx, pcy);
      ctx.lineTo(fx, fy);
      ctx.stroke();

      // Tip dot
      ctx.beginPath();
      ctx.arc(fx, fy, active ? 6 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = tipColor;
      ctx.fill();
    });

    // Palm centroid dot — glows when fist (rotation ready)
    const palmDotColor = isFist ? "#7fe8ff" : "rgba(77,184,255,0.3)";
    ctx.beginPath();
    ctx.arc(pcx, pcy, isFist ? 7 : 4, 0, Math.PI * 2);
    ctx.fillStyle = palmDotColor;
    ctx.fill();

    // Outer ring when fist detected
    if (isFist) {
      ctx.beginPath();
      ctx.arc(pcx, pcy, 14, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(127,232,255,0.35)";
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    }

    // Spread ratio bar at bottom
    const barW = width * 0.7;
    const barX = (width - barW) / 2;
    const barY = height - 12;
    ctx.fillStyle = "rgba(127,232,255,0.10)";
    ctx.fillRect(barX, barY, barW, 4);
    const fill = Math.min(this.spread / 1.6, 1.0) * barW;
    ctx.fillStyle = tipColor;
    ctx.fillRect(barX, barY, fill, 4);
    // Fist threshold marker
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.fillRect(barX + (FIST_THRESHOLD / 1.6) * barW, barY - 1, 2, 6);
  }
}
