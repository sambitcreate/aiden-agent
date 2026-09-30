import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { normalizeMcpToolInputSchema } from "./mcp-tool-schema.js";

// Shape emitted by schemars 0.8 (draft-07, `definitions`, float minimums) for:
//   struct ReadArgs { path: String, offset: Option<u64>, limit: Option<u32>, retries: u8,
//     delta: i16, ratio: f64, created: String /* date-time */, format: String,
//     tags: Vec<Tag>, window: Option<Window> }
//   struct Tag { id: usize, weight: f32 }   struct Window(i32, i32);
function schemars08Fixture() {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "ReadArgs",
    type: "object",
    required: ["delta", "format", "path", "ratio", "retries", "tags"],
    properties: {
      path: { type: "string" },
      offset: { type: ["integer", "null"], format: "uint64", minimum: 0.0 },
      limit: { type: ["integer", "null"], format: "uint32", minimum: 0.0 },
      retries: { type: "integer", format: "uint8", minimum: 0.0 },
      delta: { type: "integer", format: "int16" },
      ratio: { type: "number", format: "double" },
      created: { type: "string", format: "date-time" },
      format: { type: "string", description: "Output format name." },
      tags: { type: "array", items: { $ref: "#/definitions/Tag" } },
      window: { anyOf: [{ $ref: "#/definitions/Window" }, { type: "null" }] },
    },
    definitions: {
      Tag: {
        type: "object",
        required: ["id", "weight"],
        properties: {
          id: { type: "integer", format: "uint", minimum: 0.0 },
          weight: { type: "number", format: "float" },
        },
      },
      Window: {
        type: "array",
        items: [
          { type: "integer", format: "int32" },
          { type: "integer", format: "int32" },
        ],
        maxItems: 2,
        minItems: 2,
      },
    },
  };
}

// Shape emitted by schemars 1.x (2020-12, `$defs`, explicit u8 maximum, `prefixItems`).
function schemars1Fixture() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Resize",
    type: "object",
    required: ["channels", "size"],
    properties: {
      channels: { type: "integer", format: "uint8", minimum: 0, maximum: 255 },
      level: { type: "integer", format: "int8", minimum: -10 },
      size: { $ref: "#/$defs/Size" },
      extra: {
        type: "object",
        additionalProperties: { type: "integer", format: "uint16", minimum: 0 },
      },
    },
    $defs: {
      Size: {
        type: "array",
        prefixItems: [
          { type: "integer", format: "uint32", minimum: 0 },
          { type: "integer", format: "uint32", minimum: 0 },
        ],
        minItems: 2,
        maxItems: 2,
      },
    },
  };
}

function formatsIn(value: unknown, parentKey?: string): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => formatsIn(entry));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    key === "format" && parentKey !== "properties" && typeof entry === "string"
      ? [entry]
      : formatsIn(entry, key),
  );
}

function strictDraft07() {
  const ajv = new Ajv({ strict: true, strictRequired: false, validateFormats: true });
  addFormats(ajv);
  return ajv;
}

function strictDraft2020() {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, validateFormats: true });
  addFormats(ajv);
  return ajv;
}

test("raw schemars schemas are rejected by a strict JSON Schema consumer", () => {
  assert.throws(() => strictDraft07().compile(schemars08Fixture()), /unknown format "uint64"/u);
  assert.throws(() => strictDraft2020().compile(schemars1Fixture()), /unknown format "uint8"/u);
});

test("schemars 0.8 schemas compile after normalization and keep their numeric ranges", () => {
  const raw = schemars08Fixture();
  const snapshot = structuredClone(raw);
  const normalized = normalizeMcpToolInputSchema(raw);
  assert.deepEqual(raw, snapshot, "the server's raw schema must not be mutated");
  assert.deepEqual(formatsIn(normalized), ["date-time"]);

  const validate = strictDraft07().compile(normalized);
  const valid = {
    path: "a.txt",
    offset: null,
    limit: 4_294_967_295,
    retries: 255,
    delta: -32_768,
    ratio: 0.5,
    created: "2026-09-27T10:00:00Z",
    format: "json",
    tags: [{ id: 3, weight: 1.5 }],
    window: [-2_147_483_648, 2_147_483_647],
  };
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  for (const invalid of [
    { ...valid, retries: 256 },
    { ...valid, limit: 4_294_967_296 },
    { ...valid, offset: -1 },
    { ...valid, delta: 32_768 },
    { ...valid, tags: [{ id: -1, weight: 1 }] },
    { ...valid, window: [0, 2_147_483_648] },
    { ...valid, created: "yesterday" },
  ]) {
    assert.equal(validate(invalid), false, JSON.stringify(invalid));
  }
});

test("schemars 1.x schemas normalize nested $defs, prefixItems, and additionalProperties", () => {
  const normalized = normalizeMcpToolInputSchema(schemars1Fixture());
  assert.deepEqual(formatsIn(normalized), []);
  const validate = strictDraft2020().compile(normalized);
  const valid = { channels: 3, level: -10, size: [640, 480], extra: { a: 65_535 } };
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...valid, level: -11 }), false, "a tighter server minimum must survive");
  assert.equal(validate({ ...valid, level: 128 }), false);
  assert.equal(validate({ ...valid, size: [640, -1] }), false);
  assert.equal(validate({ ...valid, extra: { a: 65_536 } }), false);
});

test("64-bit and float formats are dropped without inventing inexact bounds", () => {
  const normalized = normalizeMcpToolInputSchema({
    type: "object",
    properties: {
      id: { type: "integer", format: "int64" },
      big: { type: "integer", format: "uint128", minimum: 0.0 },
      ratio: { type: "number", format: "float" },
    },
  });
  assert.deepEqual(normalized.properties, {
    id: { type: "integer" },
    big: { type: "integer", minimum: 0 },
    ratio: { type: "number" },
  });
});

test("numeric format names on non-numeric schemas lose the format but gain no bounds", () => {
  const normalized = normalizeMcpToolInputSchema({
    type: "object",
    properties: { snowflake: { type: "string", format: "uint64", pattern: "^[0-9]+$" } },
  });
  assert.deepEqual(normalized.properties.snowflake, { type: "string", pattern: "^[0-9]+$" });
});

test("schemas without schemars formats pass through unchanged", () => {
  const schema = {
    type: "object",
    properties: {
      url: { type: "string", format: "uri" },
      count: { type: "integer", minimum: 1, maximum: 10 },
    },
    required: ["url"],
  };
  assert.deepEqual(normalizeMcpToolInputSchema(schema), schema);
  assert.equal(normalizeMcpToolInputSchema(undefined), undefined);
});

test("draft-07 dependencies normalize schemas while preserving property lists", () => {
  const schema = {
    type: "object",
    dependencies: {
      mode: { properties: { retries: { type: "integer", format: "uint8" } } },
      name: ["mode"],
    },
  };
  const normalized = normalizeMcpToolInputSchema(schema);
  assert.deepEqual(normalized.dependencies.mode.properties.retries, {
    type: "integer",
    minimum: 0,
    maximum: 255,
  });
  assert.deepEqual(normalized.dependencies.name, ["mode"]);
  assert.equal(schema.dependencies.mode.properties.retries.format, "uint8");
  const validate = strictDraft07().compile(normalized);
  assert.equal(validate({ mode: true, retries: 256 }), false);
  assert.equal(validate({ mode: true, retries: 255 }), true);
});


test("deep schemas normalize every numeric leaf without a recursive depth cutoff", () => {
  const leaf = { type: "integer", format: "uint32" };
  let schema: Record<string, unknown> = leaf;
  for (let depth = 0; depth < 2_000; depth += 1) {
    schema = { type: "object", properties: { child: schema } };
  }
  let normalized = normalizeMcpToolInputSchema(schema);
  for (let depth = 0; depth < 2_000; depth += 1) {
    normalized = (normalized.properties as Record<string, Record<string, unknown>>).child;
  }
  assert.deepEqual(normalized, { type: "integer", minimum: 0, maximum: 4_294_967_295 });
  assert.deepEqual(leaf, { type: "integer", format: "uint32" });
});
