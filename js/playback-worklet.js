// playback-worklet.js — SIGNAL audio playback AudioWorkletProcessor
//
// Maintains a lock-free ring buffer of incoming Int16 PCM samples
// (from Gemini Live's audio output at 24 kHz) and feeds them to the
// audio output with no gaps or clicks.
//
// Gemini Live output spec: 16-bit PCM, 24 kHz, mono, little-endian.
//
// Messages accepted on the port:
//   { type: 'enqueue', buffer: ArrayBuffer }  — add samples to ring buffer
//   { type: 'flush' }                          — clear buffer immediately (barge-in)
//   { type: 'config', outputRate: number }     — set output sample rate (sent on init)

const MAX_BUFFER_SECONDS = 30;    // ring buffer capacity
const SOURCE_RATE        = 24000; // Gemini native audio output sample rate

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);

    this._outputRate = options.processorOptions?.outputRate ?? 44100;
    // Upsample ratio: Gemini sends 24 kHz, device may want 44.1 or 48 kHz
    this._ratio      = SOURCE_RATE / this._outputRate;

    const maxSamples = MAX_BUFFER_SECONDS * this._outputRate;
    this._ring       = new Float32Array(maxSamples);
    this._writeHead  = 0;
    this._readHead   = 0;
    this._available  = 0; // samples available to read

    // Source samples (Int16, 24 kHz) waiting to be upsampled into the ring
    this._srcBuf     = [];
    this._srcPhase   = 0; // fractional read position in _srcBuf

    this.port.onmessage = (e) => {
      const { type, buffer } = e.data;
      if (type === 'enqueue' && buffer) {
        const int16 = new Int16Array(buffer);
        // Upsample Int16@24kHz → Float32@outputRate and write into ring buffer
        this._enqueue(int16);
      } else if (type === 'flush') {
        this._writeHead = 0;
        this._readHead  = 0;
        this._available = 0;
        this._srcBuf    = [];
        this._srcPhase  = 0;
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  _enqueue(int16Samples) {
    // Convert Int16 → Float32 and push into source buffer
    for (let i = 0; i < int16Samples.length; i++) {
      this._srcBuf.push(int16Samples[i] / 0x7FFF);
    }
    // Upsample from 24 kHz → output rate using linear interpolation
    // and write into the ring buffer
    while (this._srcPhase + 1 < this._srcBuf.length) {
      const lo = Math.floor(this._srcPhase);
      const t  = this._srcPhase - lo;
      const s  = this._srcBuf[lo] * (1 - t) + this._srcBuf[lo + 1] * t;
      this._writeRing(s);
      this._srcPhase += this._ratio;
    }
    // Keep only the tail needed for the next interpolation step
    const keepFrom = Math.max(0, Math.floor(this._srcPhase) - 1);
    this._srcBuf   = this._srcBuf.slice(keepFrom);
    this._srcPhase -= keepFrom;
  }

  _writeRing(sample) {
    const cap = this._ring.length;
    if (this._available >= cap) return; // overflow: drop oldest? or drop new?
    this._ring[this._writeHead] = sample;
    this._writeHead = (this._writeHead + 1) % cap;
    this._available++;
  }

  _readRing() {
    if (this._available === 0) return 0; // underrun → silence
    const s = this._ring[this._readHead];
    this._readHead = (this._readHead + 1) % this._ring.length;
    this._available--;
    return s;
  }

  process(_inputs, outputs) {
    const out = outputs[0]?.[0];
    if (!out) return true;

    let amplitude = 0;
    for (let i = 0; i < out.length; i++) {
      const s = this._readRing();
      out[i]  = s;
      amplitude = Math.max(amplitude, Math.abs(s));
    }

    // Report availability + amplitude to main thread every 128 frames (~3 ms)
    // so the UI can reflect playback state and sync orb pulse.
    this.port.postMessage({
      type:      'status',
      available: this._available,
      amplitude,
    });

    return true;
  }
}

registerProcessor('playback-processor', PlaybackProcessor);
