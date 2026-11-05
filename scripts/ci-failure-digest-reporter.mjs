// A node:test reporter that writes only the failed tests, for the CI runner to
// print again once a lane ends. A lane's own output runs to tens of thousands
// of lines, so a failure near its start is otherwise out of sight of the log's
// tail and of anyone skimming it.

const MAX_FAILURES = 50;
const MAX_ERROR_LINES = 30;

function errorText(error) {
  // A failed test's error is ERR_TEST_FAILURE; what the test threw is its cause.
  const thrown = error?.code === "ERR_TEST_FAILURE" && error.cause !== undefined ? error.cause : error;
  const text = thrown instanceof Error ? (thrown.stack ?? `${thrown.name}: ${thrown.message}`) : String(thrown);
  const lines = text.split("\n");
  return lines.length > MAX_ERROR_LINES ? [...lines.slice(0, MAX_ERROR_LINES), "…"] : lines;
}

export default async function* failureDigest(source) {
  let failures = 0;
  for await (const event of source) {
    if (event.type !== "test:fail") continue;
    // A suite fails when a test inside it fails; that test is already listed.
    if (event.data.details?.type === "suite") continue;
    failures += 1;
    if (failures > MAX_FAILURES) continue;
    const { name, file, line, column, details } = event.data;
    const where = file ? `${file}${line ? `:${line}${column ? `:${column}` : ""}` : ""}` : "(unknown file)";
    yield `not ok ${name}\n  at ${where}\n${errorText(details?.error).map((text) => `  ${text}`).join("\n")}\n\n`;
  }
  if (failures > MAX_FAILURES) yield `…and ${failures - MAX_FAILURES} more failed tests.\n`;
}
