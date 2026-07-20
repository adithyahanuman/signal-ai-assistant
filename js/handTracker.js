// handTracker.js — SIGNAL gesture engine v10 (simplified, reliable)
//
// Uses ONE number: spreadRatio = avg distance of all 5 tips from palm / hand scale
//   spreadRatio > 1.1  → hand is OPEN  → move palm to ROTATE
//   spreadRatio < 0.75 → hand is CLOSED (fist) → nothing
//   Between 0.75–1.1   → partial close → ZOOM via thumb↔index delta
//
// ZOOM is delta-based: thumb and index moving apart/together fires zoom once.
// ROTATE is hold-based: open hand + palm moving = continuous rotation.

const WASM_CDN  = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// ── Landmarks ─────────────────────────────────────────────────────────────────
const W  = 0;   // wrist
const T4 = 4;   // thumb tip
const I8 = 8;   // index tip
const M9 = 9;   // middle MCP  (hand scale reference)
const ALL_TIPS  = [4, 8, 12, 16, 20]; // all 5 fingertips
const PALM_IDS  = [0, 5, 9, 13, 17];  // wrist + 4 MCPs

// ── Spread thresholds ─────────────────────────────────────────────────────────
const OPEN_SPREAD  = 1.10;  // above this = open hand → rotation enabled
const FIST_SPREAD  = 0.75;  // below this = fist → nothing

// ── Zoom config ───────────────────────────────────────────────────────────────
const PINCH_SMOOTH = 0.30;  // EMA on thumb-index distance
const ZOOM_DEAD    = 0.006; // min frame-delta to count as intentional
const ZOOM_SCALE   = 18.0;
const ZOOM_MAX     = 0.08;

// ── Rotation config ───────────────────────────────────────────────────────────
const PALM_SMOOTH  = 0.35;
const ROT_DEAD     = 0.004;
const ROT_SCALE    = 3.0;
const ROT_MAX      = 0.025;

// ── Spread smoothing ──────────────────────────────────────────────────────────
const SPREAD_SMOOTH = 0.20; // heavy smoothing → prevents flicker at boundaries

// ── Helpers ───────────────────────────────────────────────────────────────────
function d(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function palmRaw(lm) {
  let x = 0, y = 0;
  for (const id of PALM_IDS) { x += lm[id].x; y += lm[id].y; }
  return { x: x / PALM_IDS.length, y: y / PALM_IDS.length };
}

function palmMirr(lm) {
  const p = palmRaw(lm);
  return { x: 1 - p.x, y: p.y };
}

function spread(lm) {
  const scale = d(lm[W], lm[M9]);
  if (scale < 1e-6) return 1.0;
  const pc = palmRaw(lm);
  let tot = 0;
  for (const t of ALL_TIPS) tot += d(lm[t], pc);
  return (tot / ALL_TIPS.length) / scale;
}

function pinch(lm) {
  const scale = d(lm[W], lm[M9]);
  return scale < 1e-6 ? 0.5 : d(lm[T4], lm[I8]) / scale;
}


export class HandTracker {
  constructor(video, overlay, callbacks) {
    this.video     = video;
    this.overlay   = overlay;
    this.cb        = callbacks;
    this.landmarker    = null;
    this.stream        = null;
    this.rafId         = 0;
    this.running       = false;
    this.lastVideoTime = -1;
    this._rst();
    this.lastStatus = { hands: 0, mode: "idle" };
  }

  _rst() {
    this.sp       = null;   // smoothed spread
    this.pd       = null;   // smoothed pinch distance
    this.palm     = null;   // smoothed palm centroid
    this.prevPalm = null;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" }, audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();

    const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
    const fs   = await FilesetResolver.forVisionTasks(WASM_CDN);
    const opts = {
      baseOptions:                { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode:                "VIDEO",
      numHands:                   2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence:  0.6,
      minTrackingConfidence:      0.6,
    };
    try { this.landmarker = await HandLandmarker.createFromOptions(fs, opts); }
    catch { this.landmarker = await HandLandmarker.createFromOptions(fs,
      { ...opts, baseOptions: { ...opts.baseOptions, delegate: "CPU" } }); }

    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    if (this.landmarker) { this.landmarker.close(); this.landmarker = null; }
    if (this.stream)     { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.video.srcObject = null;
    this._rst();
    const ctx = this.overlay.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    this._emit({ hands: 0, mode: "idle" });
  }

  _loop() {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(() => this._loop());
    if (!this.landmarker || this.video.readyState < 2) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;
    const r = this.landmarker.detectForVideo(this.video, performance.now());
    this._proc(r.landmarks);
    this._draw(r.landmarks);
  }

  _proc(landmarks) {
    if (!landmarks.length) { this._rst(); this._emit({ hands: 0, mode: "idle" }); return; }

    const lm = landmarks[0];

    // ── Smoothed spread ratio ────────────────────────────────────────────────
    const rawSp = spread(lm);
    this.sp = this.sp === null ? rawSp : this.sp + (rawSp - this.sp) * SPREAD_SMOOTH;

    // ── Smoothed palm centroid ────────────────────────────────────────────────
    const rp = palmMirr(lm);
    this.prevPalm = this.palm ? { ...this.palm } : null;
    this.palm = this.palm === null ? rp
      : { x: this.palm.x + (rp.x - this.palm.x) * PALM_SMOOTH,
          y: this.palm.y + (rp.y - this.palm.y) * PALM_SMOOTH };

    // ── Smoothed pinch distance ───────────────────────────────────────────────
    const rawPd  = pinch(lm);
    const prevPd = this.pd;
    this.pd = this.pd === null ? rawPd : this.pd + (rawPd - this.pd) * PINCH_SMOOTH;

    let mode = "idle";

    // ── ROTATE: open hand (spread > OPEN_SPREAD) + palm moves ────────────────
    if (this.sp > OPEN_SPREAD && this.prevPalm) {
      let dx = this.palm.x - this.prevPalm.x;
      let dy = this.palm.y - this.prevPalm.y;
      dx = Math.max(-ROT_MAX, Math.min(ROT_MAX, dx));
      dy = Math.max(-ROT_MAX, Math.min(ROT_MAX, dy));
      if (Math.abs(dx) > ROT_DEAD || Math.abs(dy) > ROT_DEAD) {
        this.cb.onRotate(dx * ROT_SCALE, dy * ROT_SCALE);
        mode = "spin";
      }
    }

    // ── ZOOM: partial close (spread between FIST and OPEN) + pinch delta ─────
    // Works even while in open zone for thumb↔index — independent of spread
    if (this.sp < OPEN_SPREAD && this.sp > FIST_SPREAD && prevPd !== null) {
      const delta = this.pd - prevPd; // +ve = apart = zoom in
      if (Math.abs(delta) > ZOOM_DEAD) {
        const step = Math.min(Math.abs(delta) * ZOOM_SCALE, ZOOM_MAX);
        const factor = delta > 0
          ? Math.max(1 - step, 0.88)   // zoom in
          : Math.min(1 + step, 1.12);  // zoom out
        this.cb.onZoom(factor);
        mode = delta > 0 ? "zoom-in" : "zoom-out";
      }
    }

    this._emit({ hands: landmarks.length, mode });
  }

  _emit(s) {
    if (s.hands !== this.lastStatus.hands || s.mode !== this.lastStatus.mode) {
      this.lastStatus = s;
      this.cb.onStatus(s);
    }
  }

  _draw(landmarks) {
    const ctx = this.overlay.getContext("2d");
    if (!ctx) return;
    const { width: W2, height: H } = this.overlay;
    ctx.clearRect(0, 0, W2, H);
    if (!landmarks.length || this.sp === null) return;

    const lm   = landmarks[0];
    const m    = this.lastStatus.mode;
    const isOpen = this.sp > OPEN_SPREAD;
    const isFist = this.sp < FIST_SPREAD;

    // Active color
    const col = m === "zoom-in"  ? "#66ffcc"
              : m === "zoom-out" ? "#ffaa44"
              : m === "spin"     ? "#7fe8ff"
              : isOpen           ? "rgba(127,232,255,0.6)"
              :                    "rgba(127,232,255,0.25)";

    const mx = id => (1 - lm[id].x) * W2;
    const my = id => lm[id].y * H;

    // Draw finger skeletons using FINGERS definition
    const SEGS = [
      [0,2,3,4],       // thumb: wrist→mcp→ip→tip
      [0,5,6,7,8],     // index
      [0,9,10,11,12],  // middle
      [0,13,14,15,16], // ring
      [0,17,18,19,20], // pinky
    ];
    const knuckle = [2,5,9,13,17]; // mcp bar

    SEGS.forEach((seg, fi) => {
      const isTipFinger = fi >= 1; // non-thumb fingers
      ctx.strokeStyle = col;
      ctx.lineWidth   = (m !== "idle") ? 1.8 : 1;
      ctx.beginPath();
      seg.forEach((id, i) => i === 0 ? ctx.moveTo(mx(id), my(id)) : ctx.lineTo(mx(id), my(id)));
      ctx.stroke();
      // Tip dot
      const tip = seg[seg.length - 1];
      ctx.beginPath();
      ctx.arc(mx(tip), my(tip), (m !== "idle") ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
    });

    // Knuckle bar
    ctx.strokeStyle = "rgba(127,232,255,0.12)";
    ctx.lineWidth   = 1;
    ctx.beginPath();
    knuckle.forEach((id, i) => i === 0 ? ctx.moveTo(mx(id), my(id)) : ctx.lineTo(mx(id), my(id)));
    ctx.stroke();

    // Palm dot
    if (this.palm) {
      const pcx = this.palm.x * W2, pcy = this.palm.y * H;
      ctx.beginPath();
      ctx.arc(pcx, pcy, isOpen ? 7 : 4, 0, Math.PI * 2);
      ctx.fillStyle = isOpen ? "#7fe8ff" : "rgba(77,184,255,0.3)";
      ctx.fill();
      if (isOpen) {
        ctx.beginPath();
        ctx.arc(pcx, pcy, 13, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(127,232,255,0.35)";
        ctx.lineWidth   = 1.5;
        ctx.stroke();
      }
    }

    // Spread bar
    const bw = W2 * 0.7, bx = (W2 - bw) / 2, by = H - 12;
    ctx.fillStyle = "rgba(127,232,255,0.10)";
    ctx.fillRect(bx, by, bw, 4);
    ctx.fillStyle = col;
    ctx.fillRect(bx, by, Math.min(this.sp / 1.6, 1) * bw, 4);
    // threshold markers
    [[OPEN_SPREAD, "#7fe8ff"], [FIST_SPREAD, "#ffaa44"]].forEach(([v, c]) => {
      ctx.fillStyle = c;
      ctx.fillRect(bx + (v / 1.6) * bw - 1, by - 1, 2, 6);
    });

    // Label
    const lbl = m === "zoom-in"  ? "ZOOM IN +"
              : m === "zoom-out" ? "ZOOM OUT −"
              : m === "spin"     ? "ROTATING ↻" : "";
    if (lbl) {
      ctx.font = "bold 10px monospace";
      ctx.textAlign = "center";
      ctx.fillStyle = col;
      ctx.shadowColor = col; ctx.shadowBlur = 5;
      ctx.fillText(lbl, W2 / 2, 14);
      ctx.shadowBlur = 0;
    }
  }
}
