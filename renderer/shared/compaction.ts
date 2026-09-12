/** One automatic preference; commands may override it for one operation. */
export type CompactionEngine = "llm" | "vcc";

export function isCompactionEngine(value: unknown): value is CompactionEngine {
  return value === "llm" || value === "vcc";
}

export function compactionEngineFrom(value: unknown): CompactionEngine {
  return isCompactionEngine(value) ? value : "llm";
}

export function compactionEngineLabel(engine: CompactionEngine): string {
  return engine === "vcc" ? "pi-vcc" : "LLM";
}
