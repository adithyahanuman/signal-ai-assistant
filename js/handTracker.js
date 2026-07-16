// handTracker.js — SIGNAL gesture engine v8
//
// Tracks all 5 fingers individually using tip-vs-MCP wrist-distance comparison.
//
// GESTURE MAP:
//   ✊ (all 5 closed / fist)             + move hand  → ROTATE
//   🤟 (middle+ring+pinky closed,          
//       thumb+index spread/moving apart) → ZOOM IN
//   🤟 (middle+ring+pinky closed,
//       thumb+index moving together)     → ZOOM OUT
//   🖐️ (all 5 open, any state)           → IDLE (nothing)
//
// Finger-open detection: tip is farther from wrist than its MCP × 1.1 → extended.

const WASM_CDN  = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// ── Landmark indices ──────────────────────────────────────────────────────────
const WRIST      = 0;
const THUMB_TIP  = 4;  const THUMB_MCP  = 2;
const INDEX_TIP  = 8;  const INDEX_MCP  = 5;
const MIDDLE_TIP = 12; const MIDDLE_MCP = 9;
const RING_TIP   = 16; const RING_MCP   = 13;
const PINKY_TIP  = 20; const PINKY_MCP  = 17;
const PALM_IDS   = [0, 5, 9, 13, 17];

// ── Tuning ────────────────────────────────────────────────────────────────────
const OPEN_RATIO    = 1.08;  // tip/mcp wrist-distance ratio to count as "open"
const PINCH_SMOOTH  = 0.30;  // EMA on thumb-index distance
const PALM_SMOOTH   = 0.40;  // EMA on palm centroid
const ZOOM_DEAD     = 0.006; // min delta to count as intentional zoom motion
const ZOOM_SCALE    = 18.0;  // delta → zoom factor
const ZOOM_MAX      = 0.10;  // max zoom step per frame
const ROTATE_DEAD   = 0.005; // min palm delta for rotation
const ROTATE_SCALE  = 2.5;
const ROTATE_MAX    = 0.025;

// ── Helpers ───────────────────────────────────────────────────────────────────
function dist2d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Returns true if the finger is extended (open). */
function fingerOpen(lm, tipId, mcpId) {
  return dist2d(lm[tipId], lm[WRIST]) > dist2d(lm[mcpId], lm[WRIST]) * OPEN_RATIO;
}

/** Mirrored palm centroid for display. */
function palmMirrored(lm) {
  let x = 0, y = 0;
  for (const id of PALM_IDS) { x += lm[id].x; y += lm[id].y; }
  return { x: 1 - x / PALM_IDS.length, y: y / PALM_IDS.length };
}

/** Raw (un-mirrored) palm centroid for distance calculations. */
function palmRaw(lm) {
  let x = 0, y = 0;
  for (const id of PALM_IDS) { x += lm[id].x; y += lm[id].y; }
  return { x: x / PALM_IDS.length, y: y / PALM_IDS.length };
}

/** Normalized thumb↔index distance / hand scale. */
function pinchDist(lm) {
  const scale = dist2d(lm[WRIST], lm[MIDDLE_MCP]);
  return scale < 1e-6 ? 0.5 : dist2d(lm[THUMB_TIP], lm[INDEX_TIP]) / scale;
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
    this.pinch    = null;  // smoothed thumb-index distance
    this.palm     = null;  // smoothed mirrored palm centroid
    this.prevPalm = null;
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

    // ── 1. Classify each finger ──────────────────────────────────────────────
    const thumbUp  = fingerOpen(lm, THUMB_TIP,  THUMB_MCP);
    const indexUp  = fingerOpen(lm, INDEX_TIP,  INDEX_MCP);
    const midDown  = !fingerOpen(lm, MIDDLE_TIP, MIDDLE_MCP);
    const ringDown = !fingerOpen(lm, RING_TIP,   RING_MCP);
    const pinkyDown= !fingerOpen(lm, PINKY_TIP,  PINKY_MCP);

    const allClosed = !thumbUp && !indexUp && midDown && ringDown && pinkyDown;
    const allOpen   = thumbUp && indexUp && !midDown && !ringDown && !pinkyDown;
    const zoomReady = midDown && ringDown && pinkyDown; // 3 down, thumb+index free

    // ── 2. Smooth palm centroid ──────────────────────────────────────────────
    const rawPalm = palmMirrored(lm);
    this.prevPalm = this.palm ? { ...this.palm } : null;
    this.palm = this.palm === null
      ? rawPalm
      : { x: this.palm.x + (rawPalm.x - this.palm.x) * PALM_SMOOTH,
          y: this.palm.y + (rawPalm.y - this.palm.y) * PALM_SMOOTH };

    let mode = "idle";

    // ── 3. ZOOM — only when 3 fingers are down ───────────────────────────────
    if (zoomReady && !allClosed) {
      const pd = pinchDist(lm);
      const prev = this.pinch;
      this.pinch = this.pinch === null
        ? pd
        : this.pinch + (pd - this.pinch) * PINCH_SMOOTH;

      if (prev !== null) {
        const delta = this.pinch - prev; // +ve = thumb/index apart = zoom in
        if (Math.abs(delta) > ZOOM_DEAD) {
          const step   = Math.min(Math.abs(delta) * ZOOM_SCALE, ZOOM_MAX);
          // Apart (delta>0) → zoom IN  → factor < 1 (camera closer = orb bigger)
          // Together (delta<0) → zoom OUT → factor > 1
          const factor = delta > 0
            ? Math.max(1.0 - step, 0.85)
            : Math.min(1.0 + step, 1.15);
          this.callbacks.onZoom(factor);
          mode = delta > 0 ? "zoom-in" : "zoom-out";
        }
      }
    } else {
      this.pinch = null; // reset when gesture changes
    }

    // ── 4. ROTATE — only when all 5 fingers closed (fist) ───────────────────
    if (allClosed && this.prevPalm) {
      let dx = this.palm.x - this.prevPalm.x;
      let dy = this.palm.y - this.prevPalm.y;
      dx = Math.max(-ROTATE_MAX, Math.min(ROTATE_MAX, dx));
      dy = Math.max(-ROTATE_MAX, Math.min(ROTATE_MAX, dy));
      if (Math.abs(dx) > ROTATE_DEAD || Math.abs(dy) > ROTATE_DEAD) {
        this.callbacks.onRotate(dx * ROTATE_SCALE, dy * ROTATE_SCALE);
        mode = "spin";
      }
    }

    // ── 5. All open → idle (no action) ──────────────────────────────────────
    // (allOpen already results in mode = "idle" — nothing to do)

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
    const m  = this.lastStatus.mode;

    // Finger open/closed state
    const states = [
      { tip: THUMB_TIP,  mcp: THUMB_MCP,  open: fingerOpen(lm, THUMB_TIP,  THUMB_MCP)  },
      { tip: INDEX_TIP,  mcp: INDEX_MCP,  open: fingerOpen(lm, INDEX_TIP,  INDEX_MCP)  },
      { tip: MIDDLE_TIP, mcp: MIDDLE_MCP, open: fingerOpen(lm, MIDDLE_TIP, MIDDLE_MCP) },
      { tip: RING_TIP,   mcp: RING_MCP,   open: fingerOpen(lm, RING_TIP,   RING_MCP)   },
      { tip: PINKY_TIP,  mcp: PINKY_MCP,  open: fingerOpen(lm, PINKY_TIP,  PINKY_MCP)  },
    ];

    const allClosed = states.every(s => !s.open);
    const palm = this.palm ?? palmMirrored(lm);
    const pcx  = palm.x * width;
    const pcy  = palm.y * height;

    states.forEach(({ tip, open }) => {
      const fx = (1 - lm[tip].x) * width;
      const fy = lm[tip].y * height;

      // Color: green = active open finger, dim = closed finger
      let dotColor;
      if (m === "zoom-in")       dotColor = open ? "#66ffcc" : "rgba(102,255,204,0.2)";
      else if (m === "zoom-out") dotColor = open ? "#ffaa44" : "rgba(255,170,68,0.2)";
      else if (m === "spin")     dotColor = "#7fe8ff";
      else                       dotColor = open ? "rgba(127,232,255,0.55)" : "rgba(127,232,255,0.18)";

      // Fan line palm → tip
      ctx.strokeStyle = dotColor;
      ctx.lineWidth   = (m !== "idle") ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(pcx, pcy);
      ctx.lineTo(fx, fy);
      ctx.stroke();

      // Tip dot — bigger for open fingers when active
      const dotSize = (m !== "idle" && open) ? 7 : open ? 4 : 3;
      ctx.beginPath();
      ctx.arc(fx, fy, dotSize, 0, Math.PI * 2);
      ctx.fillStyle = dotColor;
      ctx.fill();
    });

    // Palm centroid
    const palmColor = allClosed ? "#7fe8ff" : "rgba(77,184,255,0.35)";
    ctx.beginPath();
    ctx.arc(pcx, pcy, allClosed ? 7 : 4, 0, Math.PI * 2);
    ctx.fillStyle = palmColor;
    ctx.fill();

    // Ring when fist (rotate mode)
    if (allClosed) {
      ctx.beginPath();
      ctx.arc(pcx, pcy, 14, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(127,232,255,0.4)";
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    }

    // Status label
    const label = m === "zoom-in"  ? "ZOOM IN"
                : m === "zoom-out" ? "ZOOM OUT"
                : m === "spin"     ? "ROTATING"
                :                    "";
    if (label) {
      ctx.font      = "bold 9px monospace";
      ctx.fillStyle = m === "zoom-in"  ? "#66ffcc"
                    : m === "zoom-out" ? "#ffaa44"
                    :                    "#7fe8ff";
      ctx.textAlign = "center";
      ctx.fillText(label, width / 2, 14);
    }
  }
}
