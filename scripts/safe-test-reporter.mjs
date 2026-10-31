import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const statuses = new Set(["failed", "timedOut", "interrupted"]);
export function safeTestResult(test, result, root = process.cwd()) {
  const relative = path.relative(root, test.location?.file ?? "").split(path.sep).join("/");
  if (!/^tests\/e2e\/[a-zA-Z0-9_/-]+\.spec\.ts$/.test(relative) || relative.includes("..")) return undefined;
  if (!statuses.has(result.status)) return undefined;
  const title = test.titlePath().join("\0");
  return {
    testId: createHash("sha256").update(`${relative}\0${title}`).digest("hex"),
    category: result.status === "timedOut" ? "timeout" : result.status === "interrupted" ? "cancelled" : "test-failed",
    phase: "test", retry: Math.max(0, Math.min(1, Math.trunc(result.retry || 0))),
    durationMs: Math.max(0, Math.min(86_400_000, Math.round(result.duration || 0))),
  };
}
export default class SafeTestReporter {
  records = [];
  onTestEnd(test, result) {
    const record = safeTestResult(test, result);
    if (record && this.records.length < 256) this.records.push(record);
  }
  onError() {
    if (this.records.length < 256) this.records.push({ category: "setup-failed", phase: "setup", retry: 0, durationMs: 0 });
  }
  onEnd() {
    fs.mkdirSync("test-results", { recursive: true, mode: 0o700 });
    fs.writeFileSync("test-results/safe-test-details.json", JSON.stringify(this.records), { mode: 0o600 });
  }
}
export function sanitizeTestDetails(value) {
  if (!Array.isArray(value) || value.length > 256) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || !["test-failed", "timeout", "cancelled", "setup-failed"].includes(item.category) || !["test", "setup"].includes(item.phase)) return [];
    if (!Number.isInteger(item.retry) || item.retry < 0 || item.retry > 1 || !Number.isInteger(item.durationMs) || item.durationMs < 0 || item.durationMs > 86_400_000) return [];
    if (item.phase === "test" && !/^[a-f0-9]{64}$/.test(item.testId ?? "")) return [];
    return [{ ...(item.phase === "test" ? { testId: item.testId } : {}), category: item.category, phase: item.phase, retry: item.retry, durationMs: item.durationMs }];
  });
}
