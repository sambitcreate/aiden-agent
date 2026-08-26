/* global AudioWorkletProcessor:readonly, sampleRate:readonly, registerProcessor:readonly */

class GeminiLivePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.framesPerChunk = Math.max(1, Math.round(sampleRate / 10));
    this.flushed = false;
    this.port.onmessage = (event) => {
      if (event.data?.type !== "flush" || this.flushed) return;
      this.flushed = true;
      if (this.pending.length > 0) {
        const chunk = new Float32Array(this.pending.splice(0));
        this.port.postMessage(chunk, [chunk.buffer]);
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
      this.pending.push(mixed / channels.length);
    }
    while (this.pending.length >= this.framesPerChunk) {
      const chunk = new Float32Array(this.pending.splice(0, this.framesPerChunk));
      this.port.postMessage(chunk, [chunk.buffer]);
    }
    return true;
  }
}

registerProcessor("gemini-live-pcm", GeminiLivePcmProcessor);
