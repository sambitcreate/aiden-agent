// A node:test reporter that writes only the failed tests, for the CI runner to
// print again once a lane ends. A lane's own output runs to tens of thousands
// of lines, so a failure near its start is otherwise out of sight of the log's
// tail and of anyone skimming it.

const MAX_FAILURES = 50;
const MAX_ERROR_LINES = 60;
const STDERR_LIMIT = 8000;
const NOTABLE = /Error|ERR_|Cannot find|SyntaxError|does not provide|Transform failed|ReferenceError|TypeError|failed to load/u;
const NOISE = /not wrapped in act|wrap-tests-with-act/u;

/** Recent stderr for each file. Act warnings from the rest of the lane are noise and must not crowd out the load error. */
const stderrByFile = new Map();
const notableLines = [];

function rememberStderr(file, chunk) {
  if (typeof chunk !== "string" || chunk.length === 0) return;
  if (file) {
    const next = `${stderrByFile.get(file) ?? ""}${chunk}`;
    stderrByFile.set(file, next.length > STDERR_LIMIT ? next.slice(-STDERR_LIMIT) : next);
  }
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || NOISE.test(trimmed) || !NOTABLE.test(trimmed)) continue;
    notableLines.push(trimmed.slice(0, 500));
    if (notableLines.length > 80) notableLines.shift();
  }
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

function notableFor(file) {
  const base = file?.split(/[\\/]/u).pop();
  const matched = base ? notableLines.filter((line) => line.includes(base)) : [];
  return (matched.length > 0 ? matched : notableLines).slice(-20);
}

function errorText(error, stderr, file) {
  // A failed test's error is ERR_TEST_FAILURE. A load failure's cause is the
  // string "test failed", and the exception was written to stderr instead.
  const cause = error?.code === "ERR_TEST_FAILURE" ? error.cause : undefined;
  const thrown = cause instanceof Error ? cause : error;
  const text = thrown instanceof Error ? (thrown.stack ?? `${thrown.name}: ${thrown.message}`) : String(thrown ?? "");
  const lines = text.split("\n");
  // A load failure has no stack; the message is only "test failed".
  const unhelpful = !thrown?.stack || lines.every((line) => line.trim() === "" || /^(?:Error: )?test failed$/u.test(line.trim()));
  if (unhelpful) {
    const notable = notableFor(file);
    if (notable.length > 0) lines.push("notable:", ...notable);
    else if (stderr) lines.push("stderr:", ...stderr.trim().split("\n").slice(-15));
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
    const stderr = file ? stderrByFile.get(file) : undefined;
    yield `not ok ${name}\n  at ${where}\n${errorText(details?.error, stderr, file).map((text) => `  ${text}`).join("\n")}\n\n`;
  }
  if (failures > MAX_FAILURES) yield `…and ${failures - MAX_FAILURES} more failed tests.\n`;
}
