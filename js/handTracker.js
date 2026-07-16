// handTracker.js — SIGNAL gesture engine v9
//
// Full 5-finger skeleton tracking with hysteresis to prevent state flickering.
// Uses PIP (second joint) vs TIP distance from WRIST for reliable open/closed.
//
// GESTURE MAP (from image):
//   🤟 Middle+Ring+Pinky CLOSED, Thumb+Index SPREAD → moving apart = ZOOM IN
//   🤟 Middle+Ring+Pinky CLOSED, Thumb+Index COMPRESS → moving together = ZOOM OUT
//   ✊ All 5 fingers CLOSED (fist) + move hand → ROTATE
//   🖐️ All 5 fingers OPEN → IDLE (nothing)

const WASM_CDN  = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// ── Full landmark map ─────────────────────────────────────────────────────────
const WRIST = 0;

const FINGERS = [
  // name,    mcp, pip, dip, tip
  { name: "thumb",  mcp:  2, pip:  3, dip:  3, tip:  4 }, // thumb has only 2 joints (IP = pip)
  { name: "index",  mcp:  5, pip:  6, dip:  7, tip:  8 },
  { name: "middle", mcp:  9, pip: 10, dip: 11, tip: 12 },
  { name: "ring",   mcp: 13, pip: 14, dip: 15, tip: 16 },
  { name: "pinky",  mcp: 17, pip: 18, dip: 19, tip: 20 },
];

const PALM_IDS = [0, 5, 9, 13, 17];

// ── Finger open/closed detection ─────────────────────────────────────────────
// A finger is OPEN when TIP is farther from WRIST than PIP.
// Hysteresis: needs to cross threshold by a margin to change state (kills flicker).
const OPEN_THRESHOLD  = 1.02;  // ratio to flip from closed → open
const CLOSE_THRESHOLD = 0.94;  // ratio to flip from open → closed

// ── Tuning ────────────────────────────────────────────────────────────────────
const PINCH_SMOOTH  = 0.25;   // EMA on thumb-index distance
const PALM_SMOOTH   = 0.35;   // EMA on palm centroid
const ZOOM_DEAD     = 0.005;  // min delta to count as intentional zoom
const ZOOM_SCALE    = 20.0;   // delta → zoom factor
const ZOOM_MAX      = 0.10;   // max zoom step per frame
const ROTATE_DEAD   = 0.005;
const ROTATE_SCALE  = 2.5;
const ROTATE_MAX    = 0.025;

// ── Helpers ───────────────────────────────────────────────────────────────────
function dist2d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function palmMirrored(lm) {
  let x = 0, y = 0;
  for (const id of PALM_IDS) { x += lm[id].x; y += lm[id].y; }
  return { x: 1 - x / PALM_IDS.length, y: y / PALM_IDS.length };
}

function pinchDist(lm) {
  const scale = dist2d(lm[WRIST], lm[FINGERS[2].mcp]); // use middle MCP as scale
  return scale < 1e-6 ? 0.5 : dist2d(lm[FINGERS[0].tip], lm[FINGERS[1].tip]) / scale;
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
    // Persistent finger open/closed states (hysteresis)
    this.fingerOpen = { thumb: false, index: false, middle: false, ring: false, pinky: false };
    this.pinch      = null;
    this.palm       = null;
    this.prevPalm   = null;
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

    const lm = landmarks[0];

    // ── 1. Per-finger open/closed with hysteresis ────────────────────────────
    for (const f of FINGERS) {
      const tipDist = dist2d(lm[f.tip], lm[WRIST]);
      const pipDist = dist2d(lm[f.pip], lm[WRIST]);
      if (pipDist < 1e-6) continue;
      const ratio = tipDist / pipDist;

      const wasOpen = this.fingerOpen[f.name];
      if ( wasOpen && ratio < CLOSE_THRESHOLD) this.fingerOpen[f.name] = false;
      if (!wasOpen && ratio > OPEN_THRESHOLD)  this.fingerOpen[f.name] = true;
    }

    const fo = this.fingerOpen;
    const allClosed = !fo.thumb && !fo.index && !fo.middle && !fo.ring && !fo.pinky;
    const allOpen   =  fo.thumb &&  fo.index &&  fo.middle &&  fo.ring &&  fo.pinky;
    // 3 fingers down, thumb+index free (either open or in motion)
    const zoomReady = !fo.middle && !fo.ring && !fo.pinky && !allClosed;

    // ── 2. Smooth palm centroid ──────────────────────────────────────────────
    const rawPalm = palmMirrored(lm);
    this.prevPalm = this.palm ? { ...this.palm } : null;
    this.palm = this.palm === null
      ? rawPalm
      : { x: this.palm.x + (rawPalm.x - this.palm.x) * PALM_SMOOTH,
          y: this.palm.y + (rawPalm.y - this.palm.y) * PALM_SMOOTH };

    let mode = "idle";

    // ── 3. ZOOM — middle+ring+pinky down, track thumb↔index distance ─────────
    if (zoomReady) {
      const pd   = pinchDist(lm);
      const prev = this.pinch;
      this.pinch = this.pinch === null
        ? pd
        : this.pinch + (pd - this.pinch) * PINCH_SMOOTH;

      if (prev !== null) {
        const delta = this.pinch - prev; // +ve = apart = zoom in
        if (Math.abs(delta) > ZOOM_DEAD) {
          const step   = Math.min(Math.abs(delta) * ZOOM_SCALE, ZOOM_MAX);
          const factor = delta > 0
            ? Math.max(1.0 - step, 0.85)   // zoom in  (camera closer)
            : Math.min(1.0 + step, 1.15);  // zoom out (camera further)
          this.callbacks.onZoom(factor);
          mode = delta > 0 ? "zoom-in" : "zoom-out";
        }
      }
    } else {
      this.pinch = null;
    }

    // ── 4. ROTATE — all 5 closed (fist) + hand moves ────────────────────────
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

    // allOpen → mode stays "idle"

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
    const fo = this.fingerOpen;

    const allClosed = !fo.thumb && !fo.index && !fo.middle && !fo.ring && !fo.pinky;

    // Helper: mirror x
    const mx = (lm, id) => (1 - lm[id].x) * width;
    const my = (lm, id) => lm[id].y * height;

    // Draw full skeleton for each finger (MCP → PIP → DIP → TIP)
    FINGERS.forEach(f => {
      const open = fo[f.name];

      // Color per finger state and mode
      let color;
      if (m === "zoom-in")       color = open ? "#66ffcc" : "rgba(102,255,204,0.25)";
      else if (m === "zoom-out") color = open ? "#ffaa44" : "rgba(255,170,68,0.25)";
      else if (m === "spin")     color = "#7fe8ff";
      else                       color = open ? "rgba(127,232,255,0.7)" : "rgba(127,232,255,0.22)";

      const joints = [WRIST, f.mcp, f.pip, f.dip, f.tip];
      // Remove duplicate (thumb pip == dip)
      const unique = [...new Set(joints)];

      // Draw skeleton line through all joints
      ctx.strokeStyle = color;
      ctx.lineWidth   = open ? 2 : 1.2;
      ctx.beginPath();
      unique.forEach((id, i) => {
        const x = mx(lm, id), y = my(lm, id);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Draw each joint dot
      unique.forEach((id, i) => {
        const x = mx(lm, id), y = my(lm, id);
        const isTip = id === f.tip;
        ctx.beginPath();
        ctx.arc(x, y, isTip ? (open ? 6 : 3.5) : 2.5, 0, Math.PI * 2);
        ctx.fillStyle = isTip ? color : "rgba(127,232,255,0.4)";
        ctx.fill();
      });
    });

    // Draw palm connections (knuckle bar across MCPs)
    const mcps = [2, 5, 9, 13, 17];
    ctx.strokeStyle = "rgba(127,232,255,0.15)";
    ctx.lineWidth   = 1;
    ctx.beginPath();
    mcps.forEach((id, i) => {
      const x = mx(lm, id), y = my(lm, id);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Wrist to thumb MCP and wrist to pinky MCP
    [[WRIST, 2], [WRIST, 17]].forEach(([a, b]) => {
      ctx.beginPath();
      ctx.moveTo(mx(lm, a), my(lm, a));
      ctx.lineTo(mx(lm, b), my(lm, b));
      ctx.stroke();
    });

    // Palm centroid ring (fist = bright)
    if (this.palm) {
      const pcx = this.palm.x * width;
      const pcy = this.palm.y * height;
      ctx.beginPath();
      ctx.arc(pcx, pcy, allClosed ? 7 : 4, 0, Math.PI * 2);
      ctx.fillStyle = allClosed ? "#7fe8ff" : "rgba(77,184,255,0.3)";
      ctx.fill();
      if (allClosed) {
        ctx.beginPath();
        ctx.arc(pcx, pcy, 14, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(127,232,255,0.4)";
        ctx.lineWidth   = 1.5;
        ctx.stroke();
      }
    }

    // Mode label
    const label = m === "zoom-in"  ? "ZOOM IN +"
                : m === "zoom-out" ? "ZOOM OUT -"
                : m === "spin"     ? "ROTATING ↻"
                :                    "";
    if (label) {
      ctx.font         = "bold 10px monospace";
      ctx.textAlign    = "center";
      ctx.fillStyle    = m === "zoom-in"  ? "#66ffcc"
                       : m === "zoom-out" ? "#ffaa44" : "#7fe8ff";
      ctx.shadowColor  = ctx.fillStyle;
      ctx.shadowBlur   = 6;
      ctx.fillText(label, width / 2, 15);
      ctx.shadowBlur   = 0;
    }
  }
}
