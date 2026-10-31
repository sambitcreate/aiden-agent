import { verificationSnapshot } from "./pi-verification-store.js";
interface HostCommandObservation {
  snapshot: string;
  result: "passed" | "failed" | "inconclusive";
  evidence: string;
}
const observations = new WeakMap<object, HostCommandObservation>();
/** Only the actual process runner calls this. Provider result details cannot forge it. */
export function markHostCommandObservation<T extends object>(value: T, process: {
  exitCode: number | null; timedOut: boolean; outputLimitExceeded: boolean; aborted: boolean;
  stdout: string; stderr: string;
}): T {
  const result = process.aborted || process.timedOut || process.outputLimitExceeded || process.exitCode === null ? "inconclusive" : process.exitCode === 0 ? "passed" : "failed";
  const evidence = JSON.stringify({ exitCode: process.exitCode, timedOut: process.timedOut, outputLimitExceeded: process.outputLimitExceeded, aborted: process.aborted, stdout: process.stdout, stderr: process.stderr });
  observations.set(value, Object.freeze({ result, snapshot: verificationSnapshot(evidence), evidence }));
  return value;
}
export function hostCommandObservation(value: object): Readonly<HostCommandObservation> | undefined {
  return observations.get(value);
}
