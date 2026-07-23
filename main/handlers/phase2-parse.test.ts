import assert from "node:assert/strict";
import test from "node:test";
import { parseMcpServer, parseSkill } from "./phase2-parse.js";

test("parseSkill parses a complete skill payload", () => {
  const skill = parseSkill({
    id: "summarize",
    name: "Summarize",
    description: "Summarize text",
    instructions: "Be concise.",
    enabled: false,
  });
  assert.deepEqual(skill, {
    id: "summarize",
    name: "Summarize",
    description: "Summarize text",
    instructions: "Be concise.",
    enabled: false,
  });
});

test("parseSkill applies defaults for optional fields", () => {
  const skill = parseSkill({ id: "x", name: "X" });
  assert.equal(skill.description, "");
  assert.equal(skill.instructions, "");
  assert.equal(skill.enabled, true); // default enabled
});

test("parseSkill rejects non-object payloads and missing required fields", () => {
  assert.throws(() => parseSkill(null), /Invalid skill payload/);
  assert.throws(() => parseSkill("hi"), /Invalid skill payload/);
  assert.throws(() => parseSkill({}), /Expected non-empty string for "id"/);
  assert.throws(() => parseSkill({ id: "x" }), /Expected non-empty string for "name"/);
  assert.throws(() => parseSkill({ id: "", name: "x" }), /Expected non-empty string for "id"/);
});

test("parseMcpServer parses a stdio server with command/args/env", () => {
  const server = parseMcpServer({
    id: "fs",
    name: "Filesystem",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@mcp/fs", "/tmp", 123], // 123 is filtered out (non-string)
    env: { NODE_ENV: "production", BAD: 42 }, // BAD filtered out (non-string)
  });
  assert.equal(server.transport, "stdio");
  assert.equal(server.command, "npx");
  assert.deepEqual(server.args, ["-y", "@mcp/fs", "/tmp"]);
  assert.deepEqual(server.env, { NODE_ENV: "production" });
  assert.equal(server.url, undefined);
  assert.equal(server.enabled, true);
});

test("parseMcpServer parses http/sse transports and defaults unknown transport to stdio", () => {
  assert.equal(parseMcpServer({ id: "a", name: "A", transport: "http" }).transport, "http");
  assert.equal(parseMcpServer({ id: "b", name: "B", transport: "sse" }).transport, "sse");
  assert.equal(parseMcpServer({ id: "c", name: "C", transport: "weird" }).transport, "stdio");
  assert.equal(parseMcpServer({ id: "d", name: "D" }).transport, "stdio");
});

test("parseMcpServer parses url + headers for remote servers", () => {
  const server = parseMcpServer({
    id: "api",
    name: "API",
    transport: "http",
    url: "https://example.com/mcp",
    headers: { Authorization: "Bearer x", BAD: null }, // BAD filtered out
    oauth: true,
    enabled: false,
  });
  assert.equal(server.url, "https://example.com/mcp");
  assert.deepEqual(server.headers, { Authorization: "Bearer x" });
  assert.equal(server.oauth, true);
  assert.equal(server.enabled, false);
});

test("parseMcpServer rejects non-object payloads and missing required fields", () => {
  assert.throws(() => parseMcpServer(null), /Invalid MCP server payload/);
  assert.throws(() => parseMcpServer("hi"), /Invalid MCP server payload/);
  assert.throws(() => parseMcpServer({}), /Expected non-empty string for "id"/);
  assert.throws(() => parseMcpServer({ id: "x" }), /Expected non-empty string for "name"/);
});

test("parseMcpServer returns undefined env/headers/args when empty or absent", () => {
  const server = parseMcpServer({
    id: "x",
    name: "X",
    transport: "stdio",
    args: [],
    env: {},
    headers: {},
  });
  assert.equal(server.env, undefined);
  assert.equal(server.headers, undefined);
  assert.equal(server.args, undefined);
});

test("parseMcpServer passes through presetId only when it is a non-empty string", () => {
  assert.equal(parseMcpServer({ id: "a", name: "A", presetId: "composio" }).presetId, "composio");
  assert.equal(parseMcpServer({ id: "b", name: "B" }).presetId, undefined);
  assert.equal(parseMcpServer({ id: "c", name: "C", presetId: "" }).presetId, undefined);
  assert.equal(parseMcpServer({ id: "d", name: "D", presetId: 42 }).presetId, undefined);
});
