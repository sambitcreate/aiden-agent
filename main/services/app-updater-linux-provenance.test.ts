import assert from "node:assert/strict";
import test from "node:test";
import { verifyAppImageProvenance, type ProvenanceCommand } from "./app-updater-linux-provenance.js";

const installer = "/cache/Aiden-Agent-1.2.3-x86_64-linux.AppImage";
const commit = "0123456789abcdef0123456789abcdef01234567";
const digest = "ab".repeat(32);
const help = "--signer-digest --source-digest --source-ref";
const result = (sha256 = digest, name = "release/Aiden-Agent-1.2.3-x86_64-linux.AppImage") => JSON.stringify([
  { verificationResult: { statement: { subject: [{ name, digest: { sha256 } }] } } },
]);

function fixture(overrides: { help?: string; commit?: string; output?: string; fail?: number; after?: (index: number) => void } = {}) {
  const calls: string[][] = [];
  const run: ProvenanceCommand = async (args, signal) => {
    assert.equal(signal.aborted, false);
    calls.push(args);
    overrides.after?.(calls.length);
    if (overrides.fail === calls.length) throw new Error("verification refused");
    return [overrides.help ?? help, overrides.commit ?? commit, overrides.output ?? result()][calls.length - 1]!;
  };
  const abort = new AbortController();
  return { calls, abort, verify: () => verifyAppImageProvenance({ installer, version: "1.2.3", arch: "x64", signal: abort.signal, run }) };
}

test("release authentication pins GitHub repository, exact workflow, main ref and release-record commit", async () => {
  const f = fixture();
  assert.deepEqual(await f.verify(), { installer, sha256: digest });
  assert.deepEqual(f.calls[1], ["api", "repos/sambitcreate/aiden-agent/releases/tags/v1.2.3", "--hostname", "github.com", "--jq", ".target_commitish"]);
  assert.deepEqual(f.calls[2], [
    "attestation", "verify", installer,
    "--hostname", "github.com", "--repo", "sambitcreate/aiden-agent",
    "--cert-identity", "https://github.com/sambitcreate/aiden-agent/.github/workflows/release.yml@refs/heads/main",
    "--cert-oidc-issuer", "https://token.actions.githubusercontent.com",
    "--source-ref", "refs/heads/main", "--source-digest", commit, "--signer-digest", commit,
    "--deny-self-hosted-runners", "--predicate-type", "https://slsa.dev/provenance/v1",
    "--digest-alg", "sha256", "--format", "json",
  ]);
});

test("outdated CLI and an unresolved release commit fail before any attestation can authorize installation", async () => {
  for (const options of [{ help: "--repo --format" }, { commit: "main" }, { commit: "f".repeat(40) + "\nmain" }]) {
    const f = fixture(options);
    await assert.rejects(f.verify());
    assert.ok(f.calls.length < 3);
  }
});

test("unavailable verifier, release API and rejected publisher signatures never return a checksum fallback", async () => {
  for (const fail of [1, 2, 3]) {
    const f = fixture({ fail });
    await assert.rejects(f.verify(), /refused/u);
    assert.equal(f.calls.length, fail);
  }
});

test("wrong asset/version, malformed output and ambiguous subject digests cannot authorize installation", async () => {
  for (const output of ["{}", "[]", "not JSON", result("broken"), result(digest, "Aiden-Agent-1.2.4-x86_64-linux.AppImage"),
    JSON.stringify([...JSON.parse(result()), ...JSON.parse(result("cd".repeat(32)))])]) {
    await assert.rejects(fixture({ output }).verify());
  }
  const run: ProvenanceCommand = async () => { throw new Error("must not run"); };
  for (const input of [
    { version: "1.2.3/other", arch: "x64", installer },
    { version: "1.2.3", arch: "arm64", installer },
    { version: "1.2.3", arch: "x64", installer: "relative.AppImage" },
  ]) await assert.rejects(verifyAppImageProvenance({ ...input, signal: new AbortController().signal, run }));
});

test("cancellation at each asynchronous verification boundary prevents a proof", async () => {
  for (const boundary of [0, 1, 2, 3]) {
    const f = fixture({ after: index => { if (index === boundary) f.abort.abort(); } });
    if (boundary === 0) f.abort.abort();
    await assert.rejects(f.verify(), /cancelled/u);
    assert.equal(f.calls.length, boundary);
  }
});
