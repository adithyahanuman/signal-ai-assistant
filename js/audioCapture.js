// audioCapture.js — SIGNAL mic capture module
//
// Orchestrates getUserMedia → AudioContext → AudioWorkletNode (capture-worklet.js).
// Posts PCM16 chunks to the caller via onChunk callback.
// All heavy work (downsampling, conversion) happens in the worklet thread,
// not on the main thread where Three.js is rendering.
//
// Usage:
//   import { AudioCapture } from './audioCapture.js';
//   const cap = new AudioCapture({
//     onChunk:           (arrayBuffer) => geminiLive.sendAudioChunk(arrayBuffer),
//     onPermissionDenied: () => showError('MIC ACCESS DENIED'),
//     onError:           (err) => showError(err.message),
//   });
//   await cap.start();
//   cap.mute();   // pause streaming (mic stays open for fast resume)
//   cap.unmute();
//   cap.stop();   // full teardown

export class AudioCapture {
  constructor({ onChunk, onPermissionDenied, onError } = {}) {
    this.onChunk            = onChunk            || (() => {});
    this.onPermissionDenied = onPermissionDenied || (() => {});
    this.onError            = onError            || ((e) => console.error('[AudioCapture]', e));

    this._ctx        = null;
    this._worklet    = null;
    this._source     = null;
    this._stream     = null;
    this._muted      = false;
    this._started    = false;
  }

  /**
   * Request mic permission and start streaming PCM16 chunks.
   * Throws if already started.
   */
  async start() {
    if (this._started) return;

    // Request mic access — must be called from a user gesture context
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount:       1,
          echoCancellation:   true,
          noiseSuppression:   true,
          autoGainControl:    true,
        },
      });
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        this.onPermissionDenied();
      } else {
        this.onError(err);
      }
      throw err; // re-throw so the caller knows start() failed
    }

    this._stream = stream;

    // Create AudioContext at the device's native sample rate;
    // the worklet handles downsampling to 16 kHz.
    this._ctx = new AudioContext();

    // Load the worklet processor
    try {
      await this._ctx.audioWorklet.addModule('./js/capture-worklet.js');
    } catch (err) {
      this.onError(new Error(`Worklet load failed: ${err.message}`));
      this._cleanup();
      throw err;
    }

    // Create the worklet node, passing the native sample rate so the
    // processor can compute the correct downsampling ratio.
    this._worklet = new AudioWorkletNode(this._ctx, 'capture-processor', {
      numberOfInputs:  1,
      numberOfOutputs: 0, // no audio output from capture — we just post chunks
      processorOptions: { inputSampleRate: this._ctx.sampleRate },
    });

    // Receive downsampled PCM16 chunks from the worklet thread
    this._worklet.port.onmessage = (e) => {
      if (e.data?.type === 'chunk') {
        this.onChunk(e.data.buffer);
      }
    };

    // Connect mic stream → worklet
    this._source = this._ctx.createMediaStreamSource(stream);
    this._source.connect(this._worklet);

    this._started = true;
  }

  /**
   * Pause audio streaming without stopping the mic stream.
   * Useful when sending a text message mid-session so the two
   * input paths don't collide on the same turn.
   */
  mute() {
    if (!this._worklet || this._muted) return;
    this._muted = true;
    this._worklet.port.postMessage({ type: 'mute' });
  }

  /**
   * Resume streaming after mute().
   */
  unmute() {
    if (!this._worklet || !this._muted) return;
    this._muted = false;
    this._worklet.port.postMessage({ type: 'unmute' });
  }

  get isMuted()   { return this._muted; }
  get isRunning()  { return this._started; }

  /**
   * Full teardown: disconnect worklet, stop mic tracks, close AudioContext.
   */
  stop() {
    this._cleanup();
    this._started = false;
    this._muted   = false;
  }

  _cleanup() {
    if (this._source)  { try { this._source.disconnect(); } catch (_) {} }
    if (this._worklet) { try { this._worklet.disconnect(); } catch (_) {} }
    if (this._stream)  { this._stream.getTracks().forEach(t => t.stop()); }
    if (this._ctx)     { this._ctx.close().catch(() => {}); }
    this._source  = null;
    this._worklet = null;
    this._stream  = null;
    this._ctx     = null;
  }
}
