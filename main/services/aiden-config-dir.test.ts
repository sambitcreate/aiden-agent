import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { AIDEN_CONFIG_DIR_ENV, AIDEN_DIR_NAME, aidenConfigDir } from "./aiden-config-dir.js";

test("defaults to ~/.aiden when no override is set", () => {
  assert.equal(aidenConfigDir({}), path.join(os.homedir(), AIDEN_DIR_NAME));
});

test("an absolute override replaces the default root", () => {
  const override = path.join(path.sep, "srv", "aiden-config");
  assert.equal(aidenConfigDir({ [AIDEN_CONFIG_DIR_ENV]: override }), override);
});

test("an override is normalized so a trailing slash cannot fork the path", () => {
  const override = path.join(path.sep, "srv", "aiden-config");
  assert.equal(aidenConfigDir({ [AIDEN_CONFIG_DIR_ENV]: `${override}${path.sep}` }), override);
  assert.equal(
    aidenConfigDir({ [AIDEN_CONFIG_DIR_ENV]: path.join(override, "nested", "..") }),
    override,
  );
});

test("surrounding whitespace does not defeat the override", () => {
  const override = path.join(path.sep, "srv", "aiden-config");
  assert.equal(aidenConfigDir({ [AIDEN_CONFIG_DIR_ENV]: `  ${override}  ` }), override);
});

test("an empty or whitespace-only override falls back to the default", () => {
  const expected = path.join(os.homedir(), AIDEN_DIR_NAME);
  assert.equal(aidenConfigDir({ [AIDEN_CONFIG_DIR_ENV]: "" }), expected);
  assert.equal(aidenConfigDir({ [AIDEN_CONFIG_DIR_ENV]: "   " }), expected);
});

// A packaged app's working directory is not predictable from outside, so a
// relative override must fail loudly rather than scatter config folders.
test("a relative override is rejected instead of resolved against cwd", () => {
  assert.throws(
    () => aidenConfigDir({ [AIDEN_CONFIG_DIR_ENV]: "relative/aiden" }),
    /must be an absolute path/i,
  );
  assert.throws(() => aidenConfigDir({ [AIDEN_CONFIG_DIR_ENV]: "./aiden" }), /absolute/i);
});
