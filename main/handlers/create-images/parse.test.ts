import assert from "node:assert/strict";
import test from "node:test";
import {
  parseConsentRequest,
  parseCreateRequest,
  parseEmptyRequest,
  parseGetRunRequest,
  parseImportRequest,
  parseListRunsRequest,
  parseMutateRequest,
  parsePrepareRequest,
  parseRunRequest,
  parseSaveRequest,
  parseWorkflowRequest,
} from "./parse.js";

const INVALID = { message: "Invalid Create Images request." };
const ID = "3f2b8c1e-9d4a-4b6f-8e2c-1a7d5b9c0e4f";

function refuses(parse: (value: unknown) => unknown, cases: readonly unknown[]): void {
  for (const value of cases) assert.throws(() => parse(value), INVALID, JSON.stringify(value));
}

test("ids refuse Object.prototype names, blanks and whitespace, and accept generated ids", () => {
  const reserved = Object.getOwnPropertyNames(Object.prototype);
  refuses((value) => parseWorkflowRequest({ workflowId: value }), [...reserved, "", " ", " \t ", ` ${ID}`, "../wf", "a".repeat(129), 7]);
  refuses((value) => parseRunRequest({ runId: value }), reserved);
  refuses((nodeId) => parsePrepareRequest({ workflowId: ID, revision: 1, scope: { kind: "node-only", nodeId } }), reserved);
  assert.deepEqual(parseWorkflowRequest({ workflowId: ID }), { workflowId: ID });
  assert.deepEqual(parseWorkflowRequest({ workflowId: "constructor-2" }), { workflowId: "constructor-2" });
});

test("requests must be plain objects that own exactly their keys", () => {
  const inherited = Object.create({ workflowId: ID }) as object;
  const map = Object.assign(new Map(), { workflowId: ID });
  refuses(parseWorkflowRequest, [inherited, map, [ID], null, ID, { workflowId: ID, extra: 1 }]);
  refuses(parseEmptyRequest, [new Map(), new Date(0), [], null, { stray: 1 }]);
  assert.equal(parseEmptyRequest(undefined), undefined);
  assert.equal(parseEmptyRequest({}), undefined);
  assert.equal(parseEmptyRequest(Object.create(null)), undefined);
});

test("revisions, limits and consent ids are bounded", () => {
  refuses((revision) => parseSaveRequest({ workflowId: ID, baseRevision: revision, document: {} }), [0, -1, 1.5, "1", Number.NaN, 2 ** 53]);
  assert.equal(parseSaveRequest({ workflowId: ID, baseRevision: 1, document: {} }).baseRevision, 1);
  refuses((limit) => parseListRunsRequest({ workflowId: ID, limit }), [0, 51, 1.5, Number.NaN, "5"]);
  assert.deepEqual([1, 50].map((limit) => parseListRunsRequest({ workflowId: ID, limit }).limit), [1, 50]);
  refuses((consentId) => parseConsentRequest({ consentId }), ["a".repeat(15), "a".repeat(65), "a".repeat(20) + "!", 16]);
  assert.deepEqual(["a".repeat(16), "b".repeat(64)].map((consentId) => parseConsentRequest({ consentId }).consentId), ["a".repeat(16), "b".repeat(64)]);
});

test("get-run takes a run id or a workflow id, never both", () => {
  assert.deepEqual(parseGetRunRequest({ runId: ID }), { runId: ID });
  assert.deepEqual(parseGetRunRequest({ workflowId: ID }), { workflowId: ID });
  refuses(parseGetRunRequest, [{ runId: ID, workflowId: ID }, {}, { runId: "toString" }]);
});

test("titles follow the schema rule: single line, not blank, trimmed in main", () => {
  const titles = ["a\u0000b", "Bikes\u0007", "x\u001b[31m", "y\u007f", "   ", "", "t".repeat(121), 3];
  refuses((title) => parseCreateRequest({ template: "blank", title }), titles);
  refuses((title) => parseMutateRequest({ op: "rename", workflowId: ID, title }), titles);
  assert.deepEqual(parseCreateRequest({ template: "starter", title: "  Bikes  " }), { template: "starter", title: "Bikes" });
  assert.deepEqual(parseMutateRequest({ op: "rename", workflowId: ID, title: `\t${"t".repeat(120)} ` }), {
    op: "rename", workflowId: ID, title: "t".repeat(120),
  });
  refuses(parseCreateRequest, [{ template: "gallery" }, { template: "blank", title: "x", extra: 1 }]);
  refuses(parseMutateRequest, [{ op: "archive", workflowId: ID }, { op: "delete", workflowId: ID, title: "x" }]);
});

test("imports take the dialog or bounded bytes of a supported type", () => {
  const png = new Uint8Array([1, 2, 3]);
  assert.deepEqual(parseImportRequest({ source: "dialog" }), { source: "dialog" });
  refuses(parseImportRequest, [
    { source: "dialog", name: "x.png" },
    { source: "bytes", name: "x.gif", mimeType: "image/gif", data: png },
    { source: "bytes", name: "x.png", mimeType: "image/png", data: [1, 2, 3] },
    { source: "bytes", name: "x.png", mimeType: "image/png", data: new Uint8Array(0) },
    { source: "bytes", name: "n".repeat(256), mimeType: "image/png", data: png },
    { source: "url", url: "https://example.com/x.png" },
  ]);
  assert.equal(parseImportRequest({ source: "bytes", name: "x.webp", mimeType: "image/webp", data: png }).source, "bytes");
});
