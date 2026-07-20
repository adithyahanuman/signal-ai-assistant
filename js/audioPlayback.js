// audioPlayback.js — SIGNAL audio playback module
//
// Wraps the playback-worklet.js AudioWorkletProcessor.
// Receives PCM16 chunks from Gemini Live and plays them back
// gap-free via the worklet's ring buffer.
//
// Usage:
//   import { AudioPlayback } from './audioPlayback.js';
//   const pb = new AudioPlayback();
//   await pb.init();
//   pb.enqueue(int16ArrayBuffer);   // called from geminiLive.onAudioChunk
//   pb.flush();                     // called from geminiLive.onModelTurnStart (barge-in)
//   pb.isSpeaking                   // true while buffer is non-empty
//   pb.amplitude                    // 0..1, used to sync orb pulse

export class AudioPlayback {
  constructor() {
    this._ctx       = null;
    this._worklet   = null;
    this._ready     = false;

    // Playback state (updated from worklet status messages)
    this._available = 0;
    this._amplitude = 0;

    // Callback fired when speaking state changes — set by caller
    this.onSpeakingChange = null; // (isSpeaking: boolean) => void
  }

  /** True once init() has completed successfully. */
  get isReady() { return this._ready; }

  /**
   * Create the AudioContext and load the worklet.
   * Must be called from a user-gesture handler (browser policy).
   */
  async init() {
    if (this._ready) return;

    this._ctx = new AudioContext();

    try {
      await this._ctx.audioWorklet.addModule('./js/playback-worklet.js');
    } catch (err) {
      throw new Error(`Playback worklet load failed: ${err.message}`);
    }

    this._worklet = new AudioWorkletNode(this._ctx, 'playback-processor', {
      numberOfInputs:  0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { outputRate: this._ctx.sampleRate },
    });

    // Listen for status updates from the worklet
    const prevSpeaking = { val: false };
    this._worklet.port.onmessage = (e) => {
      const { type, available, amplitude } = e.data;
      if (type === 'status') {
        this._available = available;
        this._amplitude = amplitude;
        const nowSpeaking = available > 0;
        if (nowSpeaking !== prevSpeaking.val) {
          prevSpeaking.val = nowSpeaking;
          this.onSpeakingChange?.(nowSpeaking);
        }
      }
    };

    // Connect worklet output to speakers
    this._worklet.connect(this._ctx.destination);

    // Resume AudioContext in case it started suspended (browser policy)
    if (this._ctx.state === 'suspended') {
      await this._ctx.resume();
    }

    this._ready = true;
  }

  /**
   * Enqueue a chunk of Int16 PCM audio for playback.
   * @param {ArrayBuffer} int16Buffer — ArrayBuffer from geminiLive.onAudioChunk
   */
  enqueue(int16Buffer) {
    if (!this._ready) return;
    // Transfer ownership to the worklet thread for zero-copy
    this._worklet.port.postMessage({ type: 'enqueue', buffer: int16Buffer }, [int16Buffer]);
  }

  /**
   * Immediately stop playback and discard queued audio.
   * Called on barge-in (onModelTurnStart fires while still playing).
   */
  flush() {
    if (!this._ready) return;
    this._worklet.port.postMessage({ type: 'flush' });
    this._available = 0;
    this._amplitude = 0;
  }

  /** True while the ring buffer still has samples to play. */
  get isSpeaking() { return this._available > 0; }

  /** Current playback amplitude, 0..1. Updated every ~3 ms from worklet. */
  get amplitude()  { return this._amplitude; }

  /**
   * Resume a suspended AudioContext (browsers may suspend on tab blur).
   * Call this at the start of any user gesture if audio seems stalled.
   */
  async resume() {
    if (this._ctx?.state === 'suspended') {
      await this._ctx.resume();
    }
  }

  /** Tear down the AudioContext completely. */
  destroy() {
    if (this._worklet) { try { this._worklet.disconnect(); } catch (_) {} }
    if (this._ctx)     { this._ctx.close().catch(() => {}); }
    this._worklet = null;
    this._ctx     = null;
    this._ready   = false;
  }
}
