import type {
  AmbientMusicFeatureSnapshot,
  AmbientMusicPromptStyle,
} from "../shared/ambient-music.js";

export function newestAmbientMusicSnapshot(
  current: AmbientMusicFeatureSnapshot | undefined,
  next: AmbientMusicFeatureSnapshot,
): AmbientMusicFeatureSnapshot {
  return current && current.revision > next.revision ? current : next;
}

export function ambientMusicPromptError(text: string, weight = 1): string | undefined {
  const trimmed = text.trim();
  if (!trimmed && weight === 0) return undefined;
  if (!trimmed) return "Enter a music style prompt.";
  if (new TextEncoder().encode(trimmed).byteLength > 200) {
    return "Keep this prompt to 200 UTF-8 bytes or fewer.";
  }
  if (Array.from(trimmed).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  })) return "Remove control characters from this prompt.";
  return undefined;
}

export function activeAmbientMusicPrompts(
  prompts: AmbientMusicPromptStyle[],
): AmbientMusicPromptStyle[] {
  return prompts
    .filter((prompt) => prompt.text.trim().length > 0 || prompt.weight > 0)
    .map((prompt) => ({ ...prompt }));
}

export function ambientMusicRowsMatchAppliedMix(
  draft: AmbientMusicPromptStyle[],
  applied: AmbientMusicPromptStyle[],
): boolean {
  return draft.length === applied.length &&
    draft.every((prompt, index) => prompt.id === applied[index]?.id);
}

export class LatestAmbientMusicControl<T> {
  private latest: T | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private disposed = false;

  constructor(
    private readonly intervalMs: number,
    private readonly dispatch: (value: T) => Promise<void>,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  push(value: T): void {
    if (this.disposed) return;
    this.latest = value;
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    this.latest = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.disposed || this.running || this.timer || this.latest === undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, this.intervalMs);
  }

  private async drain(): Promise<void> {
    const value = this.latest;
    this.latest = undefined;
    if (this.disposed || value === undefined) return;
    this.running = true;
    try {
      await this.dispatch(value);
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = false;
      this.schedule();
    }
  }
}

export class OrderedAmbientMusicPersistence<T, R> {
  private pending: T | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly delayMs: number,
    private readonly write: (value: T) => Promise<R>,
    private readonly onDeferredError: (error: unknown) => void = () => undefined,
  ) {}

  schedule(value: T): void {
    if (this.disposed) return;
    this.pending = value;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const pending = this.pending;
      this.pending = undefined;
      if (pending === undefined) return;
      void this.enqueue(pending).catch(this.onDeferredError);
    }, this.delayMs);
  }

  writeNow(value: T): Promise<R> {
    if (this.disposed) return Promise.reject(new Error("Ambient Music settings are closing."));
    this.cancelScheduled();
    return this.enqueue(value);
  }

  cancelScheduled(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }

  async settle(): Promise<void> {
    await this.queue;
  }

  dispose(flush = true): void {
    if (this.disposed) return;
    const pending = flush ? this.pending : undefined;
    this.cancelScheduled();
    if (pending !== undefined) void this.enqueue(pending).catch(this.onDeferredError);
    this.disposed = true;
  }

  private enqueue(value: T): Promise<R> {
    const result = this.queue.then(() => this.write(value), () => this.write(value));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function normalizeAmbientMusicPrompts(
  prompts: AmbientMusicPromptStyle[],
): AmbientMusicPromptStyle[] {
  const total = prompts.reduce((sum, prompt) => sum + prompt.weight, 0);
  if (total <= 0) return prompts.map((prompt) => ({ ...prompt }));
  return prompts.map((prompt) => ({ ...prompt, weight: prompt.weight / total }));
}

export function setAmbientMusicPromptWeight(
  prompts: AmbientMusicPromptStyle[],
  id: string,
  requestedWeight: number,
): AmbientMusicPromptStyle[] {
  if (prompts.length === 0 || !prompts.some((prompt) => prompt.id === id)) {
    return prompts.map((prompt) => ({ ...prompt }));
  }
  if (prompts.length === 1) return [{ ...prompts[0], weight: 1 }];
  const weight = Math.max(0, Math.min(1, requestedWeight));
  const others = prompts.filter((prompt) => prompt.id !== id);
  const otherTotal = others.reduce((sum, prompt) => sum + prompt.weight, 0);
  const remaining = 1 - weight;
  return prompts.map((prompt) => {
    if (prompt.id === id) return { ...prompt, weight };
    const nextWeight = otherTotal > 0
      ? (prompt.weight / otherTotal) * remaining
      : remaining / others.length;
    return { ...prompt, weight: nextWeight };
  });
}

export function ambientMusicPromptSignature(prompts: AmbientMusicPromptStyle[]): string {
  return JSON.stringify(prompts.map((prompt) => [prompt.id, prompt.text.trim()]));
}
