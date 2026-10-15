import assert from "node:assert/strict";
import test from "node:test";
import { isLocalSshTarget, sshConfigArgs, type LocalSshTargetDeps } from "./local-ssh-target.js";

const LOCAL = new Set(["192.168.1.20", "fe80::1"]);

function deps(config: string | null, lookups: Record<string, string[]> = {}) {
  const calls: { ssh: string[][]; lookup: string[] } = { ssh: [], lookup: [] };
  const value: LocalSshTargetDeps = {
    sshConfig: async (args) => {
      calls.ssh.push([...args]);
      return config;
    },
    lookup: async (hostname) => {
      calls.lookup.push(hostname);
      const result = lookups[hostname];
      if (!result) throw new Error("ENOTFOUND");
      return result;
    },
    localAddresses: () => LOCAL,
  };
  return { value, calls };
}

const resolved = (lines: Record<string, string>) =>
  Object.entries({ user: "me", port: "22", proxycommand: "none", ...lines })
    .map(([key, value]) => `${key} ${value}`)
    .join("\n");

test("ssh -G gets the entry's port and identity, and the target after --", () => {
  assert.deepEqual(sshConfigArgs({ target: "mini", port: 2222, identityFile: "~/.ssh/id" }), [
    "-G",
    "-p",
    "2222",
    "-i",
    "~/.ssh/id",
    "--",
    "mini",
  ]);
});

test("a target whose hostname resolves only to this Mac's addresses is local", async () => {
  const loopback = deps(resolved({ hostname: "127.0.0.1" }));
  assert.equal(await isLocalSshTarget({ target: "me@localhost" }, loopback.value), true);
  assert.deepEqual(loopback.calls.lookup, [], "an IP needs no name lookup");

  const named = deps(resolved({ hostname: "this-mac.local" }), { "this-mac.local": ["192.168.1.20", "::1"] });
  assert.equal(await isLocalSshTarget({ target: "this-mac" }, named.value), true);
  assert.equal(await isLocalSshTarget({ target: "[::1]" }, deps(resolved({ hostname: "[::1]" })).value), true);
});

test("forwarded ports, proxies, other machines, and failures are never treated as this Mac", async () => {
  assert.equal(await isLocalSshTarget({ target: "x" }, deps(resolved({ hostname: "127.0.0.1", port: "2222" })).value), false);
  assert.equal(
    await isLocalSshTarget({ target: "x" }, deps(resolved({ hostname: "127.0.0.1", proxyjump: "bastion" })).value),
    false,
  );
  assert.equal(
    await isLocalSshTarget({ target: "x" }, deps(resolved({ hostname: "127.0.0.1", proxycommand: "nc %h %p" })).value),
    false,
  );
  const mixed = deps(resolved({ hostname: "both.local" }), { "both.local": ["192.168.1.20", "10.0.0.9"] });
  assert.equal(await isLocalSshTarget({ target: "both" }, mixed.value), false, "every address must be local");
  assert.equal(await isLocalSshTarget({ target: "x" }, deps(resolved({ hostname: "nowhere.example" })).value), false);
  assert.equal(await isLocalSshTarget({ target: "x" }, deps(null).value), false, "ssh -G failing means not local");
});
