import assert from "node:assert/strict";
import test from "node:test";
import { generativeUiPreviewTokenFromUrl } from "../../renderer/shared/generative-ui.js";
import {
  generativeUiPreviewResponse,
  openGenerativeUiDraftStream,
  registerGenerativeUiPreviewDocument,
} from "./generative-ui-preview-store.js";

function tokenOf(src: string): string {
  const token = generativeUiPreviewTokenFromUrl(src);
  assert.ok(token, src);
  return token;
}

test("a draft stream is served once, progressively, under a nonce-only script policy", async () => {
  const draft = openGenerativeUiDraftStream("Revenue", undefined);
  const response = generativeUiPreviewResponse(tokenOf(draft.src));
  assert.ok(response);
  assert.equal(response.status, 200);
  const csp = response.headers.get("content-security-policy") ?? "";
  const nonce = /script-src 'nonce-([A-Za-z0-9+/=]{16,})'/u.exec(csp)?.[1];
  assert.ok(nonce, csp);
  assert.doesNotMatch(/script-src[^;]*/u.exec(csp)?.[0] ?? "", /unsafe-inline/u);
  assert.match(csp, /connect-src 'none'/u);

  draft.append("<p>one</p>");
  draft.append("<script>window.ran=1</script>");
  draft.close();
  const body = await response.text();
  assert.ok(body.includes(`<script nonce="${nonce}">`), "the bridge carries the response nonce");
  assert.match(body, /<p>one<\/p><script>window\.ran=1<\/script>/u);
  assert.equal(generativeUiPreviewResponse(tokenOf(draft.src)), undefined);
});

test("chunks appended after close are ignored", async () => {
  const draft = openGenerativeUiDraftStream("T", undefined);
  const response = generativeUiPreviewResponse(tokenOf(draft.src));
  draft.append("<p>a</p>");
  draft.close();
  draft.append("<p>late</p>");
  const body = await response!.text();
  assert.match(body, /<p>a<\/p>/u);
  assert.doesNotMatch(body, /late/u);
});

test("static previews keep serving their document until they expire", async () => {
  const src = registerGenerativeUiPreviewDocument("<!DOCTYPE html><p>static</p>");
  const first = generativeUiPreviewResponse(tokenOf(src));
  const second = generativeUiPreviewResponse(tokenOf(src));
  assert.match(await first!.text(), /static/u);
  assert.match(await second!.text(), /static/u);
  assert.match(first!.headers.get("content-security-policy") ?? "", /script-src 'unsafe-inline'/u);
  assert.equal(generativeUiPreviewResponse("c".repeat(64)), undefined);
});
