import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeechModelSpec } from "./local-speech-catalog.js";
import { createSpeechModelManager, diskFailureMessage, partialDownloadBytes } from "./local-speech-downloads.js";

type Mode = "normal" | "ignore-range" | "wrong-offset" | "cut-after-half" | "stall" | "oversize" | "unsatisfiable" | "short";

function fixtureArchive(): { bytes: Buffer; sha256: string } {
  const dir = mkdtempSync(join(tmpdir(), "speech-fixture-"));
  const top = join(dir, "sherpa-onnx-fixture");
  mkdirSync(join(top, "test_wavs"), { recursive: true });
  writeFileSync(join(top, "model.int8.onnx"), Buffer.alloc(200_000, 7));
  writeFileSync(join(top, "tokens.txt"), "a 0\nb 1\n");
  writeFileSync(join(top, "test_wavs", "0.wav"), Buffer.alloc(1000, 1));
  writeFileSync(join(top, "model.onnx"), Buffer.alloc(5000, 2)); // unused precision → pruned
  const archive = join(dir, "fixture.tar.bz2");
  execFileSync("tar", ["-cjf", archive, "-C", dir, "sherpa-onnx-fixture"]);
  const bytes = readFileSync(archive);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function serve(bytes: Buffer, state: { mode: Mode; requests: Array<string | undefined> }): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    state.requests.push(req.headers.range);
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    let start = range && state.mode !== "ignore-range" ? Number(range[1]) : 0;
    if (state.mode === "wrong-offset" && range) start = Math.max(0, Number(range[1]) - 10);
    if (state.mode === "unsatisfiable" && range) { res.writeHead(416).end(); return; }
    const body = state.mode === "oversize" ? Buffer.concat([bytes, Buffer.alloc(10)]) : bytes;
    const slice = body.subarray(start);
    if (state.mode === "short") {
      // A clean, well-formed response that simply carries fewer bytes than the archive.
      const half = slice.subarray(0, Math.floor(slice.length / 2));
      res.writeHead(start > 0 ? 206 : 200, {
        "content-length": String(half.length),
        ...(start > 0 ? { "content-range": `bytes ${start}-${start + half.length - 1}/${body.length}` } : {}),
      });
      res.end(half);
      return;
    }
    res.writeHead(start > 0 ? 206 : 200, {
      "content-length": String(slice.length),
      ...(start > 0 ? { "content-range": `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
    });
    if (state.mode === "stall") { res.write(slice.subarray(0, 100)); return; }
    // Destroy only after the half has been flushed, so the client really receives it.
    if (state.mode === "cut-after-half") { res.write(slice.subarray(0, Math.floor(slice.length / 2)), () => res.destroy()); return; }
    res.end(slice);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return { server, url: `http://127.0.0.1:${address.port}/fixture.tar.bz2` };
}

function spec(url: string, bytes: number, sha256: string): SpeechModelSpec {
  return {
    id: "fixture", name: "Fixture", description: "x", family: "sense-voice",
    archive: { url, bytes, sha256 }, files: { model: "model.int8.onnx", tokens: "tokens.txt" },
    languages: ["en"], capabilities: { autoDetect: false, languageHint: false, translateToEnglish: false, maxWindowSeconds: 30 },
    accuracy: 0.5, speed: 0.5, recommended: true, license: { name: "MIT", url: "https://example.invalid" },
  };
}

test("installs a verified archive and prunes files outside the spec", async (t) => {
  const { bytes, sha256 } = fixtureArchive();
  const state = { mode: "normal" as Mode, requests: [] as Array<string | undefined> };
  const { server, url } = await serve(bytes, state);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const manager = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, sha256)] });
  await manager.downloadModel("fixture");
  assert.equal(manager.isModelInstalled("fixture"), true);
  assert.deepEqual(readdirSync(join(root, "fixture")).sort(), ["model.int8.onnx", "tokens.txt"]);
});

test("a hash mismatch deletes the partial and reports corruption", async (t) => {
  const { bytes } = fixtureArchive();
  const { server, url } = await serve(bytes, { mode: "normal", requests: [] });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const manager = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, "0".repeat(64))] });
  await assert.rejects(manager.downloadModel("fixture"), /corrupted/i);
  assert.equal(manager.isModelInstalled("fixture"), false);
  assert.equal(existsSync(join(root, ".partial", "fixture.tar.bz2.part")), false);
});

test("an interrupted download resumes with Range after a relaunch", async (t) => {
  const { bytes, sha256 } = fixtureArchive();
  const state = { mode: "cut-after-half" as Mode, requests: [] as Array<string | undefined> };
  const { server, url } = await serve(bytes, state);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const first = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, sha256)] });
  await assert.rejects(first.downloadModel("fixture"));
  const partial = statSync(join(root, ".partial", "fixture.tar.bz2.part")).size;
  assert.ok(partial > 0 && partial < bytes.length);
  state.mode = "normal";
  const second = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, sha256)] });
  await second.downloadModel("fixture");
  assert.equal(state.requests[state.requests.length - 1], `bytes=${partial}-`);
  assert.equal(second.isModelInstalled("fixture"), true);
});

test("a server that ignores Range restarts from zero and still verifies", async (t) => {
  const { bytes, sha256 } = fixtureArchive();
  const state = { mode: "cut-after-half" as Mode, requests: [] as Array<string | undefined> };
  const { server, url } = await serve(bytes, state);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const manager = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, sha256)] });
  await assert.rejects(manager.downloadModel("fixture"));
  state.mode = "ignore-range";
  await manager.downloadModel("fixture");
  assert.equal(manager.isModelInstalled("fixture"), true);
});

test("a 206 at the wrong offset discards the partial and restarts", async (t) => {
  const { bytes, sha256 } = fixtureArchive();
  const state = { mode: "cut-after-half" as Mode, requests: [] as Array<string | undefined> };
  const { server, url } = await serve(bytes, state);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const manager = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, sha256)] });
  await assert.rejects(manager.downloadModel("fixture"));
  state.mode = "wrong-offset";
  await assert.rejects(manager.downloadModel("fixture"), /restart|try again/i);
  state.mode = "normal";
  await manager.downloadModel("fixture");
  assert.equal(manager.isModelInstalled("fixture"), true);
});

test("an oversize stream is cut and rejected", async (t) => {
  const { bytes, sha256 } = fixtureArchive();
  const { server, url } = await serve(bytes, { mode: "oversize", requests: [] });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const manager = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, sha256)] });
  await assert.rejects(manager.downloadModel("fixture"), /size|corrupted/i);
});

test("a stalled stream aborts with a retryable error", async (t) => {
  const { bytes, sha256 } = fixtureArchive();
  const { server, url } = await serve(bytes, { mode: "stall", requests: [] });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const manager = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, sha256)], stallMs: 200 });
  await assert.rejects(manager.downloadModel("fixture"), /stalled/i);
  assert.ok(existsSync(join(root, ".partial", "fixture.tar.bz2.part")));
});

test("progress passes through verify before extract", async (t) => {
  const { bytes, sha256 } = fixtureArchive();
  const { server, url } = await serve(bytes, { mode: "normal", requests: [] });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const phases: string[] = [];
  const manager = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, sha256)], progress: (p) => { if (phases[phases.length - 1] !== p.phase) phases.push(p.phase); } });
  await manager.downloadModel("fixture");
  assert.deepEqual(phases, ["download", "verify", "extract"]);
});

test("cleanupLeftovers removes stale staging and unknown partials", async () => {
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  mkdirSync(join(root, ".partial"), { recursive: true });
  writeFileSync(join(root, ".partial", "gone.tar.bz2.part"), "x");
  writeFileSync(join(root, ".partial", "fixture.tar.bz2.part"), "12345"); // 5 of 10 bytes: resumable
  writeFileSync(join(root, ".partial", "big.tar.bz2.part"), "x".repeat(11)); // larger than its 10-byte archive
  mkdirSync(join(root, "fixture.extracting"));
  mkdirSync(join(root, ".fixture.staging-123"));
  const manager = createSpeechModelManager({
    root: () => root,
    catalog: [
      spec("http://127.0.0.1:1/x", 10, "0".repeat(64)),
      { ...spec("http://127.0.0.1:1/y", 10, "0".repeat(64)), id: "big" },
    ],
  });
  await manager.cleanupLeftovers();
  assert.equal(existsSync(join(root, ".partial", "gone.tar.bz2.part")), false);
  assert.equal(existsSync(join(root, ".partial", "big.tar.bz2.part")), false);
  assert.equal(readFileSync(join(root, ".partial", "fixture.tar.bz2.part"), "utf8"), "12345");
  assert.equal(existsSync(join(root, "fixture.extracting")), false);
  assert.equal(existsSync(join(root, ".fixture.staging-123")), false);
});

test("listModels projects catalog metadata and derived size labels", () => {
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const manager = createSpeechModelManager({ root: () => root });
  const v3 = manager.listModels().find((m) => m.id === "parakeet-v3");
  assert.equal(v3?.sizeLabel, "487 MB");
  assert.equal(v3?.installed, false);
  assert.equal(v3?.capabilities.autoDetect, true);
  assert.equal(v3?.languages.length, 25);
});

test("cancel keeps the partial and the next download resumes from it", async (t) => {
  const { bytes, sha256 } = fixtureArchive();
  const state = { mode: "stall" as Mode, requests: [] as Array<string | undefined> };
  const { server, url } = await serve(bytes, state);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  let cancelled = false;
  const manager = createSpeechModelManager({
    root: () => root,
    catalog: [spec(url, bytes.length, sha256)],
    progress: (p) => { if (!cancelled && p.phase === "download" && p.downloaded > 0) cancelled = manager.cancelDownload("fixture"); },
  });
  await assert.rejects(manager.downloadModel("fixture"), /cancelled/i);
  assert.deepEqual(manager.localModelDownloadStates(), []);
  const partial = statSync(join(root, ".partial", "fixture.tar.bz2.part")).size;
  assert.ok(partial > 0 && partial < bytes.length);
  state.mode = "normal";
  await manager.downloadModel("fixture");
  assert.equal(state.requests[state.requests.length - 1], `bytes=${partial}-`);
  assert.equal(manager.isModelInstalled("fixture"), true);
});

test("a 416 for an incomplete partial fails verification and discards it", async (t) => {
  const { bytes, sha256 } = fixtureArchive();
  const state = { mode: "cut-after-half" as Mode, requests: [] as Array<string | undefined> };
  const { server, url } = await serve(bytes, state);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const manager = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, sha256)] });
  await assert.rejects(manager.downloadModel("fixture"));
  state.mode = "unsatisfiable";
  await assert.rejects(manager.downloadModel("fixture"), /corrupted/i);
  assert.equal(existsSync(join(root, ".partial", "fixture.tar.bz2.part")), false);
  assert.equal(manager.localModelDownloadStates()[0]?.status, "failed");
});

test("deleteModel removes the installed model and any partial", async (t) => {
  const { bytes, sha256 } = fixtureArchive();
  const state = { mode: "normal" as Mode, requests: [] as Array<string | undefined> };
  const { server, url } = await serve(bytes, state);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const manager = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, sha256)] });
  await manager.downloadModel("fixture");
  writeFileSync(join(root, ".partial", "fixture.tar.bz2.part"), "x");
  await manager.deleteModel("fixture");
  assert.equal(manager.isModelInstalled("fixture"), false);
  assert.equal(existsSync(join(root, ".partial", "fixture.tar.bz2.part")), false);
});

test("a partial that cannot be written reports a disk error, not an interruption", async (t) => {
  const { bytes, sha256 } = fixtureArchive();
  const { server, url } = await serve(bytes, { mode: "normal", requests: [] });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  // A directory where the partial file belongs makes every write fail locally.
  mkdirSync(join(root, ".partial", "fixture.tar.bz2.part"), { recursive: true });
  const manager = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, sha256)] });
  const error = await manager.downloadModel("fixture").then(() => undefined, (reason: unknown) => reason as Error);
  assert.ok(error instanceof Error);
  assert.match(error.message, /disk/i);
  assert.doesNotMatch(error.message, /interrupted/i);
  // Not a space problem: the advice points at permissions, not free space.
  assert.doesNotMatch(error.message, /free up space/i);
  assert.match(error.message, /Check that Aiden can write to its data folder and try again\./);
  assert.equal(manager.isModelInstalled("fixture"), false);
});

test("a non-regular entry at the partial path is a disk failure whatever its size", async () => {
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const partial = join(root, "fixture.tar.bz2.part");
  mkdirSync(partial);
  // The directory's own size varies by platform, so the check must not depend on it.
  const error = await partialDownloadBytes(partial).then(() => undefined, (reason: unknown) => reason as Error);
  assert.ok(error instanceof Error);
  assert.match(error.message, /disk.*EISDIR|EISDIR.*disk/i);
  assert.doesNotMatch(error.message, /interrupted/i);
  // Left in place: it is not download bytes, and removing it is not ours to do.
  assert.equal(statSync(partial).isDirectory(), true);
});

test("a regular partial reports its byte count and a missing one reports zero", async () => {
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const partial = join(root, "fixture.tar.bz2.part");
  assert.equal(await partialDownloadBytes(partial), 0);
  writeFileSync(partial, "12345");
  assert.equal(await partialDownloadBytes(partial), 5);
});

test("a partial that cannot be inspected is a disk failure, not a fresh download", async () => {
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  // A regular file where the .partial folder belongs: looking inside it fails with ENOTDIR.
  writeFileSync(join(root, ".partial"), "not a folder");
  const error = await partialDownloadBytes(join(root, ".partial", "fixture.tar.bz2.part")).then(
    () => undefined,
    (reason: unknown) => reason as Error,
  );
  assert.ok(error instanceof Error);
  assert.match(error.message, /disk.*ENOTDIR|ENOTDIR.*disk/i);
});

test("only a full disk or exhausted quota asks the user to free up space", () => {
  const errno = (code: string) => Object.assign(new Error(code), { code });
  for (const code of ["ENOSPC", "EDQUOT"]) {
    assert.match(diskFailureMessage(errno(code)), /Free up space and try again\./);
  }
  for (const code of ["EACCES", "EISDIR", "EROFS"]) {
    const message = diskFailureMessage(errno(code));
    assert.doesNotMatch(message, /free up space/i);
    assert.match(message, /Check that Aiden can write to its data folder and try again\./);
  }
});

test("a body that ends cleanly but short keeps the partial and resumes later", async (t) => {
  const { bytes, sha256 } = fixtureArchive();
  const state = { mode: "short" as Mode, requests: [] as Array<string | undefined> };
  const { server, url } = await serve(bytes, state);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = mkdtempSync(join(tmpdir(), "speech-root-"));
  const manager = createSpeechModelManager({ root: () => root, catalog: [spec(url, bytes.length, sha256)] });
  await assert.rejects(manager.downloadModel("fixture"), /interrupted/i);
  const partial = statSync(join(root, ".partial", "fixture.tar.bz2.part")).size;
  assert.ok(partial > 0 && partial < bytes.length);
  state.mode = "normal";
  await manager.downloadModel("fixture");
  assert.equal(state.requests[state.requests.length - 1], `bytes=${partial}-`);
  assert.equal(manager.isModelInstalled("fixture"), true);
});
