import assert from "node:assert/strict";
import test from "node:test";
import { parsePeerProjectClone } from "./peer-project-clone.js";
const input = { mode: "clone", selection: `sel_${"a".repeat(43)}`, url: "git@example.invalid:acme/widget.git", files: [] };
test("clone requests admit only explicit bounded environment text files and network remotes", () => {
  assert.deepEqual(parsePeerProjectClone(input).files, []);
  assert.deepEqual(parsePeerProjectClone({ ...input, files: [{ name: ".env.local", content: "A=synthetic" }] }).files, [{ name: ".env.local", content: "A=synthetic" }]);
  for (const files of [[{ name: "../.env", content: "" }], [{ name: ".git/config", content: "" }], [{ name: ".env", content: "binary\0" }], [{ name: ".env", content: "x".repeat(131073) }], [{ name: ".env", content: "a" }, { name: ".ENV", content: "b" }], Array.from({ length: 5 }, (_, i) => ({ name: `.env.${i}`, content: "x".repeat(131072) }))]) assert.throws(() => parsePeerProjectClone({ ...input, files }));
  for (const url of ["file:///tmp/repo", "ext::helper", "https://user:secret@example.invalid/repo.git"]) assert.throws(() => parsePeerProjectClone({ ...input, url }));
});
