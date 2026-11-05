// A node:test reporter that writes only the failed tests, for the CI runner to
// print again once a lane ends. A lane's own output runs to tens of thousands
// of lines, so a failure near its start is otherwise out of sight of the log's
// tail and of anyone skimming it.

const MAX_FAILURES = 50;
const MAX_ERROR_LINES = 40;
const STDERR_LIMIT = 4000;

/** Recent stderr for each file, plus a process-wide tail. A module that fails to load reports only "test failed"; the exception is stderr, sometimes attributed to the imported file rather than the test. */
const stderrByFile = new Map();
let stderrTail = "";

function rememberStderr(file, chunk) {
  if (typeof chunk !== "string" || chunk.length === 0) return;
  stderrTail = `${stderrTail}${chunk}`;
  if (stderrTail.length > STDERR_LIMIT) stderrTail = stderrTail.slice(-STDERR_LIMIT);
  if (!file) return;
  const next = `${stderrByFile.get(file) ?? ""}${chunk}`;
  stderrByFile.set(file, next.length > STDERR_LIMIT ? next.slice(-STDERR_LIMIT) : next);
}

/**
 * A load failure's digest says only "test failed". The runner keeps the child
 * process's stderr, which is where tsx prints a transform or import error the
 * test reporter never receives as an event.
 */
export function withRunnerStderr(digest, stderrTailLines) {
  if (!digest || !Array.isArray(stderrTailLines) || stderrTailLines.length === 0) return digest;
  if (digest.includes("\n  runner stderr:")) return digest;
  const unhelpful = digest.split("\n").some((line) => line === "  Error: test failed" || line === "  test failed");
  if (!unhelpful) return digest;
  const extra = stderrTailLines.slice(-40).map((line) => `  ${String(line)}`).join("\n");
  return `${digest}\n  runner stderr:\n${extra}`;
}

function errorText(error, stderr) {
  // A failed test's error is ERR_TEST_FAILURE. A load failure's cause is the
  // string "test failed", and the exception was written to stderr instead.
  const cause = error?.code === "ERR_TEST_FAILURE" ? error.cause : undefined;
  const thrown = cause instanceof Error ? cause : error;
  const text = thrown instanceof Error ? (thrown.stack ?? `${thrown.name}: ${thrown.message}`) : String(thrown ?? "");
  const lines = text.split("\n");
  // A load failure has no stack; the message is only "test failed".
  const unhelpful = !thrown?.stack || lines.every((line) => line.trim() === "" || /^(?:Error: )?test failed$/u.test(line.trim()));
  if (unhelpful && stderr) {
    lines.push("stderr:", ...stderr.trim().split("\n"));
  }
  return lines.length > MAX_ERROR_LINES ? [...lines.slice(0, MAX_ERROR_LINES), "…"] : lines;
}

export default async function* failureDigest(source) {
  let failures = 0;
  for await (const event of source) {
    if (event.type === "test:stderr") {
      rememberStderr(event.data?.file, event.data?.message);
      continue;
    }
    if (event.type !== "test:fail") continue;
    // A suite fails when a test inside it fails; that test is already listed.
    if (event.data.details?.type === "suite") continue;
    failures += 1;
    if (failures > MAX_FAILURES) continue;
    const { name, file, line, column, details } = event.data;
    const where = file ? `${file}${line ? `:${line}${column ? `:${column}` : ""}` : ""}` : "(unknown file)";
    const stderr = (file ? stderrByFile.get(file) : undefined) || stderrTail;
    yield `not ok ${name}\n  at ${where}\n${errorText(details?.error, stderr).map((text) => `  ${text}`).join("\n")}\n\n`;
  }
  if (failures > MAX_FAILURES) yield `…and ${failures - MAX_FAILURES} more failed tests.\n`;
}
