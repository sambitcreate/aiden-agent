/* global AudioWorkletProcessor, registerProcessor, sampleRate */

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_MS = 20;
const TARGET_SAMPLES = (TARGET_SAMPLE_RATE * CHUNK_MS) / 1000;
const SOURCE_SAMPLES = Math.round((sampleRate * CHUNK_MS) / 1000);

function resample(source) {
  const result = new Array(TARGET_SAMPLES);
  const ratio = source.length / TARGET_SAMPLES;
  for (let target = 0; target < TARGET_SAMPLES; target += 1) {
    const start = target * ratio;
    const end = (target + 1) * ratio;
    const first = Math.floor(start);
    const last = Math.min(source.length - 1, Math.ceil(end) - 1);
    let sum = 0;
    let weight = 0;
    for (let index = first; index <= last; index += 1) {
      const overlap = Math.max(0, Math.min(end, index + 1) - Math.max(start, index));
      sum += (source[index] ?? 0) * overlap;
      weight += overlap;
    }
    result[target] = weight > 0 ? sum / weight : 0;
  }
  return result;
}

function pcm16le(samples) {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    const integer = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
    view.setInt16(index * 2, integer, true);
  }
  return buffer;
}

class AidenGeminiLivePcmProcessor extends AudioWorkletProcessor {
  pending = [];

  process(inputs) {
    const mono = inputs[0]?.[0];
    if (mono) {
      for (const sample of mono) this.pending.push(Number.isFinite(sample) ? sample : 0);
    }
    while (this.pending.length >= SOURCE_SAMPLES) {
      const source = this.pending.slice(0, SOURCE_SAMPLES);
      this.pending = this.pending.slice(SOURCE_SAMPLES);
      const data = pcm16le(resample(source));
      this.port.postMessage(
        {
          type: "pcm",
          channels: 1,
          durationMs: CHUNK_MS,
          sampleRate: TARGET_SAMPLE_RATE,
          data,
        },
        [data],
      );
    }
    return true;
  }
}

registerProcessor("aiden-gemini-live-pcm", AidenGeminiLivePcmProcessor);

