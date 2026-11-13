import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isEnvironmentSecretPath, isProtectedCredentialPath } from "../../../main/services/model-file-policy.js";
import { buildCodingTools } from "../../../main/services/coding-tools.js";
import { ForegroundReadOperations } from "../../../main/services/foreground-read-scope.js";

const credentialReads = new ForegroundReadOperations();
const SEARCH_DURATION_MS = 5_000;

/** Desktop file/shell tools with the CLI credential-read policy applied. */
export function cliWorkspaceCodingTools(cwd: string, readOnly = false) {
  const cliEntry = process.env.AIDEN_CLI_ENTRY;
  const fileMutatorBinary = cliEntry
    ? join(dirname(cliEntry), "native", "aiden-subagent-file-mutator")
    : undefined;
  const lexicalRoot = resolve(cwd), canonicalRoot = realpathSync(cwd);
  const assertReadPath = async (file: string, root = canonicalRoot) => {
    const local = relative(root, file);
    if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) {
      throw new Error("The requested read is outside the workspace folder.");
    }
    // The policy distinguishes safe hidden files from safe hidden directories.
    const info = await stat(file);
    const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "unknown";
    if (isEnvironmentSecretPath(local)) {
      throw new Error("Reading .env files is disabled to keep workspace secrets out of model context.");
    }
    if (isProtectedCredentialPath(local, kind)) {
      throw new Error("Reading credential files is disabled to keep workspace secrets out of model context.");
    }
  };
  const tools = buildCodingTools(cwd, undefined, { fileMutatorBinary, assertReadPath });
  for (const tool of tools) {
    if (!["read_file", "list_dir", "grep"].includes(tool.name)) continue;
    const execute = tool.execute;
    tool.execute = (id, params, signal, onUpdate) => credentialReads.run<Awaited<ReturnType<typeof execute>>>(
      signal,
      tool.name === "read_file" ? undefined : SEARCH_DURATION_MS,
      async (operationSignal) => {
        const supplied = (params as { path?: unknown }).path;
        // The shared tools resolve aliases before their canonical read fence.
        // Check supplied names too, inside a cancellable, bounded read owner.
        if (typeof supplied === "string") await assertReadPath(resolve(lexicalRoot, supplied), lexicalRoot);
        operationSignal.throwIfAborted();
        return execute(id, params, operationSignal, onUpdate);
      },
      () => ({ content: [{ type: "text", text: `… [search stopped after ${SEARCH_DURATION_MS} ms]` }], details: null }),
    );
  }
  return readOnly
    ? tools.filter((tool) => ["read_file", "list_dir", "glob", "grep"].includes(tool.name))
    : tools;
}
