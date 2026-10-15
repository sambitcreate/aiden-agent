import assert from "node:assert/strict";
import test from "node:test";
import {
  highlightCode,
  highlightLanguagesVersion,
  loadHighlightLanguage,
  resolveHighlightLanguage,
  subscribeHighlightLanguages,
} from "./syntax-highlight.js";

test("common fence labels resolve to a supported grammar", () => {
  assert.equal(resolveHighlightLanguage("TSX"), "typescript");
  assert.equal(resolveHighlightLanguage(" sh "), "bash");
  assert.equal(resolveHighlightLanguage("html"), "xml");
  assert.equal(resolveHighlightLanguage("c++"), "cpp");
  assert.equal(resolveHighlightLanguage("python"), "python");
});

test("unlabeled and unknown fences stay plain text", async () => {
  assert.equal(resolveHighlightLanguage(undefined), undefined);
  assert.equal(resolveHighlightLanguage(""), undefined);
  assert.equal(resolveHighlightLanguage("brainfuck"), undefined);
  assert.equal(resolveHighlightLanguage("__proto__"), undefined);
  assert.equal(await loadHighlightLanguage("brainfuck"), false);
  assert.equal(highlightCode("+++[>+<-]", "brainfuck"), null);
});

test("a grammar highlights only after it loads and notifies subscribers once", async () => {
  const code = "const answer: number = 42;";
  assert.equal(highlightCode(code, "ts"), null, "not highlighted before the grammar loads");

  let notifications = 0;
  const unsubscribe = subscribeHighlightLanguages(() => {
    notifications += 1;
  });
  const before = highlightLanguagesVersion();
  const [first, second] = await Promise.all([
    loadHighlightLanguage("ts"),
    loadHighlightLanguage("typescript"),
  ]);
  unsubscribe();

  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(notifications, 1, "concurrent loads of one grammar share a single registration");
  assert.ok(highlightLanguagesVersion() > before);

  const html = highlightCode(code, "tsx");
  assert.ok(html, "highlighted after load");
  assert.match(html, /<span class="hljs-keyword">const<\/span>/u);
  assert.match(html, /<span class="hljs-number">42<\/span>/u);
});

test("highlighted output escapes markup in the source", async () => {
  assert.equal(await loadHighlightLanguage("html"), true);
  const html = highlightCode("<script>alert(1)</script>", "html");
  assert.ok(html);
  assert.doesNotMatch(html, /<script>/u);
  assert.match(html, /&lt;/u);
});

test("embedded grammars load with their host so HTML highlights inline scripts", async () => {
  assert.equal(await loadHighlightLanguage("xml"), true);
  const html = highlightCode("<script>const x = 1;</script>", "xml");
  assert.ok(html);
  assert.match(html, /<span class="hljs-keyword">const<\/span>/u);
});
