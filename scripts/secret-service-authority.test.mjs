/* global process */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";

const execute = promisify(execFile);
const helper = fileURLToPath(new URL("../build/native/aiden-secret-service-authority", import.meta.url));
const service = "com.aiden.bot-capability.rollback-authority.v1";
const account = `user-data:${"a".repeat(64)}`;
const enabled = process.platform === "linux";
const env = { PATH: "/usr/bin:/bin", LANG: "C", DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join("/tmp", `aiden-no-secret-service-${process.pid}`)}` };

test("native authority rejects invalid namespaces and accounts before keyring access", { skip: !enabled }, async () => {
  for (const args of [["lookup", "other-service", account], ["lookup", service, "invalid"], ["erase", service, account]]) {
    await assert.rejects(execute(helper, args, { env, timeout: 2000 }), (error) => {
      assert.equal(error.code, 6);
      assert.equal(error.stdout, "");
      assert.equal(error.stderr, "");
      return true;
    });
  }
});

test("native authority reports unavailable bus rather than a missing bootstrap item", { skip: !enabled }, async () => {
  await assert.rejects(execute(helper, ["lookup", service, account], { env, timeout: 2000 }), (error) => {
    assert.equal(error.code, 2);
    assert.equal(error.stdout, "");
    assert.equal(error.stderr, "");
    return true;
  });
});
