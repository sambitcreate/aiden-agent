import { dirname, join } from "node:path";
import { buildCodingTools } from "../../../main/services/coding-tools.js";

/** The server shares the desktop file policy and bounded shell tools. */
export function cliWorkspaceCodingTools(cwd: string, readOnly = false) {
  const cliEntry = process.env.AIDEN_CLI_ENTRY;
  const fileMutatorBinary = cliEntry
    ? join(dirname(cliEntry), "native", "aiden-subagent-file-mutator")
    : undefined;
  const tools = buildCodingTools(cwd, undefined, { fileMutatorBinary });
  return readOnly
    ? tools.filter((tool) => ["read_file", "list_dir", "glob", "grep"].includes(tool.name))
    : tools;
}
