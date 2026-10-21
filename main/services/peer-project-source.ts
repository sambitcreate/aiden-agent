import { capturePeerProjectRoot, readPeerProjectFile } from "./peer-project-file-io.js";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { agentCommandEnvironment } from "./agent-command-environment.js";
import { resolveGitExecutableMemoized } from "./git-executable.js";
import { primaryRemoteUrl } from "./repository-identity.js";
import { parseCloneUrl } from "../../renderer/shared/workspace-intake.js";
import {
  isPeerProjectEnvironmentFile, PEER_PROJECT_FILE_MAX_BYTES, PEER_PROJECT_FILES_MAX_BYTES,
  PEER_PROJECT_FILES_MAX_COUNT, type PeerProjectFile, type PeerProjectSource,
} from "../../renderer/shared/peer-project-clone.js";
import type { Workspace } from "./types.js";

const run = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...agentCommandEnvironment(), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_CONFIG", "GIT_CONFIG_COUNT"]) delete env[key];
  const binary = await resolveGitExecutableMemoized("git", cwd, env);
  return (await run(binary, ["-c", "core.fsmonitor=false", ...args], { cwd, env, encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 })).stdout;
}

/** Only metadata enters the renderer; selected file contents go straight to the peer transport. */
export function createPeerProjectSource(options: { getWorkspace(id: string): Promise<Workspace | null | undefined>; git?: typeof git }) {
  const command = options.git ?? git;
  const inspect = async (id: string) => {
    const workspace = await options.getWorkspace(id);
    if (!workspace?.folderPath) throw new Error("Choose a project with a repository folder.");
    const folder = await fs.realpath(workspace.folderPath);
    let remote: string | undefined;
    try {
      if (await fs.realpath((await command(folder, ["rev-parse", "--show-toplevel"])).trim()) !== folder) throw new Error("nested");
      remote = primaryRemoteUrl(await command(folder, ["remote", "-v"]));
    } catch { throw new Error("Choose a project at its Git repository root."); }
    const parsed = parseCloneUrl(remote);
    if (!parsed.ok) throw new Error("This project needs a credential-free HTTPS or SSH Git remote.");
    const files: PeerProjectSource["files"] = [];
    for (const name of (await fs.readdir(folder)).filter(isPeerProjectEnvironmentFile).sort()) {
      const stat = await fs.lstat(path.join(folder, name));
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > PEER_PROJECT_FILE_MAX_BYTES) continue;
      try { await command(folder, ["check-ignore", "-q", "--", name]); } catch { continue; }
      if (files.length < PEER_PROJECT_FILES_MAX_COUNT) files.push({ name, bytes: stat.size });
    }
    return { folder, source: { name: workspace.name, url: parsed.url, repositoryName: parsed.repoName, files } };
  };
  return {
    async preview(id: string): Promise<PeerProjectSource> { return (await inspect(id)).source; },
    async read(id: string, selected: unknown): Promise<{ source: PeerProjectSource; files: PeerProjectFile[] }> {
      if (!Array.isArray(selected) || selected.length > PEER_PROJECT_FILES_MAX_COUNT || selected.some(name => !isPeerProjectEnvironmentFile(name)) || new Set(selected).size !== selected.length) throw new Error("Choose valid environment files to copy.");
      const { folder, source } = await inspect(id);
      if (selected.some(name => !source.files.some(file => file.name === name))) throw new Error("The environment file list changed. Open the transfer again.");
      const root = await capturePeerProjectRoot(folder);
      const files: PeerProjectFile[] = [];
      let total = 0;
      for (const name of selected as string[]) {
        const stat = await fs.lstat(path.join(folder, name), { bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(PEER_PROJECT_FILE_MAX_BYTES)) throw new Error("An environment file changed or is too large.");
        const buffer = await readPeerProjectFile(root, name, { device: String(stat.dev), inode: String(stat.ino) });
        total += buffer.length;
        if (total > PEER_PROJECT_FILES_MAX_BYTES) throw new Error("The selected environment files exceed the transfer limit.");
        const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        if (content.includes("\0")) throw new Error("Only UTF-8 environment text files can be copied.");
        files.push({ name, content });
      }
      return { source, files };
    },
  };
}
