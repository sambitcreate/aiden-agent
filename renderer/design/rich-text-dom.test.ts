// Reading a note editor's contents back as Markdown: the shapes Chromium's
// contenteditable makes while a person types, formats and pastes.

import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { richTextHtml, serializeRichText } from "../shared/design-canvas/rich-text";
import { readRichDom } from "./rich-text-dom";

function editor(html: string): Element {
  const window = new Window();
  const root = window.document.createElement("div");
  root.innerHTML = html;
  return root as unknown as Element;
}

const read = (html: string) => serializeRichText(readRichDom(editor(html)));

test("what an editor starts from reads back as the same Markdown", () => {
  for (const source of [
    "Plain",
    "**Bold**, *italic* and <u>underlined</u> words",
    "A [link](https://example.com/a) here",
    "Heading\n\n- one\n- two\n1. first\n2. second",
    "Tricky \\*stars\\* and \\<u\\> \\[brackets\\]",
  ]) {
    assert.equal(read(richTextHtml(source)), source);
  }
});

test("typing lines: text straight in the editor, then a div for each Enter", () => {
  assert.equal(read("first<div>second</div><div><br></div><div>fourth</div>"), "first\nsecond\n\nfourth");
  assert.equal(read("one<br>two<br>"), "one\ntwo");
  assert.equal(read("<div>a<br></div><div>b</div>"), "a\nb");
  assert.equal(read("<br>"), "");
});

test("bold, italic and underline from tags or from styles, and spaces Chromium keeps as nbsp", () => {
  assert.equal(read("<div><strong>s</strong> <em>e</em> <span style=\"font-weight: 700\">w</span></div>"), "**s** *e* **w**");
  assert.equal(read('<div><span style="font-style: italic; text-decoration: underline">x</span></div>'), "*<u>x</u>*");
  assert.equal(read("<div>a\u00a0\u00a0b</div>"), "a  b");
});

test("links keep only safe addresses, and pasted markup keeps only what notes can hold", () => {
  assert.equal(read('<a href="https://example.com/">ok</a> <a href="javascript:alert(1)">bad</a>'), "[ok](https://example.com/) bad");
  assert.equal(
    read('<h1>Title</h1><p>Body <code>x</code><script>alert(1)</script></p><img src="x">'),
    "Title\nBody x",
  );
});

test("lists, including nested ones, become flat bullets or numbers", () => {
  assert.equal(read("<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul><ol><li>one</li></ol>"), "- a\n- b\n- c\n1. one");
  assert.equal(read("<ul><li><b>bold</b> item</li></ul>after"), "- **bold** item\nafter");
});
