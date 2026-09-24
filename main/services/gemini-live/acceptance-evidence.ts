import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const GEMINI_LIVE_ACCEPTANCE_EVIDENCE_ENV =
  "AIDEN_GEMINI_LIVE_ACCEPTANCE_EVIDENCE_PATH";
export const GEMINI_LIVE_ACCEPTANCE_EVIDENCE_FILE =
  "gemini-live-acceptance-evidence.jsonl";

export type GeminiLiveAcceptanceEvidenceEvent =
  "ready" | "provider_response" | "stop_requested" | "stopped";

export interface GeminiLiveAcceptanceEvidenceRecorder {
  record(event: GeminiLiveAcceptanceEvidenceEvent, sessionId: string): void;
}

/**
 * Production-inert fixed-event recorder for the explicit real-provider smoke.
 * The exact path must live at the expected name inside the isolated userData.
 */
export function createGeminiLiveAcceptanceEvidenceRecorder(
  environment: Readonly<Record<string, string | undefined>>,
  userDataPath: string,
  now: () => number = Date.now,
): GeminiLiveAcceptanceEvidenceRecorder | null {
  if (environment.AIDEN_GEMINI_LIVE_REAL_ACCEPTANCE?.trim() !== "1")
    return null;
  const configuredPath =
    environment[GEMINI_LIVE_ACCEPTANCE_EVIDENCE_ENV]?.trim();
  if (!configuredPath || !path.isAbsolute(configuredPath)) return null;
  const expectedPath = path.join(
    path.resolve(userDataPath),
    GEMINI_LIVE_ACCEPTANCE_EVIDENCE_FILE,
  );
  if (path.resolve(configuredPath) !== expectedPath) return null;

  try {
    writeFileSync(expectedPath, "", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    return null;
  }
  const started = now();
  const recorded = new Set<GeminiLiveAcceptanceEvidenceEvent>();
  let acceptedSessionId: string | null = null;
  return {
    record(event, sessionId) {
      if (!acceptedSessionId) {
        if (event !== "ready" || !sessionId) return;
        acceptedSessionId = sessionId;
      }
      if (sessionId !== acceptedSessionId) return;
      if (recorded.has(event)) return;
      recorded.add(event);
      try {
        appendFileSync(
          expectedPath,
          `${JSON.stringify({ event, elapsedMs: Math.max(0, now() - started), sessionId })}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      } catch {
        // The smoke runner fails closed when a marker is absent. Evidence I/O
        // must never change normal Live teardown behavior.
      }
    },
  };
}
