import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import Ajv from "ajv";
import {
  BOT_FILE_TOOL_NAMES,
  buildBotFileTools,
} from "./bot-file-tool-router.js";
import { piRuntimeReplayPolicy } from "./pi-runtime-tool.js";

function byName(tools: readonly AgentTool[], name: string): AgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing ${name}`);
  return tool;
}

function textContent(result: Awaited<ReturnType<AgentTool["execute"]>>): string {
  const block = result.content[0];
  assert.equal(block?.type, "text");
  return block.type === "text" ? block.text : "";
}

async function fixture(): Promise<{
  parent: string;
  home: string;
  documents: string;
  outside: string;
  tools: AgentTool[];
}> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-file-router-"));
  const home = path.join(parent, "home");
  const documents = path.join(parent, "documents");
  const outside = path.join(parent, "outside");
  await Promise.all([home, documents, outside].map((directory) => fs.mkdir(directory)));
  await fs.writeFile(path.join(home, "identity.txt"), "bot-home", "utf8");
  await fs.writeFile(path.join(documents, "identity.txt"), "documents", "utf8");
  await fs.writeFile(path.join(outside, "private.txt"), "outside", "utf8");
  return {
    parent,
    home,
    documents,
    outside,
    tools: buildBotFileTools({
      defaultLocation: { id: "loc.home.opaque", label: "Bot folder", root: home },
      additionalLocations: [
        { id: "loc.docs.opaque", label: "Documents", root: documents },
      ],
    }),
  };
}

test("Bot file tools default to home and route an exact approved location", async () => {
  const value = await fixture();
  try {
    const read = byName(value.tools, "read_file");
    assert.equal(
      textContent(await read.execute("home-read", { path: "identity.txt" })),
      "bot-home",
    );
    assert.equal(
      textContent(
        await read.execute("documents-read", {
          path: "identity.txt",
          location: "loc.docs.opaque",
        }),
      ),
      "documents",
    );

    const write = byName(value.tools, "write_file");
    await write.execute("home-write", { path: "created.txt", content: "home-created" });
    await write.execute("documents-write", {
      path: "created.txt",
      content: "documents-created",
      location: "loc.docs.opaque",
    });
    assert.equal(await fs.readFile(path.join(value.home, "created.txt"), "utf8"), "home-created");
    assert.equal(
      await fs.readFile(path.join(value.documents, "created.txt"), "utf8"),
      "documents-created",
    );
  } finally {
    await fs.rm(value.parent, { recursive: true, force: true });
  }
});

test("Bot file tools support an approved root as the only default when home is off", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-file-router-no-home-"));
  const documents = path.join(parent, "documents");
  try {
    await fs.mkdir(documents);
    await fs.writeFile(path.join(documents, "identity.txt"), "approved-default", "utf8");
    const tools = buildBotFileTools({
      defaultLocation: { id: "loc.docs.opaque", label: "Documents", root: documents },
    });
    assert.equal(
      textContent(await byName(tools, "read_file").execute("default-approved", {
        path: "identity.txt",
      })),
      "approved-default",
    );
    assert.match(JSON.stringify(byName(tools, "read_file").parameters), /default enabled location/u);
    assert.doesNotMatch(byName(tools, "read_file").description, /Bot folder/u);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("Bot file tools inherit absolute, traversal, and symlink escape rejection", async () => {
  const value = await fixture();
  try {
    await fs.symlink(path.join(value.outside, "private.txt"), path.join(value.home, "escaped.txt"));
    const read = byName(value.tools, "read_file");
    await assert.rejects(
      read.execute("absolute", { path: path.join(value.outside, "private.txt") }),
      /outside the workspace folder/u,
    );
    await assert.rejects(
      read.execute("traversal", { path: "../outside/private.txt" }),
      /outside the workspace folder/u,
    );
    await assert.rejects(
      read.execute("symlink", { path: "escaped.txt" }),
      /resolves outside the workspace folder/u,
    );

    const write = byName(value.tools, "write_file");
    await assert.rejects(
      write.execute("write-traversal", { path: "../outside/new.txt", content: "no" }),
      /outside the workspace folder/u,
    );
    await assert.rejects(fs.access(path.join(value.outside, "new.txt")));
  } finally {
    await fs.rm(value.parent, { recursive: true, force: true });
  }
});

test("Bot file router fails closed for unknown and missing locations", async () => {
  const value = await fixture();
  try {
    const read = byName(value.tools, "read_file");
    await assert.rejects(
      read.execute("unknown", { path: "identity.txt", location: "loc.unknown.opaque" }),
      /not enabled for this Bot chat/u,
    );
    await assert.rejects(
      read.execute("non-string", { path: "identity.txt", location: 1 }),
      /not enabled for this Bot chat/u,
    );
    await assert.rejects(
      read.execute("missing-file", { path: "missing.txt" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, new RegExp(value.home, "u"));
        return true;
      },
    );

    const previousDocuments = path.join(value.parent, "previous-documents");
    await fs.rename(value.documents, previousDocuments);
    await fs.mkdir(value.documents);
    await fs.writeFile(path.join(value.documents, "identity.txt"), "replacement", "utf8");
    await assert.rejects(
      read.execute("replaced", { path: "identity.txt", location: "loc.docs.opaque" }),
      /authorized workspace root changed/u,
    );

    await fs.rm(value.documents, { recursive: true, force: true });
    await assert.rejects(
      read.execute("missing", { path: "identity.txt", location: "loc.docs.opaque" }),
      /authorized workspace root changed/u,
    );
  } finally {
    await fs.rm(value.parent, { recursive: true, force: true });
  }
});

test("Bot file router rejects a root replaced after authority resolution but before tool pinning", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-file-router-late-pin-"));
  const approved = path.join(parent, "approved");
  const replacement = path.join(parent, "replacement");
  try {
    await Promise.all([fs.mkdir(approved), fs.mkdir(replacement)]);
    const expected = await fs.stat(approved, { bigint: true });
    await fs.rename(approved, path.join(parent, "previous"));
    await fs.rename(replacement, approved);
    assert.throws(
      () => buildBotFileTools({
        defaultLocation: {
          id: "approved",
          label: "Approved",
          root: approved,
          expectedIdentity: {
            device: expected.dev.toString(),
            inode: expected.ino.toString(),
          },
        },
      }),
      /changed before this generation started/u,
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("Bot file router publishes one bounded schema set and no shell or image tool", async () => {
  const value = await fixture();
  try {
    const names = value.tools.map(({ name }) => name);
    assert.deepEqual(names, BOT_FILE_TOOL_NAMES);
    assert.equal(new Set(names).size, names.length);
    assert.equal(names.includes("run_command"), false);
    assert.equal(names.includes("share_image"), false);
    assert.equal(piRuntimeReplayPolicy(byName(value.tools, "read_file")), "safe");
    assert.equal(piRuntimeReplayPolicy(byName(value.tools, "write_file")), "never");

    for (const tool of value.tools) {
      const schema = JSON.stringify(tool.parameters);
      assert.match(schema, /loc\.home\.opaque/u);
      assert.match(schema, /loc\.docs\.opaque/u);
      assert.match(schema, /Bot folder/u);
      assert.match(schema, /Documents/u);
      assert.doesNotMatch(schema, new RegExp(value.home.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      assert.doesNotMatch(
        schema,
        new RegExp(value.documents.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
      );
    }

    const validateRead = new Ajv().compile(byName(value.tools, "read_file").parameters as object);
    assert.equal(validateRead({ path: "identity.txt" }), true);
    assert.equal(
      validateRead({ path: "identity.txt", location: "loc.docs.opaque" }),
      true,
    );
    assert.equal(
      validateRead({ path: "identity.txt", location: "loc.unknown.opaque" }),
      false,
    );
    assert.equal(validateRead({ path: "identity.txt", unexpected: true }), false);
  } finally {
    await fs.rm(value.parent, { recursive: true, force: true });
  }
});

test("Bot file router rejects ambiguous or unsafe main-owned locations", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-bot-file-router-config-"));
  const home = path.join(parent, "home");
  const documents = path.join(parent, "documents");
  try {
    await Promise.all([fs.mkdir(home), fs.mkdir(documents)]);
    assert.throws(
      () =>
        buildBotFileTools({
          defaultLocation: { id: "same", label: "Bot folder", root: home },
          additionalLocations: [{ id: "same", label: "Documents", root: documents }],
        }),
      /Duplicate Bot file location id/u,
    );
    assert.throws(
      () =>
        buildBotFileTools({
          defaultLocation: { id: "home", label: "Bot folder", root: home },
          additionalLocations: [{ id: "docs", label: "Documents", root: home }],
        }),
      /unique root/u,
    );
    assert.throws(
      () => buildBotFileTools({ defaultLocation: { id: "../home", label: "Bot folder", root: home } }),
      /safe opaque location id/u,
    );
    assert.throws(
      () => buildBotFileTools({ defaultLocation: { id: "home", label: "Bad\nlabel", root: home } }),
      /safe display label/u,
    );
    assert.throws(
      () => buildBotFileTools({ defaultLocation: { id: "home", label: "/Users/person", root: home } }),
      /safe display label/u,
    );
    assert.throws(
      () => buildBotFileTools({ defaultLocation: { id: "home", label: "Bot folder", root: "relative" } }),
      /absolute root/u,
    );
    assert.throws(
      () => buildBotFileTools({
        defaultLocation: {
          id: "home",
          label: "Bot folder",
          root: home,
          expectedIdentity: { device: "invalid", inode: "1" },
        },
      }),
      /valid filesystem identity/u,
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
