// capture-worklet.js — SIGNAL mic capture AudioWorkletProcessor
//
// Runs in the dedicated audio thread (off the main thread where Three.js renders).
// Receives raw Float32 mic samples → downsamples to 16 kHz → converts to Int16 PCM
// → posts chunks to the main thread for streaming to Gemini Live.
//
// Gemini Live input spec: 16-bit PCM, 16 kHz, mono, little-endian.

const TARGET_SAMPLE_RATE = 16000;
// Accumulate ~100 ms of audio before posting to reduce message overhead.
// At 16 kHz: 1600 samples = 100 ms. Tweak if latency feels too high.
const CHUNK_FRAMES = 1600;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    // options.processorOptions.inputSampleRate is passed from the main thread
    this._inputRate    = options.processorOptions?.inputSampleRate ?? 48000;
    this._ratio        = this._inputRate / TARGET_SAMPLE_RATE;
    // Ring buffer for downsampled Int16 output
    this._buf          = new Int16Array(CHUNK_FRAMES * 2); // extra room
    this._bufLen       = 0;
    // Fractional position tracker for linear interpolation resampler
    this._phase        = 0;
    // Previous input sample (for linear interpolation between frames)
    this._prevSample   = 0;
    this._muted        = false;

    this.port.onmessage = (e) => {
      if (e.data?.type === 'mute')   this._muted = true;
      if (e.data?.type === 'unmute') this._muted = false;
    };
  }

  /**
   * Called ~every 128 input frames by the audio engine.
   * inputs[0][0] = Float32Array of mono mic samples at device sample rate.
   */
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0 || this._muted) return true;

    // ── Downsample: linear interpolation ──────────────────────────────────
    // Walk through the output time positions and interpolate between
    // adjacent input samples. Avoids aliasing better than naive decimation.
    let phase = this._phase;
    let prev  = this._prevSample;

    let inIdx = 0;
    while (phase < input.length) {
      const lo  = Math.floor(phase);
      const hi  = Math.min(lo + 1, input.length - 1);
      const t   = phase - lo;
      const sampleF32 = prev * (1 - t) + input[lo] * t +
                        // blend in next input sample for smoother curves
                        (input[hi] - input[lo]) * t * (1 - t) * 0.5;

      // Float32 (-1..1) → Int16 (-32768..32767)
      const clamped = Math.max(-1, Math.min(1, sampleF32));
      this._buf[this._bufLen++] = clamped < 0
        ? (clamped * 0x8000) | 0
        : (clamped * 0x7FFF) | 0;

      phase += this._ratio;

      // Flush complete chunk to main thread
      if (this._bufLen >= CHUNK_FRAMES) {
        // Transfer a copy; keep the buffer allocated for reuse
        const out = this._buf.slice(0, this._bufLen);
        this.port.postMessage({ type: 'chunk', buffer: out.buffer }, [out.buffer]);
        this._bufLen = 0;
        // Reallocate buf since we transferred ownership above
        this._buf = new Int16Array(CHUNK_FRAMES * 2);
      }
    }

    // Carry over the fractional phase and last input sample to next call
    this._phase      = phase - input.length;
    this._prevSample = input[input.length - 1];

    return true; // keep processor alive
  }
}

registerProcessor('capture-processor', CaptureProcessor);
