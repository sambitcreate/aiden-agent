// A node:test reporter that writes only the failed tests, for the CI runner to
// print again once a lane ends. A lane's own output runs to tens of thousands
// of lines, so a failure near its start is otherwise out of sight of the log's
// tail and of anyone skimming it.

const MAX_FAILURES = 50;
const MAX_ERROR_LINES = 40;
const STDERR_LIMIT = 4000;

/** Recent stderr for each file. A module that fails to load reports only "test failed"; the exception is stderr. */
const stderrByFile = new Map();

function rememberStderr(file, chunk) {
  if (!file || typeof chunk !== "string" || chunk.length === 0) return;
  const next = `${stderrByFile.get(file) ?? ""}${chunk}`;
  stderrByFile.set(file, next.length > STDERR_LIMIT ? next.slice(-STDERR_LIMIT) : next);
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
    const stderr = file ? stderrByFile.get(file) : undefined;
    yield `not ok ${name}\n  at ${where}\n${errorText(details?.error, stderr).map((text) => `  ${text}`).join("\n")}\n\n`;
  }
  if (failures > MAX_FAILURES) yield `…and ${failures - MAX_FAILURES} more failed tests.\n`;
}
