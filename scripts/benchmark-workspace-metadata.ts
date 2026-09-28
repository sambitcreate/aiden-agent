/** Synthetic, local-only comparison; no provider calls or application profile. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listWorkspaceFiles } from "../main/services/workspace-files.js";
import { AidenRemoteFileService } from "../main/services/aiden-remote-files.js";
import { AidenRemoteWorkspaceOwnerRegistry } from "../main/services/aiden-remote-workspace-owners.js";
import { createWorkspaceEnvironmentApplicationService } from "../main/services/workspace-environment-application-service.js";
import { WorkspaceMutationGate } from "../main/services/workspace-mutation-gate.js";
import { WorkspaceOperationRegistry } from "../main/services/workspace-operation-registry.js";
import { buildGeminiWorkspaceSnapshot } from "../main/services/gemini-context-cache.js";

const baseline = process.argv[2] ?? "a9baa4aa3027893e5455043083465c34b4c8b4ac";
const latencyMs = Number(process.env.METADATA_LATENCY_MS ?? 0);
assert.ok(Number.isFinite(latencyMs) && latencyMs >= 0 && latencyMs <= 100);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-metadata-benchmark-"));
const servicePath = path.resolve("main/services");
try {
  for (const name of ["workspace-files", "aiden-remote-files"]) {
    const source = execFileSync("git", ["show", `${baseline}:main/services/${name}.ts`], { encoding: "utf8" });
    const rewritten = source.replace(/from "\.\/([^"]+)\.js"/gu, (_, dependency: string) =>
      `from "${pathToFileURL(path.join(dependency === "workspace-files" ? temporary : servicePath, `${dependency}.ts`)).href}"`);
    await fs.writeFile(path.join(temporary, `${name}.ts`), rewritten);
  }
  const beforeFiles = await import(pathToFileURL(path.join(temporary, "workspace-files.ts")).href);
  const beforeRemote = await import(pathToFileURL(path.join(temporary, "aiden-remote-files.ts")).href);
  const variants = [
    { name: "before", list: beforeFiles.listWorkspaceFiles as typeof listWorkspaceFiles, Remote: beforeRemote.AidenRemoteFileService as typeof AidenRemoteFileService },
    { name: "after", list: listWorkspaceFiles, Remote: AidenRemoteFileService },
  ];
  const results = [];
  for (const shape of ["wide", "deep"] as const) {
    const root = path.join(temporary, shape);
    await fs.mkdir(root);
    let directory = root;
    for (let start = 0; start < 4_000; start += 100) {
      if (shape === "deep" && start % 200 === 0) {
        directory = path.join(directory, "nested");
        await fs.mkdir(directory);
      }
      await Promise.all(Array.from({ length: 100 }, (_, offset) => fs.writeFile(path.join(directory, `file${start + offset}.txt`), "fixture")));
    }
    const workspace = { id: "workspace", name: "Synthetic", folderPath: root, permission: "ask" as const, createdAt: 1, updatedAt: 2 };
    const application = createWorkspaceEnvironmentApplicationService({
      configStore: { getWorkspace: async () => workspace },
      workspaceMutationGate: new WorkspaceMutationGate(), workspaceOperationRegistry: new WorkspaceOperationRegistry(),
      assertManagedWorktreeAdmission: async () => undefined, realpath: fs.realpath, stat: fs.stat,
    });
    for (const operation of ["gemini-index", "legacy-remote"] as const) {
      let expected: unknown;
      for (const variant of variants) {
        const originals = { stat: fs.stat, realpath: fs.realpath, readdir: fs.readdir, readFile: fs.readFile, open: fs.open };
        const calls = { stat: 0, realpath: 0, readdir: 0, readFile: 0, open: 0 };
        let activeStats = 0;
        let peakStats = 0;
        let identityStats = 0;
        let activeIdentities = 0;
        let peakIdentities = 0;
        const visits = new Map<string, number>();
        for (const key of Object.keys(originals) as Array<keyof typeof originals>) {
          // Each wrapper calls the real filesystem; counters include all reads.
          Object.assign(fs, { [key]: async (...args: unknown[]) => {
            calls[key] += 1;
            const file = String(args[0]);
            const visit = key === "stat" ? (visits.get(file) ?? 0) + 1 : 0;
            const identity = key === "stat" && file.endsWith(".txt") && visit > 1;
            if (key === "stat") {
              visits.set(file, visit);
              peakStats = Math.max(peakStats, ++activeStats);
              if (identity) { identityStats += 1; peakIdentities = Math.max(peakIdentities, ++activeIdentities); }
            }
            try {
              if (latencyMs && key === "stat") await new Promise(resolve => setTimeout(resolve, latencyMs));
              return await (originals[key] as (...values: unknown[]) => Promise<unknown>)(...args);
            } finally {
              if (key === "stat") activeStats -= 1;
              if (identity) activeIdentities -= 1;
            }
          } });
        }
        syncBuiltinESMExports();
        const started = performance.now();
        try {
          const service = new variant.Remote({ instanceId: "benchmark", application, owners: new AidenRemoteWorkspaceOwnerRegistry() });
          const value = operation === "gemini-index"
            ? await variant.list(root)
            : await service.list("device", workspace.id);
          const comparable = operation === "gemini-index"
            ? buildGeminiWorkspaceSnapshot(value as Awaited<ReturnType<typeof listWorkspaceFiles>>, { isRepo: false })
            : { ...value, snapshotId: "omitted", entries: value.entries.map(entry => ({ ...entry, id: "omitted" })) };
          if (variant.name === "before") expected = comparable;
          else assert.deepEqual(comparable, expected, "ordering, truncation and projected metadata must match");
          results.push({ shape, operation, variant: variant.name, elapsedMs: Math.round(performance.now() - started), entries: value.entries.length, ...calls, peakStats, identityStats, peakIdentities });
        } finally { Object.assign(fs, originals); syncBuiltinESMExports(); }
      }
    }
  }
  process.stdout.write(`${JSON.stringify({ baseline, node: process.version, platform: process.platform, latencyMs, results }, null, 2)}\n`);
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
