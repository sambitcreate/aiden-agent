import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { botCapabilityAuthorityAccountForCanonicalRoot, ROLLBACK_SERVICE } from "./bot-capability-authority-item.js";
import { createBotAuthorities } from "./bot-capability-authority.js";
import { createBotCapabilitySecretServiceAnchor, createBotCapabilitySecretServiceBootstrapMarker, createTelegramBotBindingSecretServiceAnchor, createTelegramBotBindingSecretServiceBootstrapMarker, createSecretServiceAuthorityCommand, resolveSecretServiceAuthorityHelper, secretServiceAuthorityEnvironment, type SecretServiceAuthorityCommand } from "./bot-capability-secret-service-anchor.js";
const account = botCapabilityAuthorityAccountForCanonicalRoot("/tmp/aiden-test");
const result = (exitCode: number, stdout = "") => ({ exitCode, stdout, stderr: "" });
test("Linux authority preserves independent namespaces, stdin-only values and marker transitions", async () => {
  const values = new Map<string, string>();
  const command: SecretServiceAuthorityCommand = async (args, stdin) => {
    assert.equal(args.length, 3);
    assert.equal(args[2], account);
    if (args[0] === "store") { assert.ok(stdin); assert.ok(!args.includes(stdin)); values.set(args[1]!, stdin); return result(0); }
    return values.has(args[1]!) ? result(0, values.get(args[1]!)) : result(4);
  };
  const options = { account, command };
  const anchor = createBotCapabilitySecretServiceAnchor(options);
  assert.equal(await anchor.load(), null);
  await anchor.store("generation-one", null);
  await assert.rejects(anchor.store("generation-two", null), /changed/);
  await anchor.store("generation-two", "generation-one");
  const marker = createBotCapabilitySecretServiceBootstrapMarker(options);
  const pending = { phase: "pending" as const, keyProof: "a".repeat(64) };
  await marker.store(pending, null);
  await assert.rejects(marker.store(pending, pending), /transition/);
  await marker.store({ ...pending, phase: "consumed" }, pending);
  await createTelegramBotBindingSecretServiceAnchor(options).store("telegram-one", null);
  await createTelegramBotBindingSecretServiceBootstrapMarker(options).store("telegram-bootstrap", null);
  assert.equal(values.size, 4);
});
test("Linux authority rejects locked, duplicate, unavailable and invalid responses without diagnostics", async () => {
  for (const code of [2, 3, 5, 6, 99]) {
    const anchor = createBotCapabilitySecretServiceAnchor({ account, command: async () => ({ ...result(code), stderr: "private-secret" }) });
    await assert.rejects(anchor.load(), (error: Error) => !error.message.includes("private-secret") && /unavailable/.test(error.message));
  }
  for (const value of ["", "x\n", "x\r", "x\0", "x".repeat(1025)]) {
    await assert.rejects(createBotCapabilitySecretServiceAnchor({ account, command: async () => result(0, value) }).load());
  }
  const anchor = createBotCapabilitySecretServiceAnchor({ account, command: async (args) => args[0] === "store" ? result(0) : result(4) });
  await assert.rejects(anchor.store("not-persisted", null), /verified/);
  await assert.rejects(anchor.store("bad\ninput", null), /invalid/);
});
test("native helper runner bounds output/time and handles missing executables without revealing stdin", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-authority-"));
  try {
    const helper = path.join(dir, "helper");
    await fs.writeFile(helper, `#!${process.execPath}\nlet value = ''; process.stdin.on('data', chunk => value += chunk); process.stdin.on('end', () => { if (process.argv.length !== 5 || process.argv.includes(value)) process.exit(6); process.stdout.write(value); });\n`, { mode: 0o700 });
    const echoed = await createSecretServiceAuthorityCommand(helper)(["store", ROLLBACK_SERVICE, account], "private-secret");
    assert.equal(echoed.exitCode, 0);
    assert.equal(echoed.stdout, "private-secret");
    await fs.writeFile(helper, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write('x'.repeat(5000)));\n`, { mode: 0o700 });
    await assert.rejects(createSecretServiceAuthorityCommand(helper)(["store", ROLLBACK_SERVICE, account], "private-secret"), /unavailable/);
    await fs.writeFile(helper, `#!${process.execPath}\nsetTimeout(() => {}, 10000);\n`, { mode: 0o700 });
    await assert.rejects(createSecretServiceAuthorityCommand(helper, 30)(["lookup", ROLLBACK_SERVICE, account]), /unavailable/);
    await assert.rejects(createSecretServiceAuthorityCommand(path.join(dir, "absent"))(["store", ROLLBACK_SERVICE, account], "private-secret"), /unavailable/);
    const command = createSecretServiceAuthorityCommand(helper);
    await assert.rejects(command(["store", "unknown", account], "secret"), /invalid/);
    await assert.rejects(command(["store", ROLLBACK_SERVICE, "invalid"], "secret"), /invalid/);
    await assert.rejects(command(["store", ROLLBACK_SERVICE, account]), /invalid/);
    await assert.rejects(command(["lookup", ROLLBACK_SERVICE, account], "secret"), /invalid/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("helper resolution and unsupported platform preserve lazy fail-closed startup", async () => {
  assert.equal(resolveSecretServiceAuthorityHelper({ cwd: "/workspace" }), "/workspace/build/native/aiden-secret-service-authority");
  assert.equal(resolveSecretServiceAuthorityHelper({ cwd: "/workspace", resourcesPath: "/opt/aiden/resources" }), "/opt/aiden/Helpers/aiden-secret-service-authority");
  assert.equal(resolveSecretServiceAuthorityHelper({ cwd: "/workspace", resourcesPath: "/opt/electron/resources", defaultApp: true }), "/workspace/build/native/aiden-secret-service-authority");
  await assert.rejects(createBotAuthorities({ account }, "win32").anchor.load(), /unsupported/);
});

test("native authority helper inherits only validated desktop bus context", async () => {
  const clean = secretServiceAuthorityEnvironment({
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    XDG_RUNTIME_DIR: "/run/user/1000",
    LD_PRELOAD: "private-loader", NODE_OPTIONS: "private-node-option", OPENAI_API_KEY: "private-key",
    PATH: "/private/bin", LANG: "private-locale", HOME: "/private/home",
  });
  assert.deepEqual(clean, { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", XDG_RUNTIME_DIR: "/run/user/1000" });
  for (const bus of ["tcp:host=remote", "unix:path=/tmp/bus;tcp:host=remote", "unix:path=/tmp/invalid%xx", "unix:path=/tmp/bus\n"]) {
    assert.equal(secretServiceAuthorityEnvironment({ DBUS_SESSION_BUS_ADDRESS: bus }).DBUS_SESSION_BUS_ADDRESS, undefined);
  }
  for (const dir of ["relative", "/run/../tmp", "/tmp/bad\n"]) {
    assert.equal(secretServiceAuthorityEnvironment({ XDG_RUNTIME_DIR: dir }).XDG_RUNTIME_DIR, undefined);
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-authority-env-"));
  const keys = ["LD_PRELOAD", "NODE_OPTIONS", "OPENAI_API_KEY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  try {
    const helper = path.join(dir, "helper");
    await fs.writeFile(helper, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify(process.env)));\n`, { mode: 0o700 });
    process.env.LD_PRELOAD = "private-loader";
    process.env.NODE_OPTIONS = "--require=private-injection";
    process.env.OPENAI_API_KEY = "private-key";
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1000/bus";
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    const response = await createSecretServiceAuthorityCommand(helper)(["lookup", ROLLBACK_SERVICE, account]);
    assert.equal(response.exitCode, 0);
    const inherited = JSON.parse(response.stdout);
    // CoreFoundation initializes this value itself on macOS test hosts.
    if (process.platform === "darwin") delete inherited.__CF_USER_TEXT_ENCODING;
    // Node injects its active coverage directory into child processes even
    // when spawn receives an explicit environment; this is test instrumentation.
    if (process.env.NODE_V8_COVERAGE) {
      assert.equal(inherited.NODE_V8_COVERAGE, process.env.NODE_V8_COVERAGE);
      delete inherited.NODE_V8_COVERAGE;
    }
    assert.deepEqual(inherited, clean);
    assert.equal(response.stderr, "");
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
