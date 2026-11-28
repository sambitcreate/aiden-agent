import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const installer = fileURLToPath(new URL("../install.sh", import.meta.url));
const shell = "/bin/sh";

async function installerFunctionHarness(body) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-install-functions-"));
  const source = await readFile(installer, "utf8");
  const end = source.indexOf("\nwhile [ \"$#\" -gt 0 ]");
  assert.notEqual(end, -1);
  const harness = path.join(root, "harness.sh");
  await writeFile(harness, `${source.slice(0, end)}\n${body}\n`);
  return { harness, root };
}

async function plan({ system, machine, format = "auto", translated = "0", user = false }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-install-plan-"));
  const uname = path.join(root, "uname");
  const curl = path.join(root, "curl");
  const sysctl = path.join(root, "sysctl");
  await Promise.all([
    writeFile(uname, `#!/bin/sh\n[ "$1" = "-s" ] && printf '%s\\n' '${system}' || printf '%s\\n' '${machine}'\n`),
    writeFile(curl, "#!/bin/sh\nexit 99\n"),
    writeFile(sysctl, `#!/bin/sh\nprintf '%s\\n' '${translated}'\n`),
  ]);
  await Promise.all([chmod(uname, 0o755), chmod(curl, 0o755), chmod(sysctl, 0o755)]);
  const args = [installer, "--plan", "--version", "1.2.3", "--format", format];
  if (user) args.push("--user");
  const { stdout } = await execFileAsync(shell, args, {
    env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}` },
  });
  return Object.fromEntries(
    stdout.trim().split("\n").map((line) => line.split("=", 2)),
  );
}

test("selects exact package architecture aliases", async () => {
  assert.equal((await plan({ system: "Linux", machine: "x86_64", format: "deb" })).asset,
    "Aiden-Agent-1.2.3-amd64-linux.deb");
  assert.equal((await plan({ system: "Linux", machine: "aarch64", format: "rpm" })).asset,
    "Aiden-Agent-1.2.3-aarch64-linux.rpm");
  assert.equal((await plan({ system: "Linux", machine: "x86_64", format: "appimage" })).asset,
    "Aiden-Agent-1.2.3-x86_64-linux.AppImage");
  assert.equal((await plan({ system: "Linux", machine: "arm64", format: "deb", user: true })).asset,
    "Aiden-Agent-1.2.3-arm64-linux.AppImage");
});

test("selects Mac DMGs and recognizes Rosetta", async () => {
  assert.equal((await plan({ system: "Darwin", machine: "arm64" })).asset,
    "Aiden-Agent-Beta-1.2.3-arm64.dmg");
  assert.equal((await plan({ system: "Darwin", machine: "x86_64", translated: "0" })).asset,
    "Aiden-Agent-Beta-1.2.3-x64.dmg");
  assert.equal((await plan({ system: "Darwin", machine: "x86_64", translated: "1" })).asset,
    "Aiden-Agent-Beta-1.2.3-arm64.dmg");
});

test("rejects unsupported options, versions, systems, architectures, and formats", async () => {
  const cases = [
    ["--unknown"],
    ["--plan", "--version", "../latest"],
    ["--plan", "--version", "1.2.3", "--format", "pkg"],
  ];
  for (const args of cases) {
    await assert.rejects(execFileAsync(shell, [installer, ...args]), /Aiden installer:/u);
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-install-reject-"));
  await writeFile(path.join(root, "uname"), "#!/bin/sh\n[ \"$1\" = -s ] && echo FreeBSD || echo sparc\n");
  await writeFile(path.join(root, "curl"), "#!/bin/sh\nexit 99\n");
  await Promise.all([chmod(path.join(root, "uname"), 0o755), chmod(path.join(root, "curl"), 0o755)]);
  await assert.rejects(
    execFileAsync(shell, [installer, "--plan", "--version", "1.2.3"], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}` },
    }),
    /unsupported operating system/u,
  );
});

async function downloadFixture({
  system = "Linux",
  machine = system === "Darwin" ? "arm64" : "x86_64",
  asset = system === "Darwin"
    ? "Aiden-Agent-Beta-1.2.3-arm64.dmg"
    : "Aiden-Agent-1.2.3-amd64-linux.deb",
  checksum = "valid",
  checksumsContent = undefined,
  attestedCommit = "0123456789abcdef0123456789abcdef01234567",
  attestChecksums = true,
  attestPackage = true,
  includeGh = true,
  ghVersion = "2.68.0",
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-install-download-"));
  const bin = path.join(root, "bin");
  const output = path.join(root, "output");
  const home = path.join(root, "home");
  await Promise.all([mkdir(bin), mkdir(output), mkdir(home)]);
  const payload = Buffer.from("verified package fixture");
  const digest = createHash("sha256").update(payload).digest("hex");
  const validChecksums = `${digest}  ${asset}\n`;
  const writtenChecksums =
    checksumsContent ?? `${checksum === "valid" ? digest : "0".repeat(64)}  ${asset}\n`;
  const attestedChecksumsDigest = attestChecksums
    ? createHash("sha256").update(validChecksums).digest("hex")
    : "f".repeat(64);
  const attestedPackageDigest = attestPackage ? digest : "e".repeat(64);
  const packagePath = path.join(root, asset);
  const checksumPath = path.join(root, "SHA256SUMS");
  const ghLog = path.join(root, "gh.log");
  const eventsLog = path.join(root, "events.log");
  const requiredTools = [
    "awk",
    "cat",
    "chmod",
    "cp",
    "grep",
    "mkdir",
    "mktemp",
    "rm",
    "rmdir",
    "sed",
  ];
  await Promise.all([
    writeFile(packagePath, payload),
    writeFile(checksumPath, writtenChecksums),
    writeFile(
      path.join(bin, "uname"),
      `#!/bin/sh\n[ "$1" = -s ] && echo ${system} || echo ${machine}\n`,
    ),
    writeFile(path.join(bin, "mv"), "#!/bin/sh\n[ \"$1\" = -fT ] && shift\nexec /bin/mv -f \"$@\"\n"),
    writeFile(path.join(bin, "ln"), "#!/bin/sh\n[ \"$1\" = -sfnT ] && shift\nexec /bin/ln -sfn \"$@\"\n"),
    writeFile(
      path.join(bin, "curl"),
      String.raw`#!/bin/sh
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    http*) url=$1; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  */SHA256SUMS) cp "$FIXTURE_CHECKSUMS" "$output" ;;
  *) cp "$FIXTURE_PACKAGE" "$output" ;;
esac
`,
    ),
  ]);
  if (includeGh) {
    await writeFile(
      path.join(bin, "gh"),
      String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$FIXTURE_GH_LOG"
if [ "$1" = --version ]; then
  printf 'gh version %s (fixture)\n' "$FIXTURE_GH_VERSION"
  exit 0
fi
if [ "$1" = api ]; then
  printf '%s\n' "$FIXTURE_RELEASE_COMMIT"
  exit 0
fi
if [ "$FIXTURE_GH_VERSION" = 2.46.0 ]; then
  printf 'unknown command "%s" for "gh"\n' "$1" >&2
  exit 1
fi
case " $* " in
  *" --help "*) printf '%s\n' '--cert-identity --signer-digest --source-digest --source-ref'; exit 0 ;;
esac
# Real gh rejects these identity flags when they are combined.
identities=0
source_digest=""
signer_digest=""
subject="$3"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --cert-identity|--cert-identity-regex|--signer-repo|--signer-workflow)
      identities=$((identities + 1))
      shift
      ;;
    --source-digest)
      source_digest=$2
      shift 2
      ;;
    --signer-digest)
      signer_digest=$2
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
[ "$identities" -le 1 ] || exit 1
[ -f "$subject" ] || exit 1
if command -v sha256sum >/dev/null 2>&1; then
  subject_digest=$(sha256sum "$subject" | awk '{print $1}')
else
  subject_digest=$(shasum -a 256 "$subject" | awk '{print $1}')
fi
printf 'gh:attest:%s\n' "$(basename "$subject")" >> "$FIXTURE_EVENTS_LOG"
[ "$source_digest" = "$FIXTURE_ATTESTED_COMMIT" ] || exit 1
[ "$signer_digest" = "$FIXTURE_ATTESTED_COMMIT" ] || exit 1
if [ "$subject_digest" != "$FIXTURE_ATTESTED_CHECKSUMS_DIGEST" ] && [ "$subject_digest" != "$FIXTURE_ATTESTED_PACKAGE_DIGEST" ]; then
  exit 1
fi
`,
    );
  }
  for (const name of requiredTools) {
    const { stdout } = await execFileAsync(shell, ["-c", 'command -v "$1"', "sh", name]);
    await symlink(stdout.trim(), path.join(bin, name));
  }
  const { stdout: basenameTarget } = await execFileAsync(shell, ["-c", "command -v basename"]);
  await symlink(basenameTarget.trim(), path.join(bin, "basename"));
  let checksumTool;
  for (const name of ["sha256sum", "shasum"]) {
    try {
      const { stdout } = await execFileAsync(shell, ["-c", 'command -v "$1"', "sh", name]);
      checksumTool = { name, target: stdout.trim() };
      break;
    } catch {
      // Try the installer's native macOS fallback.
    }
  }
  assert.ok(checksumTool, "sha256sum or shasum is required by the fixture");
  await symlink(checksumTool.target, path.join(bin, checksumTool.name));
  const executables = ["uname", "curl", "mv", "ln", ...(includeGh ? ["gh"] : [])];
  await Promise.all(executables.map((name) => chmod(path.join(bin, name), 0o755)));
  return {
    root,
    bin,
    asset,
    digest,
    output,
    ghLog,
    eventsLog,
    env: {
      ...process.env,
      HOME: home,
      PATH: bin,
      FIXTURE_PACKAGE: packagePath,
      FIXTURE_CHECKSUMS: checksumPath,
      FIXTURE_GH_LOG: ghLog,
      FIXTURE_EVENTS_LOG: eventsLog,
      FIXTURE_GH_VERSION: ghVersion,
      FIXTURE_RELEASE_COMMIT: "0123456789abcdef0123456789abcdef01234567",
      FIXTURE_ATTESTED_COMMIT: attestedCommit,
      FIXTURE_ATTESTED_CHECKSUMS_DIGEST: attestedChecksumsDigest,
      FIXTURE_ATTESTED_PACKAGE_DIGEST: attestedPackageDigest,
    },
  };
}

async function linuxDownloadFixture(options = {}) {
  return downloadFixture({ system: "Linux", ...options });
}

async function macosInstallerHarness(fixtureOptions = {}) {
  const fixture = await downloadFixture({ system: "Darwin", ...fixtureOptions });
  const usrBin = path.join(fixture.root, "usr/bin");
  const usrSbin = path.join(fixture.root, "usr/sbin");
  const usrLibexec = path.join(fixture.root, "usr/libexec");
  await Promise.all([
    mkdir(usrBin, { recursive: true }),
    mkdir(usrSbin, { recursive: true }),
    mkdir(usrLibexec, { recursive: true }),
  ]);

  const diskutilScript = String.raw`#!/bin/sh
printf 'diskutil:attach\n' >> "$FIXTURE_EVENTS_LOG"
mountpoint=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mountPoint) mountpoint=$2; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$mountpoint/Aiden Agent.app/Contents/MacOS"
printf 'plist' > "$mountpoint/Aiden Agent.app/Contents/Info.plist"
printf 'macho' > "$mountpoint/Aiden Agent.app/Contents/MacOS/Aiden Agent"
`;
  const codesignScript = String.raw`#!/bin/sh
if [ "$1" = "--verify" ]; then
  printf 'codesign:verify\n' >> "$FIXTURE_EVENTS_LOG"
  exit 0
fi
printf 'codesign:team\n' >> "$FIXTURE_EVENTS_LOG"
printf 'TeamIdentifier=5WP229CBB8\n' >&2
`;
  const spctlScript = String.raw`#!/bin/sh
printf 'spctl:assess\n' >> "$FIXTURE_EVENTS_LOG"
`;
  const plistBuddyScript = String.raw`#!/bin/sh
case "$2" in
  *CFBundleIdentifier*) printf 'com.sambitcreate.aiden-agent\n' ;;
  *CFBundleShortVersionString*) printf '1.2.3\n' ;;
esac
`;
  const lipoScript = String.raw`#!/bin/sh
printf 'arm64\n'
`;
  const hdiutilScript = String.raw`#!/bin/sh
printf 'hdiutil:detach\n' >> "$FIXTURE_EVENTS_LOG"
`;

  const toolEntries = [
    [path.join(usrSbin, "diskutil"), diskutilScript, "diskutil"],
    [path.join(usrBin, "codesign"), codesignScript, "codesign"],
    [path.join(usrSbin, "spctl"), spctlScript, "spctl"],
    [path.join(usrLibexec, "PlistBuddy"), plistBuddyScript, null],
    [path.join(usrBin, "lipo"), lipoScript, null],
    [path.join(usrBin, "hdiutil"), hdiutilScript, "hdiutil"],
  ];
  for (const [toolPath, content, binLink] of toolEntries) {
    await writeFile(toolPath, content);
    await chmod(toolPath, 0o755);
    if (binLink) {
      await symlink(toolPath, path.join(fixture.bin, binLink));
    }
  }

  const source = await readFile(installer, "utf8");
  const harnessPath = path.join(fixture.root, "install-macos-harness.sh");
  await writeFile(
    harnessPath,
    source
      .replaceAll("/usr/bin/codesign", path.join(usrBin, "codesign"))
      .replaceAll("/usr/sbin/spctl", path.join(usrSbin, "spctl"))
      .replaceAll("/usr/libexec/PlistBuddy", path.join(usrLibexec, "PlistBuddy"))
      .replaceAll("/usr/bin/lipo", path.join(usrBin, "lipo"))
      .replaceAll("/usr/sbin/diskutil", path.join(usrSbin, "diskutil"))
      .replaceAll("/usr/bin/hdiutil", path.join(usrBin, "hdiutil")),
  );
  await chmod(harnessPath, 0o755);
  return { ...fixture, harnessPath };
}

test("downloads one fixed Linux asset and requires its pinned release attestation", async () => {
  const fixture = await linuxDownloadFixture();
  await execFileAsync(
    shell,
    [installer, "--version", "1.2.3", "--format", "deb", "--download-only", fixture.output],
    { env: fixture.env },
  );
  assert.equal(await readFile(path.join(fixture.output, fixture.asset), "utf8"), "verified package fixture");
  const ghLog = await readFile(fixture.ghLog, "utf8");
  assert.match(ghLog, /releases\/tags\/v1\.2\.3 --jq \.target_commitish/u);
  assert.match(ghLog, /attestation verify .*\/SHA256SUMS .* --source-digest 0123456789abcdef0123456789abcdef01234567/u);
  assert.match(ghLog, /attestation verify .*\/Aiden-Agent-1\.2\.3-amd64-linux\.deb .* --source-digest 0123456789abcdef0123456789abcdef01234567/u);
  assert.match(ghLog, /--signer-digest 0123456789abcdef0123456789abcdef01234567/u);
});

test("verifies SHA256SUMS and DMG provenance on Darwin before mounting and running codesign/spctl", async () => {
  const commit = "fedcba9876543210fedcba9876543210fedcba98";
  const fixture = await macosInstallerHarness({ attestedCommit: commit });
  await execFileAsync(
    shell,
    [
      fixture.harnessPath,
      "--version",
      "1.2.3",
      "--expected-commit",
      commit,
      "--download-only",
      fixture.output,
    ],
    { env: fixture.env },
  );
  assert.equal(
    await readFile(path.join(fixture.output, fixture.asset), "utf8"),
    "verified package fixture",
  );
  const events = (await readFile(fixture.eventsLog, "utf8")).trim().split("\n");
  assert.deepEqual(events, [
    "gh:attest:SHA256SUMS",
    "gh:attest:Aiden-Agent-Beta-1.2.3-arm64.dmg",
    "diskutil:attach",
    "codesign:verify",
    "spctl:assess",
    "codesign:team",
    "hdiutil:detach",
  ]);
});

test("rejects missing gh, outdated gh, tampered SHA256SUMS, and mismatched --expected-commit on Darwin and Linux before mounting any DMG", async () => {
  for (const system of ["Linux", "Darwin"]) {
    const formatArgs = system === "Darwin" ? [] : ["--format", "deb"];
    const installHint =
      system === "Darwin" ? /brew install gh/u : /install_linux\.md/u;
    const upgradeHint =
      system === "Darwin" ? /brew upgrade gh/u : /install_linux\.md/u;

    const badChecksum = await (system === "Darwin"
      ? macosInstallerHarness({ checksum: "bad" })
      : linuxDownloadFixture({ checksum: "bad" }));
    const badChecksumScript = system === "Darwin" ? badChecksum.harnessPath : installer;
    await assert.rejects(
      execFileAsync(
        shell,
        [badChecksumScript, "--version", "1.2.3", ...formatArgs, "--download-only", badChecksum.output],
        { env: badChecksum.env },
      ),
      /checksum verification failed/u,
    );
    await assert.rejects(lstat(badChecksum.eventsLog));

    const tamperedManifest = await (system === "Darwin"
      ? macosInstallerHarness({ attestChecksums: false })
      : linuxDownloadFixture({ attestChecksums: false }));
    const tamperedScript = system === "Darwin" ? tamperedManifest.harnessPath : installer;
    await assert.rejects(
      execFileAsync(
        shell,
        [tamperedScript, "--version", "1.2.3", ...formatArgs, "--download-only", tamperedManifest.output],
        { env: tamperedManifest.env },
      ),
      /release provenance verification failed for SHA256SUMS/u,
    );
    const tamperedEvents = await readFile(tamperedManifest.eventsLog, "utf8");
    assert.doesNotMatch(tamperedEvents, /diskutil/u);

    const noGh = await (system === "Darwin"
      ? macosInstallerHarness({ includeGh: false })
      : linuxDownloadFixture({ includeGh: false }));
    await assert.rejects(
      execFileAsync(
        shell,
        [installer, "--version", "1.2.3", ...formatArgs, "--download-only", noGh.output],
        { env: noGh.env },
      ),
      installHint,
    );
    await assert.rejects(lstat(noGh.eventsLog));

    const outdatedGh = await (system === "Darwin"
      ? macosInstallerHarness({ ghVersion: "2.46.0" })
      : linuxDownloadFixture({ ghVersion: "2.46.0" }));
    await assert.rejects(
      execFileAsync(
        shell,
        [installer, "--version", "1.2.3", ...formatArgs, "--download-only", outdatedGh.output],
        { env: outdatedGh.env },
      ),
      upgradeHint,
    );
    await assert.rejects(lstat(outdatedGh.eventsLog));

    const wrongCommit = await (system === "Darwin"
      ? macosInstallerHarness()
      : linuxDownloadFixture());
    const wrongCommitScript = system === "Darwin" ? wrongCommit.harnessPath : installer;
    await assert.rejects(
      execFileAsync(
        shell,
        [
          wrongCommitScript,
          "--version",
          "1.2.3",
          ...formatArgs,
          "--expected-commit",
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "--download-only",
          wrongCommit.output,
        ],
        { env: wrongCommit.env },
      ),
      /release provenance verification failed for SHA256SUMS/u,
    );
    const wrongCommitEvents = await readFile(wrongCommit.eventsLog, "utf8");
    assert.doesNotMatch(wrongCommitEvents, /diskutil/u);
    await assert.rejects(lstat(path.join(wrongCommit.output, wrongCommit.asset)));
  }

  const helpOutput = (await execFileAsync(shell, [installer, "--help"])).stdout;
  assert.match(helpOutput, /--expected-commit SHA\s+Require this reviewed release commit\./u);
  assert.doesNotMatch(helpOutput, /Require this reviewed release commit on Linux/u);
});

test("rejects a bad checksum and the absence of GitHub provenance verification", async () => {
  const badChecksum = await linuxDownloadFixture({ checksum: "bad" });
  await assert.rejects(
    execFileAsync(
      shell,
      [installer, "--version", "1.2.3", "--format", "deb", "--download-only", badChecksum.output],
      { env: badChecksum.env },
    ),
    /checksum verification failed/u,
  );

  const noGh = await linuxDownloadFixture({ includeGh: false });
  await assert.rejects(
    execFileAsync(
      shell,
      [installer, "--version", "1.2.3", "--format", "deb", "--download-only", noGh.output],
      { env: noGh.env },
    ),
    /GitHub CLI is required/u,
  );

  const outdatedGh = await linuxDownloadFixture({ ghVersion: "2.46.0" });
  await assert.rejects(
    execFileAsync(
      shell,
      [installer, "--version", "1.2.3", "--format", "deb", "--download-only", outdatedGh.output],
      { env: outdatedGh.env },
    ),
    /installed GitHub CLI \(gh version 2\.46\.0 \(fixture\)\) is too old/u,
  );
  await assert.rejects(lstat(path.join(outdatedGh.output, outdatedGh.asset)));
});

test("AppImage install uses private staging and produces one regular payload plus launcher", async () => {
  const asset = "Aiden-Agent-1.2.3-x86_64-linux.AppImage";
  const fixture = await linuxDownloadFixture({ asset });
  await execFileAsync(shell, [installer, "--version", "1.2.3", "--format", "appimage"], {
    env: fixture.env,
  });
  const installed = path.join(fixture.env.HOME, ".local/share/aiden-agent/Aiden-Agent.AppImage");
  const launcher = path.join(fixture.env.HOME, ".local/bin/aiden-agent");
  assert.equal((await lstat(installed)).isFile(), true);
  assert.equal(await readFile(installed, "utf8"), "verified package fixture");
  assert.equal((await lstat(launcher)).isSymbolicLink(), true);
  assert.equal(await readlink(launcher), installed);
});

test("AppImage install rejects symlink and directory destinations without changing them", async () => {
  const asset = "Aiden-Agent-1.2.3-x86_64-linux.AppImage";
  const linked = await linuxDownloadFixture({ asset });
  const linkedDir = path.join(linked.env.HOME, ".local/share/aiden-agent");
  const unrelated = path.join(linked.env.HOME, "unrelated");
  await mkdir(linkedDir, { recursive: true });
  await writeFile(unrelated, "keep");
  await symlink(unrelated, path.join(linkedDir, "Aiden-Agent.AppImage"));
  await assert.rejects(
    execFileAsync(shell, [installer, "--version", "1.2.3", "--format", "appimage"], {
      env: linked.env,
    }),
    /destination is not a regular file/u,
  );
  assert.equal(await readFile(unrelated, "utf8"), "keep");

  const directory = await linuxDownloadFixture({ asset });
  const destination = path.join(
    directory.env.HOME,
    ".local/share/aiden-agent/Aiden-Agent.AppImage",
  );
  await mkdir(destination, { recursive: true });
  await assert.rejects(
    execFileAsync(shell, [installer, "--version", "1.2.3", "--format", "appimage"], {
      env: directory.env,
    }),
    /destination is not a regular file/u,
  );
  assert.equal((await lstat(destination)).isDirectory(), true);
});

test("macOS cleanup preserves the only backup and reports its path when restore fails", async () => {
  const { harness, root } = await installerFunctionHarness(String.raw`
trap - EXIT HUP INT TERM
mac_stage_parent=$HARNESS_ROOT/transaction
mac_backup=$mac_stage_parent/previous.app
mac_destination=$HARNESS_ROOT/Aiden\ Agent.app
mac_transaction=true
mac_had_existing=true
mac_promoted=true
mkdir -p "$mac_backup" "$mac_destination"
printf old > "$mac_backup/version"
privilege() {
  if [ "$1" = /bin/mv ]; then return 1; fi
  "$@"
}
cleanup
`);
  const result = await execFileAsync(shell, [harness], {
    env: { ...process.env, HARNESS_ROOT: root },
  });
  assert.match(result.stderr, /rollback failed; preserved recovery files at/u);
  assert.equal(await readFile(path.join(root, "transaction/previous.app/version"), "utf8"), "old");
  await assert.rejects(lstat(path.join(root, "Aiden Agent.app")));
});

test("macOS backup recovery is armed before an interrupted move", async () => {
  const { harness, root } = await installerFunctionHarness(String.raw`
mac_stage_parent=$HARNESS_ROOT/transaction
mac_backup=$mac_stage_parent/previous.app
mac_destination=$HARNESS_ROOT/Aiden\ Agent.app
mac_transaction=true
mkdir -p "$mac_stage_parent" "$mac_destination"
printf old > "$mac_destination/version"
privilege() {
  "$@"
  if [ ! -e "$HARNESS_ROOT/signalled" ]; then
    : > "$HARNESS_ROOT/signalled"
    kill -TERM $$
  fi
}
backup_existing_macos_app
`);
  await assert.rejects(
    execFileAsync(shell, [harness], { env: { ...process.env, HARNESS_ROOT: root } }),
  );
  assert.equal(await readFile(path.join(root, "Aiden Agent.app/version"), "utf8"), "old");
  await assert.rejects(lstat(path.join(root, "transaction")));
});

test("macOS fresh promotion rollback is armed before an interrupted move", async () => {
  const { harness, root } = await installerFunctionHarness(String.raw`
mac_stage_parent=$HARNESS_ROOT/transaction
staged_app=$mac_stage_parent/new.app
mac_backup=$mac_stage_parent/previous.app
mac_destination=$HARNESS_ROOT/Aiden\ Agent.app
mac_transaction=true
mkdir -p "$staged_app"
printf new > "$staged_app/version"
privilege() {
  "$@"
  if [ ! -e "$HARNESS_ROOT/signalled" ]; then
    : > "$HARNESS_ROOT/signalled"
    kill -TERM $$
  fi
}
promote_macos_app
`);
  await assert.rejects(
    execFileAsync(shell, [harness], { env: { ...process.env, HARNESS_ROOT: root } }),
  );
  await assert.rejects(lstat(path.join(root, "Aiden Agent.app")));
  await assert.rejects(lstat(path.join(root, "transaction")));
});

test("installer and standalone Linux workflow preserve verification boundaries", async () => {
  const [source, workflow] = await Promise.all([
    import("node:fs/promises").then(({ readFile }) => readFile(installer, "utf8")),
    import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../.github/workflows/linux-installers.yml", import.meta.url), "utf8")),
  ]);
  assert.match(source, /gh attestation verify/u);
  assert.match(
    source,
    /--cert-identity "https:\/\/github\.com\/\$\{repository\}\/\.github\/workflows\/release\.yml@refs\/heads\/main"/u,
  );
  assert.doesNotMatch(source, /--signer-(?:repo|workflow)/u, "gh rejects these alongside --cert-identity");
  assert.match(source, /--source-digest "\$expected_commit"/u);
  assert.match(source, /--deny-self-hosted-runners/u);
  assert.match(source, /codesign --verify --strict/u);
  assert.match(source, /spctl --assess --type execute/u);
  assert.match(source, /mac_stage_parent=.*mktemp -d/u);
  assert.match(source, /chmod 0711 "\$mac_stage_parent"[\s\S]*mac_backup="\$mac_stage_parent\/previous\.app"/u);
  assert.match(source, /promote_macos_app\(\) \{[\s\S]*mac_promoted=true[\s\S]*privilege \/bin\/mv/u);
  assert.match(source, /promote_macos_app[\s\S]*verify_macos_app "\$mac_destination"[\s\S]*mac_transaction=false/u);
  assert.match(source, /mv -fT "\$staged" "\$app_destination"/u);
  assert.doesNotMatch(source, /--no-sandbox|xattr -[cdr]|spctl --master-disable/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /ubuntu-24\.04-arm/u);
  assert.match(workflow, /npm run dist:linux/u);
  assert.match(workflow, /verify-linux-package\.mjs/u);
  assert.match(workflow, /sha256sum -- \*\.AppImage \*\.deb \*\.rpm latest-linux\*\.yml install\.sh/u);
  assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/u);
  assert.doesNotMatch(workflow, /gh release|contents: write/u);
});
