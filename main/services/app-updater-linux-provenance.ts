import { execFile } from "node:child_process";
import path from "node:path";

const REPOSITORY = "sambitcreate/aiden-agent";
const WORKFLOW_IDENTITY = `https://github.com/${REPOSITORY}/.github/workflows/release.yml@refs/heads/main`;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export type ProvenanceCommand = (args: string[], signal: AbortSignal) => Promise<string>;

const runGh: ProvenanceCommand = (args, signal) => new Promise((resolve, reject) => {
  execFile("gh", args, {
    encoding: "utf8", timeout: 60_000, maxBuffer: MAX_OUTPUT_BYTES, signal,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1" },
  }, (error, stdout) => {
    // Do not expose gh's stderr, credentials or API responses in updater logs.
    if (error) reject(new Error("Linux update provenance verification is unavailable or failed. Install a trusted gh 2.68 or newer and check GitHub access."));
    else resolve(stdout);
  });
});

export interface VerifiedAppImage {
  installer: string;
  sha256: string;
}

/** Same online-only certificate policy as install.sh; the update feed supplies no trust roots. */
export async function verifyAppImageProvenance(options: {
  installer: string;
  version: string;
  arch: string;
  signal: AbortSignal;
  run?: ProvenanceCommand;
}): Promise<VerifiedAppImage> {
  const { installer, version, arch, signal } = options;
  const run = options.run ?? runGh;
  const available = () => {
    if (signal.aborted) throw new Error("Linux update provenance verification was cancelled.");
  };
  available();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version) ||
      !["x64", "arm64"].includes(arch) || !path.isAbsolute(installer) || installer.includes("\0")) {
    throw new Error("Linux update provenance requires a stable release and supported architecture.");
  }
  const asset = `Aiden-Agent-${version}-${arch === "x64" ? "x86_64" : "arm64"}-linux.AppImage`;
  if (path.basename(installer) !== asset) throw new Error("Linux update installer does not match the release asset.");
  const help = await run(["attestation", "verify", "--help"], signal);
  available();
  if (!["--signer-digest", "--source-digest", "--source-ref"].every(flag => help.includes(flag))) {
    throw new Error("Linux updates require a trusted GitHub CLI 2.68 or newer.");
  }
  // Like the installer's default, this is GitHub's release-record commit,
  // not a separately reviewed source pin. Never accept a commit from the feed.
  const commit = (await run(["api", `repos/${REPOSITORY}/releases/tags/v${version}`, "--hostname", "github.com", "--jq", ".target_commitish"], signal)).trim();
  available();
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("Linux release source commit is unavailable.");
  const output = await run([
    "attestation", "verify", installer,
    "--hostname", "github.com", "--repo", REPOSITORY,
    // --cert-identity is mutually exclusive with signer-repo/signer-workflow.
    "--cert-identity", WORKFLOW_IDENTITY,
    "--cert-oidc-issuer", "https://token.actions.githubusercontent.com",
    "--source-ref", "refs/heads/main", "--source-digest", commit, "--signer-digest", commit,
    "--deny-self-hosted-runners", "--predicate-type", "https://slsa.dev/provenance/v1",
    "--digest-alg", "sha256", "--format", "json",
  ], signal);
  available();
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) throw new Error("Linux update provenance response is too large.");
  const results: unknown = JSON.parse(output);
  const digests = new Set<string>();
  if (Array.isArray(results)) for (const result of results) {
    const subjects: unknown = result?.verificationResult?.statement?.subject;
    if (!Array.isArray(subjects)) continue;
    for (const subject of subjects) {
      const digest: unknown = subject?.digest?.sha256;
      if (typeof subject?.name === "string" && path.posix.basename(subject.name) === asset &&
          typeof digest === "string" && /^[0-9a-f]{64}$/u.test(digest)) digests.add(digest);
    }
  }
  // The digest must come from the subject gh actually verified, rather than a
  // new hash of a mutable download path after verification has finished.
  if (digests.size !== 1) throw new Error("Linux update has no unambiguous verified release subject.");
  return Object.freeze({ installer, sha256: [...digests][0]! });
}
