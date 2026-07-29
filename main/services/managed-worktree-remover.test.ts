import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  finalizeManagedWorktreeRemovalManifest,
  managedWorktreeRemovalManifestPresent,
  ManagedWorktreeRemoverError,
  removeManagedWorktreeDirectory,
} from "./managed-worktree-remover.js";

async function fixture(t: test.TestContext): Promise<{
  binary: string;
  identity: { path: string; device: number; inode: number };
  authorizationPath: string;
  abortMarker: string;
}> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-remover-wrapper-"));
  t.after(() => fs.rm(parent, { force: true, recursive: true }));
  const target = path.join(parent, ".aiden-removing-owned-token");
  const authorizationPath = path.join(parent, ".aiden-authorizing-owned-token");
  const abortMarker = path.join(parent, "abort-received");
  const digest = "a".repeat(64);
  await fs.mkdir(target);
  const stat = await fs.lstat(target);
  const binary = path.join(parent, "fake-remover");
  await fs.writeFile(
    binary,
    `#!/bin/sh
mv "$3/.aiden-removing-owned-token" "$3/.aiden-authorizing-owned-token"
printf 'ready:%s:%s\\n' ".aiden-authorizing-owned-token" "${digest}"
IFS= read -r authorization
case "$authorization" in
  continue|resume:*)
    rmdir "$3/.aiden-authorizing-owned-token"
    exit 0
    ;;
  abort)
    mv "$3/.aiden-authorizing-owned-token" "$3/.aiden-removing-owned-token"
    : > "$3/abort-received"
    exit 23
    ;;
  *)
    printf 'io_failed\\n' >&2
    exit 22
    ;;
esac
`,
    { encoding: "utf8", mode: 0o700 },
  );
  return {
    binary,
    identity: { path: target, device: stat.dev, inode: stat.ino },
    authorizationPath,
    abortMarker,
  };
}

test("managed worktree remover authorizes the exact scanned quarantine before continuing", async (t) => {
  const value = await fixture(t);
  const seen: string[] = [];

  await removeManagedWorktreeDirectory(
    {
      ...value.identity,
      authorize: async (scannedPath) => {
        seen.push(scannedPath);
      },
    },
    value.binary,
  );

  assert.deepEqual(seen, [value.authorizationPath]);
  await assert.rejects(fs.access(value.identity.path));
  await assert.rejects(fs.access(value.authorizationPath));
});

test("managed worktree remover preserves an authorization rejection", async (t) => {
  const value = await fixture(t);
  const rejection = new Error("late ignored data");

  await assert.rejects(
    removeManagedWorktreeDirectory(
      {
        ...value.identity,
        authorize: async () => {
          throw rejection;
        },
      },
      value.binary,
    ),
    (error) => error === rejection,
  );
  assert.equal((await fs.lstat(value.identity.path)).isDirectory(), true);
  await assert.rejects(fs.access(value.authorizationPath));
  assert.equal(await fs.readFile(value.abortMarker, "utf8"), "");
});

test("managed worktree remover resumes only the journal-authorized manifest digest", async (t) => {
  const value = await fixture(t);
  const seen: string[] = [];

  await removeManagedWorktreeDirectory(
    {
      ...value.identity,
      authorizedManifestDigest: "a".repeat(64),
      authorize: async (scannedPath) => {
        seen.push(scannedPath);
      },
    },
    value.binary,
  );

  assert.deepEqual(seen, []);
  await assert.rejects(fs.access(value.identity.path));
  await assert.rejects(fs.access(value.authorizationPath));
});

test("managed worktree remover rejects test controls for a non-test helper", async (t) => {
  const value = await fixture(t);

  await assert.rejects(
    removeManagedWorktreeDirectory(value.identity, value.binary, {
      pauseAfterScanPath: path.join(path.dirname(value.identity.path), "pause"),
    }),
    (error) => error instanceof ManagedWorktreeRemoverError && error.failure === "invalid_input",
  );
  assert.equal((await fs.lstat(value.identity.path)).isDirectory(), true);
});

test("managed worktree manifest inspection treats any exact sidecar object as untrusted presence", async (t) => {
  const value = await fixture(t);
  const manifestPath = path.join(
    path.dirname(value.identity.path),
    ".aiden-removal-manifest-owned-token",
  );

  assert.equal(await managedWorktreeRemovalManifestPresent(value.identity.path), false);
  await fs.symlink("attacker-selected-target", manifestPath);
  assert.equal(await managedWorktreeRemovalManifestPresent(value.identity.path), true);
  assert.equal(await fs.readlink(manifestPath), "attacker-selected-target");
});

test("managed worktree manifest finalizer uses exact argv, environment, and failure mapping", async (t) => {
  const value = await fixture(t);
  const digest = "c".repeat(64);
  const parent = path.dirname(value.identity.path);
  for (const [failure, exitCode] of [
    ["mutation_detected", 21],
    ["io_failed", 22],
    ["invalid_input", 64],
  ] as const) {
    const binary = path.join(parent, `fake-finalizer-${failure}`);
    await fs.writeFile(
      binary,
      `#!/bin/sh
if [ "$1" != "finalize-manifest" ] || [ "$2" != "--parent" ] || [ "$3" != "${parent}" ] || [ "$4" != "--token" ] || [ "$5" != "owned-token" ] || [ "$6" != "--digest" ] || [ "$7" != "${digest}" ]; then
  printf 'invalid_input\\n' >&2
  exit 64
fi
if [ "$PATH" != "/usr/bin:/bin:/usr/sbin:/sbin" ] || [ "$LANG" != "C" ] || [ "$LC_ALL" != "C" ]; then
  printf 'io_failed\\n' >&2
  exit 22
fi
printf '${failure}\\n' >&2
exit ${exitCode}
`,
      { encoding: "utf8", mode: 0o700 },
    );

    await assert.rejects(
      finalizeManagedWorktreeRemovalManifest(value.identity.path, digest, binary),
      (error) => error instanceof ManagedWorktreeRemoverError && error.failure === failure,
      failure,
    );
  }
});

test("managed worktree manifest finalizer rejects malformed native output", async (t) => {
  const value = await fixture(t);
  const binary = path.join(path.dirname(value.identity.path), "fake-finalizer-malformed");
  await fs.writeFile(binary, "#!/bin/sh\nprintf 'unexpected output\\n'\nexit 0\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  await assert.rejects(
    finalizeManagedWorktreeRemovalManifest(value.identity.path, "d".repeat(64), binary),
    (error) => error instanceof ManagedWorktreeRemoverError && error.failure === "io_failed",
  );
});

test("managed worktree manifest finalization resumes every verified capture phase", async (t) => {
  for (const suffix of ["", ".finalizing", ".deleting"] as const) {
    const value = await fixture(t);
    const contents = `authorized manifest ${suffix || "reserved"}\n`;
    const manifestPath = path.join(
      path.dirname(value.identity.path),
      `.aiden-removal-manifest-owned-token${suffix}`,
    );
    await fs.writeFile(manifestPath, contents, { encoding: "utf8", mode: 0o600 });
    const digest = createHash("sha256").update(contents).digest("hex");

    await finalizeManagedWorktreeRemovalManifest(value.identity.path, digest);

    await assert.rejects(fs.access(manifestPath));
    assert.equal(await managedWorktreeRemovalManifestPresent(value.identity.path), false);
  }
});

test("managed worktree manifest finalization preserves conflicting capture phases", async (t) => {
  const value = await fixture(t);
  const parent = path.dirname(value.identity.path);
  const reserved = path.join(parent, ".aiden-removal-manifest-owned-token");
  const captured = `${reserved}.finalizing`;
  const contents = "same authorized bytes\n";
  const digest = createHash("sha256").update(contents).digest("hex");
  await fs.writeFile(reserved, contents, { encoding: "utf8", mode: 0o600 });
  await fs.writeFile(captured, contents, { encoding: "utf8", mode: 0o600 });

  await assert.rejects(
    finalizeManagedWorktreeRemovalManifest(value.identity.path, digest),
    (error) =>
      error instanceof ManagedWorktreeRemoverError && error.failure === "mutation_detected",
  );
  assert.equal(await fs.readFile(reserved, "utf8"), contents);
  assert.equal(await fs.readFile(captured, "utf8"), contents);
});

test("managed worktree remover rejects a malformed ready handshake", async (t) => {
  const value = await fixture(t);
  await fs.writeFile(
    value.binary,
    `#!/bin/sh\nprintf 'ready:.aiden-removing-owned-token:${"a".repeat(64)}\\n'\nIFS= read -r ignored\n`,
    {
      encoding: "utf8",
      mode: 0o700,
    },
  );

  await assert.rejects(
    removeManagedWorktreeDirectory(value.identity, value.binary),
    (error) => error instanceof ManagedWorktreeRemoverError && error.failure === "io_failed",
  );
});

test("managed worktree remover rejects a successful helper without a ready handshake", async (t) => {
  const value = await fixture(t);
  await fs.writeFile(value.binary, "#!/bin/sh\nexit 0\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  await assert.rejects(
    removeManagedWorktreeDirectory(value.identity, value.binary),
    (error) => error instanceof ManagedWorktreeRemoverError && error.failure === "io_failed",
  );
});
