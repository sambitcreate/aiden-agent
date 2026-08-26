import type {
  AmbientMusicDegradation,
  AmbientMusicMetrics,
} from "../../renderer/shared/ambient-music.js";

const FRAME_PRESSURE_MS = 40;
const BUFFER_PRESSURE_RATIO = 0.25;
const PRESSURE_SAMPLES_TO_REPORT = 2;
const HEALTHY_SAMPLES_TO_CLEAR = 3;

export class AmbientMusicDegradationMonitor {
  private previousDroppedFrames: number | undefined;
  private pressureSamples = 0;
  private healthySamples = 0;
  private activeSince: string | undefined;
  private current: AmbientMusicDegradation | undefined;

  observe(metrics: AmbientMusicMetrics, now = Date.now()): AmbientMusicDegradation | undefined {
    const bufferRatio = metrics.bufferCapacity > 0
      ? Math.max(0, Math.min(1, metrics.bufferAvailable / metrics.bufferCapacity))
      : 0;
    const droppedFramesSinceLastSample = this.previousDroppedFrames === undefined
      ? metrics.droppedFrames
      : Math.max(0, metrics.droppedFrames - this.previousDroppedFrames);
    this.previousDroppedFrames = metrics.droppedFrames;
    const pressured =
      metrics.frameMs >= FRAME_PRESSURE_MS ||
      bufferRatio < BUFFER_PRESSURE_RATIO ||
      droppedFramesSinceLastSample > 0;

    if (pressured) {
      this.pressureSamples += 1;
      this.healthySamples = 0;
      if (this.pressureSamples >= PRESSURE_SAMPLES_TO_REPORT || this.current) {
        this.activeSince ??= new Date(now).toISOString();
        this.current = {
          code: "realtime_pressure",
          since: this.activeSince,
          frameMs: metrics.frameMs,
          bufferRatio,
          droppedFramesSinceLastSample,
        };
      }
      return this.current;
    }

    this.pressureSamples = 0;
    this.healthySamples += 1;
    if (this.current && this.healthySamples >= HEALTHY_SAMPLES_TO_CLEAR) {
      this.current = undefined;
      this.activeSince = undefined;
    }
    return this.current;
  }

  reset(droppedFramesBaseline?: number): void {
    this.previousDroppedFrames = droppedFramesBaseline;
    this.pressureSamples = 0;
    this.healthySamples = 0;
    this.activeSince = undefined;
    this.current = undefined;
  }
}

export function sameAmbientMusicDegradation(
  left: AmbientMusicDegradation | undefined,
  right: AmbientMusicDegradation | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.code === right.code &&
    left.since === right.since &&
    left.frameMs === right.frameMs &&
    left.bufferRatio === right.bufferRatio &&
    left.droppedFramesSinceLastSample === right.droppedFramesSinceLastSample;
}
