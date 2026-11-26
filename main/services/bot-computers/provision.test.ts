import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BOT_COMPUTER_LINUX_SHELL_USER,
  BOT_COMPUTER_LINUX_VNC_PASSWD,
  BOT_COMPUTER_LINUX_VNC_SERVICE,
  BOT_COMPUTER_LINUX_VNC_SOCKET,
  buildLinuxBaseVm,
  generateGuestPassword,
  LINUX_BASE_PROVISION_STEPS,
  linuxGuestVncStartScript,
  linuxGuestVncUnit,
  provisionLinuxBase,
  type LinuxProvisionContext,
} from "./provision.js";
import { BOT_COMPUTER_LINUX_APT_SNAPSHOT } from "./release.js";
import { BotComputerError } from "./types.js";
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
  assert.ok(
    sshCommands.some(
      (event) =>
        event.command?.includes("PasswordAuthentication no") &&
        event.command?.includes("PermitRootLogin no") &&
        event.command?.includes("AllowStreamLocalForwarding yes") &&
        event.command?.includes("GatewayPorts no"),
    ),
  );
  assert.ok(
    sshCommands.some(
      (event) =>
        event.command?.includes("rm -f /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list.d/*.sources") &&
        event.command?.includes(BOT_COMPUTER_LINUX_APT_SNAPSHOT.archiveUrl) &&
        event.command?.includes("xfce4") &&
        event.command?.includes("tigervnc-scraping-server") &&
        event.command?.includes("tigervnc-tools") &&
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
        event.command?.includes(BOT_COMPUTER_LINUX_VNC_SERVICE) &&
        event.command?.includes("loginctl enable-linger") &&
        event.command?.includes("/etc/netplan/50-aiden-dhcp.yaml") &&
        event.command?.includes("99-disable-network-config.cfg") &&
        event.command?.includes("systemctl restart lightdm") &&
        event.command?.includes(".Xauthority"),
    ),
  );
  const configureCmd = sshCommands.find((event) => event.command?.includes("autologin-user=lume"))?.command ?? "";
  const localSharePos = configureCmd.indexOf("install -d -m 755 -o lume -g lume /home/lume/.local /home/lume/.local/share");
  const aidenDirPos = configureCmd.indexOf("install -d -m 700 -o lume -g lume");
  assert.ok(localSharePos >= 0, "creates /home/lume/.local and .local/share owned by lume");
  assert.ok(aidenDirPos > localSharePos, "creates lume-owned .local/.local/share before .local/share/aiden");
  assert.ok(configureCmd.indexOf("/home/lume/.local/share/aiden", aidenDirPos) > aidenDirPos);
  assert.ok(
    sshCommands.some(
      (event) =>
        event.command?.includes(`useradd -m -s /bin/bash -U ${BOT_COMPUTER_LINUX_SHELL_USER}`) &&
        event.command?.includes(`chmod 700 /home/lume /home/${BOT_COMPUTER_LINUX_SHELL_USER}`) &&
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

test("Linux guest VNC unit disables TCP (-rfbport -1), binds a mode-0600 Unix socket with VncAuth, and refreshes its password on stdin", () => {
  const unit = linuxGuestVncUnit();
  assert.match(unit, /^Environment="DISPLAY=:0"$/mu);
  assert.match(unit, /^Environment="XAUTHORITY=\/home\/lume\/\.Xauthority"$/mu);
  assert.match(unit, new RegExp(`-rfbport -1 -rfbunixpath ${BOT_COMPUTER_LINUX_VNC_SOCKET.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} -rfbunixmode 0600`, "u"));
  assert.match(unit, new RegExp(`-SecurityTypes VncAuth -PasswordFile ${BOT_COMPUTER_LINUX_VNC_PASSWD.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
  assert.equal(unit.includes("SecurityTypes None"), false);

  const startScript = linuxGuestVncStartScript();
  assert.match(startScript, /^IFS= read -r pw/mu);
  assert.match(startScript, /\/usr\/bin\/tigervncpasswd -f/u);
  assert.match(startScript, new RegExp(`systemctl --user restart '${BOT_COMPUTER_LINUX_VNC_SERVICE}'`, "u"));
  assert.match(startScript, new RegExp(`\\[ -S '${BOT_COMPUTER_LINUX_VNC_SOCKET.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}' \\]`, "u"));
});

test("Linux shared_folder verifies VirtioFS host-to-guest and guest-to-host file round trips for both users and fails on 0700 or failed mount", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "aiden-linux-shared-rt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const parentDir = path.join(dir, "bot-home");
  const computerDir = path.join(parentDir, "Computer");
  mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  mkdirSync(computerDir, { recursive: true, mode: 0o777 });
  chmodSync(parentDir, 0o700);
  chmodSync(computerDir, 0o777);

  const sharedStep = LINUX_BASE_PROVISION_STEPS.find((step) => step.id === "shared_folder");
  assert.ok(sharedStep);

  // Model VZSharedDirectory without UID translation: guest users (lume/aiden-bot) rely on world rwx on Computer/.
  const simulateGuestRoundTrip = async (command: string, mountFails = false): Promise<BotComputerGuestCommandResult> => {
    assert.equal(command.includes("|| true"), false, "mount failures must not be ignored");
    assert.match(command, /mountpoint -q/u);
    assert.match(command, /\/mnt\/aiden-shared\/Computer/u);
    if (mountFails) {
      return { exitCode: 32, stdout: "", stderr: "mount: /mnt/aiden-shared: special device not found\n", truncated: false, timedOut: false };
    }
    const dirMode = statSync(computerDir).mode & 0o777;
    if ((dirMode & 0o007) !== 0o007) {
      return { exitCode: 1, stdout: "", stderr: "sh: cannot access /home/lume/Shared: Permission denied\n", truncated: false, timedOut: false };
    }
    const hostMatch = /\.aiden-shared-host-([0-9a-f]+)/u.exec(command);
    if (!hostMatch?.[1]) {
      return { exitCode: 1, stdout: "", stderr: "missing host probe name\n", truncated: false, timedOut: false };
    }
    const nonce = hostMatch[1];
    const hostContent = readFileSync(path.join(computerDir, `.aiden-shared-host-${nonce}`), "utf8").trim();
    assert.equal(hostContent, `aiden-host-${nonce}`);
    for (const user of ["lume", "aiden-bot"]) {
      writeFileSync(path.join(computerDir, `.aiden-shared-guest-${user}-${nonce}`), `aiden-guest-${user}-${nonce}\n`, { mode: 0o644 });
    }
    return ok;
  };

  // Succeeds when Computer/ is 0777 (inside 0700 parent) and mount works, cleaning up probe files.
  await sharedStep.run(
    linuxContext([], {
      sharedDir: computerDir,
      guestSsh: async (command) => simulateGuestRoundTrip(command, false),
    }),
  );
  assert.deepEqual(readdirSync(computerDir), [], "round-trip probe files are cleaned up");
  assert.equal(statSync(parentDir).mode & 0o777, 0o700, "host parent retains 0700 privacy");

  // Fails closed if host directory is 0700 (inaccessible to guest UIDs), cleaning up host probe file.
  chmodSync(computerDir, 0o700);
  await assert.rejects(
    sharedStep.run(
      linuxContext([], {
        sharedDir: computerDir,
        guestSsh: async (command) => simulateGuestRoundTrip(command, false),
      }),
    ),
    (error: unknown) => error instanceof BotComputerError && error.code === "start_failed",
  );
  assert.deepEqual(readdirSync(computerDir), [], "probe files cleaned up on permission failure");

  // Fails closed if VirtioFS mount fails.
  chmodSync(computerDir, 0o777);
  await assert.rejects(
    sharedStep.run(
      linuxContext([], {
        sharedDir: computerDir,
        guestSsh: async (command) => simulateGuestRoundTrip(command, true),
      }),
    ),
    (error: unknown) => error instanceof BotComputerError && error.code === "start_failed",
  );
  assert.deepEqual(readdirSync(computerDir), [], "probe files cleaned up on mount failure");
});
