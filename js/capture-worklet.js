// capture-worklet.js — SIGNAL mic capture AudioWorkletProcessor
//
// Runs in the dedicated audio thread (off the main thread where Three.js renders).
// Receives raw Float32 mic samples → downsamples to 16 kHz → converts to Int16 PCM
// → posts chunks to the main thread for streaming to Gemini Live.
//
// Gemini Live input spec: 16-bit PCM, 16 kHz, mono, little-endian.

const TARGET_SAMPLE_RATE = 16000;
// Accumulate ~100 ms of audio before posting to reduce message overhead.
// At 16 kHz: 1600 samples = 100 ms.
const CHUNK_FRAMES = 1600;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    // inputSampleRate is passed from the main thread so the worklet can
    // compute the correct downsampling ratio without calling sampleRate
    // (which would require globalThis in some runtimes).
    this._inputRate  = options.processorOptions?.inputSampleRate ?? 48000;
    this._ratio      = this._inputRate / TARGET_SAMPLE_RATE; // e.g. 3.0 for 48→16kHz
    this._buf        = new Int16Array(CHUNK_FRAMES * 2);     // output accumulator
    this._bufLen     = 0;
    // _phase tracks our fractional read position within the current input block.
    // Carried across calls so we stay in sync across 128-frame AudioWorklet blocks.
    this._phase      = 0;
    // Last sample of the previous block, used for linear interpolation
    // across the block boundary when _phase < 1 at block start.
    this._prevSample = 0;
    this._muted      = false;

    this.port.onmessage = (e) => {
      if (e.data?.type === 'mute')   this._muted = true;
      if (e.data?.type === 'unmute') this._muted = false;
    };
  }

  /**
   * Called ~every 128 input frames by the audio engine.
   * inputs[0][0] = Float32Array of mono mic samples at the device sample rate.
   */
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0 || this._muted) return true;

    const len  = input.length;
    let phase  = this._phase;
    const prev = this._prevSample;

    while (phase < len) {
      const lo = Math.floor(phase);
      const t  = phase - lo;

      // Linear interpolation between adjacent samples.
      // When lo === 0 and phase < 1 (cross-block boundary), interpolate
      // between the last sample of the previous block (prev) and input[0].
      // For all other positions, interpolate within the current block.
      let sampleF32;
      if (lo === 0 && t > 0) {
        // Cross-boundary: between prev block's last sample and this block's first
        sampleF32 = prev * (1 - t) + input[0] * t;
      } else {
        const hi  = Math.min(lo + 1, len - 1);
        sampleF32 = input[lo] * (1 - t) + input[hi] * t;
      }

      // Float32 (-1..1) → Int16 (-32768..32767), clamped
      const clamped = Math.max(-1, Math.min(1, sampleF32));
      this._buf[this._bufLen++] = clamped < 0
        ? (clamped * 0x8000) | 0
        : (clamped * 0x7FFF) | 0;

      phase += this._ratio;

      // Flush a complete chunk to the main thread
      if (this._bufLen >= CHUNK_FRAMES) {
        const out = this._buf.slice(0, this._bufLen);
        // Transfer ownership (zero-copy) — avoids a memcopy across threads
        this.port.postMessage({ type: 'chunk', buffer: out.buffer }, [out.buffer]);
        this._bufLen = 0;
        // Must reallocate because we transferred ownership of the backing buffer
        this._buf = new Int16Array(CHUNK_FRAMES * 2);
      }
    }

    // Carry fractional phase and last sample forward to the next block
    this._phase      = phase - len;
    this._prevSample = input[len - 1];

    return true; // keep processor alive
  }
}

registerProcessor('capture-processor', CaptureProcessor);
