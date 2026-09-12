/* global process */
import assert from "node:assert/strict";
import { setTimeout, clearTimeout } from "node:timers";
import { stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import test from "node:test";

const services = [
  "com.aiden.bot-capability.rollback-authority.v1",
  "com.aiden.bot-capability.bootstrap-consumed.v1",
  "com.aiden.telegram-bot-binding.rollback-authority.v1",
  "com.aiden.telegram-bot-binding.bootstrap-consumed.v1",
];
const account = `user-data:${"b".repeat(64)}`;
function execute(binary, args, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Isolated keyring command timed out.")); }, 5000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdin.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(stdin);
  });
}

test("private Linux keyring preserves four authority namespaces across helper processes and fails closed when locked", async () => {
  const root = process.env.AIDEN_PRIVATE_KEYRING_TEST_ROOT;
  assert.ok(root?.startsWith("/tmp/aiden-private-keyring-"), "Use the dedicated runner; never a host session bus.");
  assert.equal(process.env.HOME, undefined);
  assert.equal(process.env.XDG_DATA_HOME, `${root}/data`);
  assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS?.startsWith("unix:"));
  const helper = process.env.AIDEN_AUTHORITY_TEST_HELPER;
  assert.ok(helper);
  const daemon = await execute("/usr/bin/gnome-keyring-daemon", ["--unlock", "--components=secrets"], "integration-password");
  assert.equal(daemon.code, 0, daemon.stderr);
  const gdbus = (method, ...args) => execute("/usr/bin/gdbus", ["call", "--session", "--dest", "org.freedesktop.secrets", "--object-path", "/org/freedesktop/secrets", "--method", `org.freedesktop.Secret.Service.${method}`, ...args]);
  const defaultAlias = await gdbus("ReadAlias", "default");
  assert.equal(defaultAlias.code, 0, defaultAlias.stderr);
  assert.match(defaultAlias.stdout, /collection\/login/u);
  const run = (op, service, value) => execute(helper, [op, service, account], value);
  for (const [index, service] of services.entries()) {
    assert.deepEqual(await run("lookup", service), { code: 4, stdout: "", stderr: "" });
    assert.deepEqual(await run("store", service, `initial-${index}`), { code: 0, stdout: "", stderr: "" });
    assert.deepEqual(await run("lookup", service), { code: 0, stdout: `initial-${index}`, stderr: "" });
    assert.deepEqual(await run("store", service, `updated-${index}`), { code: 0, stdout: "", stderr: "" });
  }
  for (const [index, service] of services.entries()) {
    assert.deepEqual(await run("lookup", service), { code: 0, stdout: `updated-${index}`, stderr: "" });
  }
  assert.ok((await stat(`${root}/data/keyrings/login.keyring`)).size > 0, "The default collection must persist outside session memory.");
  // Replacing the daemon destroys its in-memory state; unlock the same private
  // persistent collection and verify each namespace survived independently.
  const restarted = await execute("/usr/bin/gnome-keyring-daemon", ["--replace", "--unlock", "--components=secrets"], "integration-password");
  assert.equal(restarted.code, 0, restarted.stderr);
  for (const [index, service] of services.entries()) {
    assert.deepEqual(await run("lookup", service), { code: 0, stdout: `updated-${index}`, stderr: "" });
  }
  // A small libsecret fixture deliberately creates a second matching item with
  // replacement disabled. Separate gdbus CLI calls cannot share a secret session.
  const fixtureSource = `${root}/duplicate.c`;
  const fixture = `${root}/duplicate`;
  await writeFile(fixtureSource, `#include <libsecret/secret.h>
int main(int argc, char **argv) {
  if (argc != 3) return 1;
  GError *error = NULL;
  const SecretSchema schema = { .name = "com.aiden.bot-authority.v1", .flags = SECRET_SCHEMA_NONE, .attributes = {{"service", SECRET_SCHEMA_ATTRIBUTE_STRING}, {"account", SECRET_SCHEMA_ATTRIBUTE_STRING}, {NULL, 0}} };
  SecretService *service = secret_service_get_sync(SECRET_SERVICE_OPEN_SESSION, NULL, &error);
  if (!service || error) return 2;
  SecretCollection *collection = secret_collection_for_alias_sync(service, SECRET_COLLECTION_DEFAULT, SECRET_COLLECTION_NONE, NULL, &error);
  if (!collection || error) return 3;
  GHashTable *attrs = secret_attributes_build(&schema, "service", argv[1], "account", argv[2], NULL);
  SecretValue *value = secret_value_new("duplicate", -1, "text/plain");
  SecretItem *item = secret_item_create_sync(collection, &schema, attrs, "Integration duplicate", value, SECRET_ITEM_CREATE_NONE, NULL, &error);
  return item && !error ? 0 : 4;
}
`);
  const flags = await execute("/usr/bin/pkg-config", ["--cflags", "--libs", "libsecret-1"]);
  assert.equal(flags.code, 0, flags.stderr);
  const compiled = await execute("/usr/bin/cc", [fixtureSource, "-o", fixture, ...flags.stdout.trim().split(/\s+/u)]);
  assert.equal(compiled.code, 0, compiled.stderr);
  const duplicate = await execute(fixture, [services[0], account]);
  assert.equal(duplicate.code, 0, duplicate.stderr);
  assert.deepEqual(await run("lookup", services[0]), { code: 5, stdout: "", stderr: "" });
  assert.deepEqual(await run("store", services[0], "must-not-repair-duplicates"), { code: 5, stdout: "", stderr: "" });
  const locked = await execute("/usr/bin/gdbus", ["call", "--session", "--dest", "org.freedesktop.secrets", "--object-path", "/org/freedesktop/secrets", "--method", "org.freedesktop.Secret.Service.Lock", "['/org/freedesktop/secrets/collection/login']"]);
  assert.equal(locked.code, 0, locked.stderr);
  assert.match(locked.stdout, /collection\/login/u);
  for (const service of services) {
    assert.deepEqual(await run("lookup", service), { code: 3, stdout: "", stderr: "" });
    assert.deepEqual(await run("store", service, "must-not-write"), { code: 3, stdout: "", stderr: "" });
  }
  const sessionAlias = await gdbus("SetAlias", "default", "/org/freedesktop/secrets/collection/session");
  assert.equal(sessionAlias.code, 0, sessionAlias.stderr);
  assert.deepEqual(await run("lookup", services[0]), { code: 2, stdout: "", stderr: "" });
  assert.deepEqual(await run("store", services[0], "must-not-be-ephemeral"), { code: 2, stdout: "", stderr: "" });
  // GNOME falls back to login when an alias is cleared. Delete only this
  // private fixture collection so ReadAlias can establish genuine absence.
  const unlocked = await execute("/usr/bin/gnome-keyring-daemon", ["--unlock", "--components=secrets"], "integration-password");
  assert.equal(unlocked.code, 0, unlocked.stderr);
  const deleted = await execute("/usr/bin/gdbus", ["call", "--session", "--dest", "org.freedesktop.secrets", "--object-path", "/org/freedesktop/secrets/collection/login", "--method", "org.freedesktop.Secret.Collection.Delete"]);
  assert.equal(deleted.code, 0, deleted.stderr);
  assert.match(deleted.stdout, /objectpath '\/'/u);
  const missingAlias = await gdbus("SetAlias", "default", "/");
  assert.equal(missingAlias.code, 0, missingAlias.stderr);
  assert.match((await gdbus("ReadAlias", "default")).stdout, /objectpath '\/'/u);
  assert.deepEqual(await run("lookup", services[0]), { code: 2, stdout: "", stderr: "" });
  assert.deepEqual(await run("store", services[0], "must-not-bootstrap-without-default"), { code: 2, stdout: "", stderr: "" });

});
