/* global AudioWorkletProcessor:readonly, sampleRate:readonly, registerProcessor:readonly */

// Mixes the input to mono and posts 100 ms Float32 chunks. Samples go straight
// into a preallocated chunk, so the audio thread does no per-sample allocation.
class GeminiLivePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.framesPerChunk = Math.max(1, Math.round(sampleRate / 10));
    this.chunk = new Float32Array(this.framesPerChunk);
    this.filled = 0;
    this.flushed = false;
    this.port.onmessage = (event) => {
      if (event.data?.type !== "flush" || this.flushed) return;
      this.flushed = true;
      if (this.filled > 0) {
        const tail = this.chunk.slice(0, this.filled);
        this.port.postMessage(tail, [tail.buffer]);
        this.filled = 0;
      }
      this.port.postMessage({ type: "flushed" });
    };
  }

  process(inputs) {
    if (this.flushed) return false;
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const frames = channels[0].length;
    for (let frame = 0; frame < frames; frame += 1) {
      let mixed = 0;
      for (let channel = 0; channel < channels.length; channel += 1) {
        mixed += channels[channel][frame] || 0;
      }
      this.chunk[this.filled] = mixed / channels.length;
      this.filled += 1;
      if (this.filled === this.framesPerChunk) {
        // The full chunk's buffer is transferred, so the next one starts fresh.
        const full = this.chunk;
        this.port.postMessage(full, [full.buffer]);
        this.chunk = new Float32Array(this.framesPerChunk);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("gemini-live-pcm", GeminiLivePcmProcessor);
