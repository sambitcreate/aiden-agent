// Filesystem + shell tools that let the Pi agent operate on a workspace folder.
// Every path is resolved against — and confined to — the workspace root, so the
// agent cannot read or write outside the folder the user opened. run_command
// executes with the root as its working directory.
//
// Tool inputs use typebox schemas (pi's AgentTool.parameters), matching tools.ts.

import { exec } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { promisify } from "util";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

const execAsync = promisify(exec);

const MAX_READ_BYTES = 200_000;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_GREP_MATCHES = 200;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".glaze", ".cache"]);

/** Tools whose effects mutate the folder or system — gated behind approval in "ask" mode. */
export const APPROVAL_TOOL_NAMES = new Set(["write_file", "edit_file", "run_command"]);

function textResult(text: string): AgentToolResult<null> {
  return { content: [{ type: "text", text }], details: null };
}

/** Resolve a user/agent-supplied path within the root, rejecting any escape. */
function resolveInRoot(root: string, p: string): string {
  const resolved = path.resolve(root, p ?? ".");
  const rel = path.relative(root, resolved);
  if (rel === "" ) return root;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path "${p}" is outside the workspace folder.`);
  }
  return resolved;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… [truncated, ${text.length - max} more chars]` : text;
}

/** Build a short human summary of a mutating tool call for the approval prompt. */
export function summarizeToolCall(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case "write_file":
      return `Write file: ${String(a.path ?? "?")}`;
    case "edit_file":
      return `Edit file: ${String(a.path ?? "?")}`;
    case "run_command":
      return `Run command: ${String(a.command ?? "?")}`;
    default:
      return toolName;
  }
}

function makeReadFile(root: string): AgentTool {
  return {
    name: "read_file",
    label: "Read File",
    description: "Read a UTF-8 text file from the workspace folder. Paths are relative to the folder root.",
    parameters: Type.Object({ path: Type.String({ description: "File path relative to the workspace folder." }) }),
    execute: async (_id, params): Promise<AgentToolResult<null>> => {
      const { path: p } = params as { path: string };
      const full = resolveInRoot(root, p);
      const buf = await fs.readFile(full);
      const text = buf.subarray(0, MAX_READ_BYTES).toString("utf-8");
      return textResult(buf.length > MAX_READ_BYTES ? `${text}\n… [truncated]` : text || "[empty file]");
    },
  };
}

function makeWriteFile(root: string): AgentTool {
  return {
    name: "write_file",
    label: "Write File",
    description:
      "Create or overwrite a text file in the workspace folder with the given content. Creates parent directories as needed.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to the workspace folder." }),
      content: Type.String({ description: "Full file content to write." }),
    }),
    execute: async (_id, params): Promise<AgentToolResult<null>> => {
      const { path: p, content } = params as { path: string; content: string };
      const full = resolveInRoot(root, p);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf-8");
      return textResult(`Wrote ${content.length} chars to ${p}.`);
    },
  };
}

function makeEditFile(root: string): AgentTool {
  return {
    name: "edit_file",
    label: "Edit File",
    description:
      "Replace an exact substring in an existing file. old_string must appear exactly once; use enough surrounding context to make it unique.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to the workspace folder." }),
      old_string: Type.String({ description: "Exact text to replace (must be unique in the file)." }),
      new_string: Type.String({ description: "Replacement text." }),
    }),
    execute: async (_id, params): Promise<AgentToolResult<null>> => {
      const { path: p, old_string, new_string } = params as {
        path: string;
        old_string: string;
        new_string: string;
      };
      const full = resolveInRoot(root, p);
      const original = await fs.readFile(full, "utf-8");
      const count = original.split(old_string).length - 1;
      if (count === 0) throw new Error(`old_string not found in ${p}.`);
      if (count > 1) throw new Error(`old_string is not unique in ${p} (${count} matches). Add more context.`);
      await fs.writeFile(full, original.replace(old_string, new_string), "utf-8");
      return textResult(`Edited ${p}.`);
    },
  };
}

function makeListDir(root: string): AgentTool {
  return {
    name: "list_dir",
    label: "List Directory",
    description: "List the entries of a directory in the workspace folder.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory relative to the workspace folder (default root)." })),
    }),
    execute: async (_id, params): Promise<AgentToolResult<null>> => {
      const { path: p } = params as { path?: string };
      const full = resolveInRoot(root, p ?? ".");
      const entries = await fs.readdir(full, { withFileTypes: true });
      const lines = entries
        .map((e) => `${e.isDirectory() ? "dir " : "file"}  ${e.name}`)
        .sort();
      return textResult(lines.length ? lines.join("\n") : "[empty directory]");
    },
  };
}

function makeGlob(root: string): AgentTool {
  return {
    name: "glob",
    label: "Find Files",
    description: "Find files in the workspace folder matching a glob pattern, e.g. \"src/**/*.ts\".",
    parameters: Type.Object({ pattern: Type.String({ description: "Glob pattern relative to the workspace folder." }) }),
    execute: async (_id, params): Promise<AgentToolResult<null>> => {
      const { pattern } = params as { pattern: string };
      const matches: string[] = [];
      // fs.glob is available on Node 22+/24.
      for await (const entry of fs.glob(pattern, { cwd: root })) {
        matches.push(entry);
        if (matches.length >= 500) break;
      }
      matches.sort();
      return textResult(matches.length ? matches.join("\n") : "[no matches]");
    },
  };
}

async function grepDir(dir: string, root: string, re: RegExp, out: string[]): Promise<void> {
  if (out.length >= MAX_GREP_MATCHES) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length >= MAX_GREP_MATCHES) return;
    if (entry.name.startsWith(".") && entry.name !== ".env") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await grepDir(full, root, re, out);
      continue;
    }
    if (!entry.isFile()) continue;
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (stat.size > 512_000) continue;
    let content: string;
    try {
      content = await fs.readFile(full, "utf-8");
    } catch {
      continue; // Binary or unreadable — skip.
    }
    const rel = path.relative(root, full);
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        out.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        if (out.length >= MAX_GREP_MATCHES) return;
      }
    }
  }
}

function makeGrep(root: string): AgentTool {
  return {
    name: "grep",
    label: "Search Files",
    description:
      "Search the workspace folder for lines matching a regular expression. Returns file:line: match, capped at 200 hits.",
    parameters: Type.Object({
      pattern: Type.String({ description: "JavaScript regular expression to search for." }),
      path: Type.Optional(Type.String({ description: "Subdirectory to limit the search to (default root)." })),
    }),
    execute: async (_id, params): Promise<AgentToolResult<null>> => {
      const { pattern, path: p } = params as { pattern: string; path?: string };
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (e) {
        throw new Error(`Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`);
      }
      const start = resolveInRoot(root, p ?? ".");
      const out: string[] = [];
      await grepDir(start, root, re, out);
      return textResult(out.length ? out.join("\n") : "[no matches]");
    },
  };
}

function makeRunCommand(root: string): AgentTool {
  return {
    name: "run_command",
    label: "Run Command",
    description:
      "Run a shell command with the workspace folder as the working directory. Returns combined stdout/stderr (capped). Use for builds, tests, git, package managers, etc.",
    parameters: Type.Object({ command: Type.String({ description: "The shell command to run." }) }),
    execute: async (_id, params): Promise<AgentToolResult<null>> => {
      const { command } = params as { command: string };
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: root,
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
        return textResult(truncate(combined || "[no output]", MAX_OUTPUT_CHARS));
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string; message?: string; code?: number };
        const combined = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").trim();
        return textResult(truncate(`Command exited with error (code ${e.code ?? "?"}):\n${combined}`, MAX_OUTPUT_CHARS));
      }
    },
  };
}

/** All folder-scoped tools for a workspace root, in a sensible ordering. */
export function buildCodingTools(root: string): AgentTool[] {
  return [
    makeReadFile(root),
    makeListDir(root),
    makeGlob(root),
    makeGrep(root),
    makeEditFile(root),
    makeWriteFile(root),
    makeRunCommand(root),
  ];
}
