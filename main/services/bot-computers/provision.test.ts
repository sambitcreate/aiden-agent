import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_PROVISION_STEPS,
  BOT_COMPUTER_LINUX_SHELL_USER,
  buildBaseVm,
  buildLinuxBaseVm,
  generateGuestPassword,
  kcpasswordBytes,
  LINUX_BASE_PROVISION_STEPS,
  provisionBase,
  provisionLinuxBase,
  type LinuxProvisionContext,
  type ProvisionContext,
} from "./provision.js";
import { BOT_COMPUTER_LINUX_APT_SNAPSHOT } from "./release.js";
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

interface LinuxEvent {
  channel: "scan_host_key" | "known_hosts" | "guest_ssh" | "guest_driver" | "lume";
  command?: string;
  stdin?: string;
  value?: string;
}

function linuxContext(events: LinuxEvent[], overrides: Partial<LinuxProvisionContext> = {}): LinuxProvisionContext {
  return {
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAidenKeyForBotComputerProvisioningTests012345678",
    password: "LinuxRotatedSecretPassword012345",
    scanHostKey: async () => {
      events.push({ channel: "scan_host_key" });
      return HOST_KEY;
    },
    writeKnownHost: async (line) => {
      events.push({ channel: "known_hosts", value: line });
    },
    guestSsh: async (command, options) => {
      events.push({ channel: "guest_ssh", command, stdin: options.stdin });
      return ok;
    },
    stopBase: async () => {
      events.push({ channel: "lume" });
    },
    ...overrides,
  };
}

test("Linux provisioning pins the host key, configures desktop/aiden-bot/virtiofs without password in argv, omits permissions, and shuts down", async () => {
  const events: LinuxEvent[] = [];
  const steps: string[] = [];
  const secret = "LinuxRotatedSecretPassword012345";
  await provisionLinuxBase(
    linuxContext(events, {
      password: secret,
      guestDriver: {
        install: async (password) => void events.push({ channel: "guest_driver", value: password }),
      },
    }),
    { onStep: (step) => steps.push(step) },
  );

  assert.equal(steps.includes("permissions"), false, "Linux has no macOS permissions step");
  assert.deepEqual(steps, LINUX_BASE_PROVISION_STEPS.map((step) => step.id));
  assert.deepEqual(steps, [
    "capture_host_key",
    "wait_cloud_init",
    "harden_sshd",
    "install_packages",
    "configure_desktop",
    "bot_shell_user",
    "shared_folder",
    "guest_driver",
    "verify_desktop",
    "shut_down",
  ]);
  assert.equal(events[0]?.channel, "scan_host_key");
  assert.equal(events[1]?.channel, "known_hosts");
  assert.equal(events[1]?.value, HOST_KEY);
  assert.equal(events[events.length - 1]?.channel, "lume");

  const sshCommands = events.filter((event) => event.channel === "guest_ssh");
  for (const event of sshCommands) {
    assert.equal(event.command?.includes(secret) ?? false, false, "sudo password never appears in command argv");
    if (event.command?.includes("sudo")) {
      assert.equal(event.stdin, `${secret}\n`);
    }
  }
  assert.ok(sshCommands.some((event) => event.command?.includes("cloud-init status --wait")));
  assert.ok(sshCommands.some((event) => event.command?.includes("PasswordAuthentication no") && event.command?.includes("PermitRootLogin no")));
  assert.ok(
    sshCommands.some(
      (event) =>
        event.command?.includes("rm -f /etc/apt/sources.list.d/debian.sources") &&
        event.command?.includes(BOT_COMPUTER_LINUX_APT_SNAPSHOT.archiveUrl) &&
        event.command?.includes("xfce4") &&
        event.command?.includes("chromium") &&
        event.command?.includes("firefox-esr") &&
        event.command?.includes("at-spi2-core"),
    ),
  );
  assert.ok(sshCommands.some((event) => event.command?.includes("autologin-user=lume") && event.command?.includes("sleep.target")));
  assert.ok(
    sshCommands.some(
      (event) =>
        event.command?.includes(`useradd -m -s /bin/bash -U ${BOT_COMPUTER_LINUX_SHELL_USER}`) &&
        event.command?.includes(`/home/${BOT_COMPUTER_LINUX_SHELL_USER}/.ssh/authorized_keys`) &&
        event.command?.includes("/etc/sudoers.d/90-aiden-bot-shell") &&
        event.command?.includes(`ALL=(${BOT_COMPUTER_LINUX_SHELL_USER}) NOPASSWD: ALL`) &&
        event.command?.includes(`/usr/bin/pkill -KILL -u ${BOT_COMPUTER_LINUX_SHELL_USER}`),
    ),
  );
  assert.ok(sshCommands.some((event) => event.command?.includes("virtiofs") && event.command?.includes("/mnt/aiden-shared")));
  assert.equal(events.find((event) => event.channel === "guest_driver")?.value, secret);
});

test("a failing Linux provisioning step stops immediately; buildLinuxBaseVm cleans the seed ISO and keeps the image on failure", async () => {
  const events: LinuxEvent[] = [];
  await assert.rejects(
    provisionLinuxBase(
      linuxContext(events, {
        guestSsh: async (command) => {
          events.push({ channel: "guest_ssh", command });
          return command.includes("useradd") ? { ...ok, exitCode: 1 } : ok;
        },
      }),
    ),
    /bot_shell_user/u,
  );
  assert.equal(events.some((event) => event.channel === "lume"), false, "no later step or shutdown ran");

  const calls: string[] = [];
  const make = (provisionOk: boolean) => ({
    deleteVm: async () => void calls.push("delete"),
    create: async () => void calls.push("create"),
    start: async () => {
      calls.push("start");
      return { ip: "192.168.64.20" };
    },
    provisionContext: () => linuxContext([], provisionOk ? {} : { guestSsh: async () => ({ ...ok, exitCode: 1 }) }),
    stop: async () => void calls.push("stop"),
    removeSeedIso: async () => void calls.push("remove-seed"),
    removeImage: async () => void calls.push("remove-image"),
  });

  await buildLinuxBaseVm(make(true));
  assert.deepEqual(calls, ["delete", "create", "start", "remove-seed", "remove-image"]);

  calls.length = 0;
  await assert.rejects(buildLinuxBaseVm(make(false)));
  assert.equal(calls.includes("remove-image"), false, "verified Debian image stays for retry");
  assert.deepEqual(calls.slice(-3), ["stop", "delete", "remove-seed"], "half-made VM and temporary seed ISO are cleaned up");
});
