import { parseGenerationTimeline, type GenerationTimeline } from "../../renderer/shared/generation-timeline.js";

const MAX_PREFIX_LENGTH = 32_768;
const MAX_TIMELINE_BYTES = 128 * 1024;

/** Retain only content that already passed the public run-event projection. */
export class RunTranscriptCheckpoint {
  text: string | undefined = "";
  reasoning: string | undefined = "";
  timeline: GenerationTimeline | undefined;

  constructor(complete = true) {
    if (!complete) this.text = this.reasoning = undefined;
  }

  apply(type: string, payload: Record<string, unknown>): void {
    if (type === "text_delta" || type === "reasoning_delta") {
      const key = type === "text_delta" ? "text" : "reasoning";
      const prefix = this[key];
      if (prefix !== undefined && typeof payload.text === "string") {
        this[key] = prefix.length + payload.text.length <= MAX_PREFIX_LENGTH ? prefix + payload.text : undefined;
      }
    } else if (type === "timeline") {
      this.setTimeline(payload.timeline);
    } else if (type === "snapshot") {
      if (payload.reason === "gap") {
        this.text = boundedPrefix(payload.replyText);
        this.reasoning = boundedPrefix(payload.replyReasoning);
        this.setTimeline(payload.timeline);
      } else {
        this.text = this.reasoning = "";
        this.timeline = undefined;
      }
    }
  }

  private setTimeline(value: unknown): void {
    const timeline = parseGenerationTimeline(value);
    this.timeline = timeline && Buffer.byteLength(JSON.stringify(timeline)) <= MAX_TIMELINE_BYTES ? timeline : undefined;
  }

  payload(): Record<string, unknown> {
    return {
      ...(this.text !== undefined ? { replyText: this.text } : {}),
      ...(this.reasoning !== undefined ? { replyReasoning: this.reasoning } : {}),
      ...(this.timeline ? { timeline: this.timeline } : {}),
    };
  }
}

function boundedPrefix(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_PREFIX_LENGTH ? value : undefined;
}
