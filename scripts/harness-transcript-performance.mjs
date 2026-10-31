/* global Buffer, console, performance, document, requestAnimationFrame, setTimeout */
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import net from "node:net";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const app = process.argv[2];
const output = process.argv[3];
const candidate = process.argv.includes("--containment-candidate");
if (!app || !output) throw new Error("Usage: node scripts/harness-transcript-performance.mjs <packaged.app> <receipt.json>");
const root = await mkdtemp(path.join(os.tmpdir(), "aiden-transcript-perf-"));
const userData = path.join(root, "user-data");
const config = path.join(root, "config");
await mkdir(path.join(userData, "chats"), { recursive: true });
await mkdir(config);
const probe = path.join(root, "process-usage");
execFileSync("cc", ["-x", "c", "-", "-o", probe], { input: String.raw`#include <libproc.h>
#include <sys/resource.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc,char **argv) { struct rusage_info_v2 r; unsigned long long w=0,i=0,rd=0,wr=0,mem=0; int n=0;
for(int x=1;x<argc;x++) if(proc_pid_rusage(atoi(argv[x]),RUSAGE_INFO_V2,(rusage_info_t*)&r)==0) { w+=r.ri_pkg_idle_wkups;i+=r.ri_interrupt_wkups;rd+=r.ri_diskio_bytesread;wr+=r.ri_diskio_byteswritten;mem+=r.ri_phys_footprint;n++; }
printf("{\"processes\":%d,\"idleWakeups\":%llu,\"interruptWakeups\":%llu,\"readBytes\":%llu,\"writtenBytes\":%llu,\"footprintBytes\":%llu}",n,w,i,rd,wr,mem); return 0; }` });
let requestBytes = 0; let responseBytes = 0;
let releaseStreaming; let inputFinished = false; let streamedDeltas = 0;
const inputMeasured = new Promise((resolve) => { releaseStreaming = () => { inputFinished = true; resolve(); }; });
const modelId = "aiden-performance-fixture";
const modelServer = createServer(async (req, res) => {
  const send = (value) => { const text = JSON.stringify(value); responseBytes += Buffer.byteLength(text); res.writeHead(200, { "content-type": "application/json" }); res.end(text); };
  if (req.method === "GET") { send({ data: [{ id: modelId, type: "llm", context_length: 262144 }] }); return; }
  const chunks = []; for await (const chunk of req) { requestBytes += chunk.length; if (requestBytes > 32 * 1024 * 1024) { res.destroy(); return; } chunks.push(chunk); }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  const chunk = (content, finish_reason = null) => { const text = `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: modelId, choices: [{ index: 0, delta: { content }, finish_reason }] })}\n\n`; responseBytes += Buffer.byteLength(text); res.write(text); };
  if (body.tools?.length) { for (let i = 0; i < 400; i++) { chunk(`Measured stream token ${i}. `); streamedDeltas++; await delay(25); if (inputFinished && i >= 39) break; } await inputMeasured; }
  else chunk("Performance fixture title");
  chunk("", "stop"); res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
const provider = { id: "custom:performance", kind: "openai", label: "Performance fixture", models: [modelId], baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`, needsKey: false, deployment: "local" };
const now = Date.now();
const chatMetas = [];
let fixtureBytes = 0;
for (const count of [50, 500, 2000]) {
  const id = randomUUID();
  const meta = { id, providerId: provider.id, model: modelId, title: `Performance fixture ${count}`, createdAt: now, updatedAt: now + count };
  const messages = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(), role: i % 2 ? "assistant" : "user", createdAt: now + i,
    content: `Fixture message ${count}-${i}.\n\n${i % 2 ? "This response describes a measured change and its validation.\n\n```ts\nconst value = 42;\n```\n\n- Scope preserved\n- Validation complete" : "Please examine this synthetic fixture and explain its behavior."}`,
    ...(i % 10 === 1 ? { timeline: { version: 3, generationId: `g${i}`, status: "completed", startedAt: now, finishedAt: now + 1, steps: [{ id: `s${i}`, order: 0, kind: "tool", toolCallId: `t${i}`, toolName: "read_file", label: "Read fixture", status: "completed", startedAt: now, updatedAt: now + 1, finishedAt: now + 1 }] }, attachments: [{ id: randomUUID(), name: "fixture.txt", mimeType: "text/plain", kind: "text", size: 16, text: "Fixture artifact" }] } : {}),
  }));
  const bytes = JSON.stringify({ ...meta, messages }); fixtureBytes += Buffer.byteLength(bytes);
  await writeFile(path.join(userData, "chats", `${id}.json`), bytes);
  chatMetas.push(meta);
}
await writeFile(path.join(userData, "chats", "index.json"), JSON.stringify(chatMetas));
await writeFile(path.join(config, "config.json"), JSON.stringify({ providers: [provider], mcpServers: [], skills: [] }));
await writeFile(path.join(userData, "provider-model-cache.json"), JSON.stringify({ byProvider: { [provider.id]: { models: [modelId], modelMetadata: { [modelId]: { contextLength: 262144, toolCall: true } } } } }));
await writeFile(path.join(userData, "settings.json"), JSON.stringify({ settings: { profileName: "Performance fixture", lastProviderId: provider.id, lastModel: modelId, onboarding: { version: 2, outcome: "deferred", lastSatisfiedStep: "profile" } } }));
await writeFile(path.join(userData, "config.json"), JSON.stringify({ seeded: true, aidenDirMigratedAt: now, workspaces: [] }));
const server = net.createServer(); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port; await new Promise((resolve) => server.close(resolve));
const env = Object.fromEntries(["PATH", "LANG", "TMPDIR", "USER", "SHELL"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
Object.assign(env, { HOME: root, AIDEN_CONFIG_DIR: config, AIDEN_RUNTIME_PROFILE: "production", AIDEN_ANALYTICS: "0", XDG_CONFIG_HOME: path.join(root, "xdg-config"), XDG_DATA_HOME: path.join(root, "xdg-data"), XDG_CACHE_HOME: path.join(root, "xdg-cache") });
const executable = path.join(app, "Contents", "MacOS", "Aiden Agent");
const child = spawn(executable, [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], { cwd: root, env, stdio: "ignore" });
let browser; let page;
try {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Package exited ${child.exitCode}; fixture ${root}`);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch { await delay(200); }
  }
  if (!browser) throw new Error("Packaged renderer debugger unavailable");
  for (let i = 0; i < 100; i++) {
    page = browser.contexts()[0]?.pages().find((candidate) => candidate.url().includes("main-window"));
    if (page) break;
    await delay(100);
  }
  if (!page) throw new Error("Packaged main window unavailable");
  page.setDefaultTimeout(15000);
  await page.getByRole("button", { name: "Performance fixture 50", exact: true }).waitFor({ timeout: 30000 });
  if (candidate) await page.addStyleTag({ content: '[data-subagent-chip-focus-scope="true"] > :nth-last-child(n+33) { content-visibility: auto; contain-intrinsic-size: auto 200px; }' });
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  const browserSession = await browser.newBrowserCDPSession();
  const resourceSample = async () => {
    const processes = await browserSession.send("SystemInfo.getProcessInfo");
    return JSON.parse(execFileSync(probe, processes.processInfo.map((p) => String(p.id)), { encoding: "utf8" }));
  };
  const scenarios = [];
  for (const count of [50, 500, 2000]) {
    for (const temperature of ["cold", "warm"]) {
      await page.getByRole("button", { name: "New Agent", exact: true }).click();
      const resourceBefore = await resourceSample();
      const started = performance.now();
      await page.getByRole("button", { name: `Performance fixture ${count}`, exact: true }).click();
      await page.getByText(`Fixture message ${count}-${count - 1}.`, { exact: false }).waitFor({ timeout: 60000 });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const openMs = performance.now() - started;
      const dom = await page.evaluate(() => ({ nodes: document.querySelectorAll("*").length, rows: document.querySelector('[data-subagent-chip-focus-scope="true"]')?.children.length ?? 0 }));
      const resourceAfterOpen = await resourceSample();
      const before = await session.send("Performance.getMetrics");
      const delays = await page.evaluate(async () => {
        const samples = [];
        for (let i = 0; i < 20; i++) { const start = performance.now(); await new Promise((resolve) => setTimeout(resolve, 50)); samples.push(performance.now() - start - 50); }
        return samples;
      });
      const after = await session.send("Performance.getMetrics");
      const resourceAfterIdle = await resourceSample();
      const metric = (result, name) => result.metrics.find((item) => item.name === name)?.value;
      scenarios.push({ count, temperature, openMs, ...dom, resourceBefore, resourceAfterOpen, resourceAfterIdle, heapUsedBytes: metric(after, "JSHeapUsedSize"), taskDurationSeconds: metric(after, "TaskDuration") - metric(before, "TaskDuration"), eventLoopDelayMs: delays });
    }
  }
  const streamStart = performance.now();
  await page.locator("textarea").fill("Measure this local synthetic stream.");
  await page.locator("textarea").press("Enter");
  await page.getByText("Measured stream token 0.", { exact: false }).first().waitFor({ timeout: 30000 });
  const firstVisibleDeltaMs = performance.now() - streamStart;
  const deltasBeforeInput = streamedDeltas;
  const inputStart = performance.now();
  await page.locator("textarea").fill("Typing remains responsive during streaming");
  const inputDuringStreamMs = performance.now() - inputStart;
  const deltasDuringInput = streamedDeltas - deltasBeforeInput;
  releaseStreaming();
  await page.getByText("Measured stream token 39.", { exact: false }).first().waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Stop generating" }).waitFor({ state: "hidden", timeout: 30000 });
  const streaming = { firstVisibleDeltaMs, inputDuringStreamMs, deltasDuringInput, totalMs: performance.now() - streamStart, requestBytes, responseBytes };
  const asar = await readFile(path.join(app, "Contents", "Resources", "app.asar"));
  const receipt = { version: 1, candidate, at: new Date().toISOString(), measurementCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), measurementDirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()), packageSha256: createHash("sha256").update(asar).digest("hex"), os: os.release(), architecture: os.arch(), cpu: os.cpus()[0]?.model, power: execFileSync("pmset", ["-g", "batt"], { encoding: "utf8" }).trim(), fixtureBytes, scenarios, streaming, limitations: ["Unsigned local production package; optional native app helpers absent", "Cold means first open within one process; not cold disk cache", "Synthetic localhost streaming only; no real model inference", "Host under concurrent build/test load"] };
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(scenarios.map(({ count, temperature, openMs, rows, heapUsedBytes }) => ({ count, temperature, openMs, rows, heapUsedBytes }))));
} catch (error) {
  console.error((await page?.locator("body").innerText())?.slice(-2000));
  console.error({ requestBytes, responseBytes });
  throw error;
} finally {
  releaseStreaming(); modelServer.closeAllConnections(); await new Promise((resolve) => modelServer.close(resolve));
  await browser?.close(); child.kill("SIGTERM");
  await delay(1000); if (child.exitCode === null) child.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
}
