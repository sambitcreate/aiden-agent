import assert from "node:assert/strict";
import test from "node:test";

import {
  BOT_COMPUTER_LINUX_SHELL_USER,
  buildLinuxBaseVm,
  generateGuestPassword,
  LINUX_BASE_PROVISION_STEPS,
  provisionLinuxBase,
  type LinuxProvisionContext,
} from "./provision.js";
import { BOT_COMPUTER_LINUX_APT_SNAPSHOT } from "./release.js";
import type { BotComputerGuestCommandResult } from "./types.js";

const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKfakeHostKeyForAidenBotComputerTests0123456789 root@guest";
const ok: BotComputerGuestCommandResult = { exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false };

test("guest passwords are 32 unambiguous characters", () => {
  const password = generateGuestPassword();
  assert.match(password, /^[A-HJ-NP-Za-km-z2-9]{32}$/u);
  assert.notEqual(password, generateGuestPassword());
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
    "verify_desktop",
    "guest_driver",
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
        event.command?.includes("rm -f /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list.d/*.sources") &&
        event.command?.includes(BOT_COMPUTER_LINUX_APT_SNAPSHOT.archiveUrl) &&
        event.command?.includes("xfce4") &&
        event.command?.includes("chromium") &&
        event.command?.includes("firefox-esr") &&
        event.command?.includes("at-spi2-core"),
    ),
  );
  assert.ok(
    sshCommands.some(
      (event) =>
        event.command?.includes("autologin-user=lume") &&
        event.command?.includes("sleep.target") &&
        event.command?.includes("/etc/netplan/50-aiden-dhcp.yaml") &&
        event.command?.includes("99-disable-network-config.cfg") &&
        event.command?.includes("systemctl restart lightdm") &&
        event.command?.includes(".Xauthority"),
    ),
  );
  assert.ok(
    sshCommands.some(
      (event) =>
        event.command?.includes(`useradd -m -s /bin/bash -U ${BOT_COMPUTER_LINUX_SHELL_USER}`) &&
        event.command?.includes(`/home/${BOT_COMPUTER_LINUX_SHELL_USER}/.ssh/authorized_keys`) &&
        event.command?.includes("/etc/sudoers.d/99-aiden-bot-shell") &&
        event.command?.includes(`ALL=(${BOT_COMPUTER_LINUX_SHELL_USER}) NOPASSWD: ALL`) &&
        event.command?.includes(`/usr/bin/pkill -KILL -u ${BOT_COMPUTER_LINUX_SHELL_USER}`),
    ),
  );
  assert.ok(
    sshCommands.some(
      (event) =>
        event.command?.includes("com.apple.virtio-fs.automount /mnt/aiden-shared virtiofs") &&
        event.command?.includes("/mnt/aiden-shared/Computer"),
    ),
  );
  assert.equal(events.find((event) => event.channel === "guest_driver")?.value, secret);
  const stopIndex = events.findIndex((event) => event.channel === "lume");
  assert.ok(stopIndex > 0, "stopBase runs at shutdown");
  assert.equal(events[stopIndex - 1]?.channel, "guest_ssh");
  assert.ok(events[stopIndex - 1]?.command?.includes("sync && sync"), "ext4 dirty pages are flushed right before lume stop");
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
