import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_PROVISION_STEPS,
  buildBaseVm,
  generateGuestPassword,
  kcpasswordBytes,
  provisionBase,
  type ProvisionContext,
} from "./provision.js";
import type { BotComputerGuestCommandResult } from "./types.js";

const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKfakeHostKeyForAidenBotComputerTests0123456789 root@guest";
const ok: BotComputerGuestCommandResult = { exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false };

interface Event {
  channel: "lume_ssh" | "guest_ssh" | "lume" | "store" | "known_hosts";
  command?: string;
  stdin?: string;
  value?: string;
}

function context(events: Event[], overrides: Partial<ProvisionContext> = {}): ProvisionContext {
  let counter = 0;
  return {
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAidenKeyForBotComputerProvisioningTests012345678",
    lumeSsh: async (command) => {
      events.push({ channel: "lume_ssh", command });
      return { exitCode: 0, stdout: command.includes("ssh_host_ed25519_key.pub") ? `${HOST_KEY}\n` : "", stderr: "" };
    },
    guestSsh: async (command, options) => {
      events.push({ channel: "guest_ssh", command, stdin: options.stdin });
      return ok;
    },
    stopBase: async () => {
      events.push({ channel: "lume" });
    },
    writeKnownHost: async (line) => {
      events.push({ channel: "known_hosts", value: line });
    },
    newPassword: () => `Rotated${String((counter += 1))}Password0123456789abcd`,
    storePassword: async (password) => {
      events.push({ channel: "store", value: password });
    },
    ...overrides,
  };
}

test("the steps run in order: key and host key over lume ssh, the rest over Aiden's ssh, then shut down", async () => {
  const events: Event[] = [];
  const steps: string[] = [];
  await provisionBase(context(events), { onStep: (step) => steps.push(step) });
  assert.deepEqual(steps, BASE_PROVISION_STEPS.map((step) => step.id));
  assert.deepEqual(steps, [
    "install_key",
    "capture_host_key",
    "rotate_password",
    "harden_sshd",
    "disable_updates",
    "suppress_prompts",
    "shared_folder",
    "guest_driver",
    "permissions",
    "shut_down",
  ]);
  assert.deepEqual(
    events.map((event) => event.channel),
    ["lume_ssh", "lume_ssh", "known_hosts", "store", "guest_ssh", "guest_ssh", "guest_ssh", "guest_ssh", "guest_ssh", "lume"],
  );
  assert.ok(events[0]?.command?.includes("authorized_keys"));
  assert.equal(events[2]?.value, HOST_KEY);
  assert.match(events.find((event) => event.command?.includes("sshd_config.d"))?.command ?? "", /PasswordAuthentication no/u);
  assert.match(events.find((event) => event.command?.includes("SoftwareUpdate"))?.command ?? "", /AutomaticDownload -bool false/u);
  assert.match(events.find((event) => event.command?.includes("My Shared Files"))?.command ?? "", /\$HOME\/Shared/u);
});

test("the new password is stored before the guest changes, travels only on stdin, and unlocks sudo afterwards", async () => {
  const events: Event[] = [];
  await provisionBase(context(events));
  const stored = events.find((event) => event.channel === "store")?.value ?? "";
  const rotate = events.findIndex((event) => event.command?.includes("dscl"));
  assert.ok(events.findIndex((event) => event.channel === "store") < rotate);
  assert.ok(events[rotate]?.stdin?.startsWith(`lume\n${stored}\n`));
  for (const event of events) assert.equal(event.command?.includes(stored) ?? false, false, "never in a command line");
  const sudoAfter = events.slice(rotate + 1).filter((event) => event.command?.includes("sudo"));
  assert.ok(sudoAfter.length >= 3);
  for (const event of sudoAfter) assert.equal(event.stdin?.split("\n")[0], stored);
});

test("the guest driver installs and waits for its grants with the rotated password, before the base shuts down", async () => {
  const events: Event[] = [];
  const driver: string[] = [];
  await provisionBase(
    context(events, {
      guestDriver: {
        install: async (password) => void driver.push(`install:${password}`),
        grant: async (password) => {
          driver.push(`grant:${password}`);
          assert.equal(events.some((event) => event.channel === "lume"), false, "the base is still running");
        },
      },
    }),
  );
  const stored = events.find((event) => event.channel === "store")?.value ?? "";
  assert.deepEqual(driver, [`install:${stored}`, `grant:${stored}`]);
  assert.equal(events[events.length - 1]?.channel, "lume");
});

test("a failing step stops provisioning there", async () => {
  const events: Event[] = [];
  await assert.rejects(
    provisionBase(
      context(events, {
        guestSsh: async (command) => {
          events.push({ channel: "guest_ssh", command });
          return command.includes("sshd_config.d") ? { ...ok, exitCode: 1 } : ok;
        },
      }),
    ),
    /harden_sshd/u,
  );
  assert.equal(events.some((event) => event.channel === "lume"), false, "no later step ran");
});

test("the restore image is deleted only after the base is complete", async () => {
  const calls: string[] = [];
  const base = (provisionOk: boolean) => ({
    deleteVm: async () => void calls.push("delete"),
    create: async () => void calls.push("create"),
    start: async () => {
      calls.push("start");
      return { ip: "192.168.64.10" };
    },
    provisionContext: () =>
      context([], provisionOk ? {} : { guestSsh: async () => ({ ...ok, exitCode: 9 }) }),
    stop: async () => void calls.push("stop"),
    removeIpsw: async () => void calls.push("remove-ipsw"),
  });
  await buildBaseVm(base(true));
  assert.deepEqual(calls, ["delete", "create", "start", "remove-ipsw"]);
  calls.length = 0;
  await assert.rejects(buildBaseVm(base(false)));
  assert.equal(calls.includes("remove-ipsw"), false);
  assert.deepEqual(calls.slice(-2), ["stop", "delete"], "the half-made base is removed");
});

test("guest passwords are 32 unambiguous characters and kcpassword pads with a terminator", () => {
  const password = generateGuestPassword();
  assert.match(password, /^[A-HJ-NP-Za-km-z2-9]{32}$/u);
  assert.notEqual(password, generateGuestPassword());
  // Lume's own patcher documents "lume" → 11 fc 3f 46 d2 bc dd ea a3 b9 1f 7d.
  assert.equal(kcpasswordBytes("lume").toString("hex"), "11fc3f46d2bcddeaa3b91f7d");
  assert.equal(kcpasswordBytes("x".repeat(12)).length, 24);
});
