import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_DISCOVERY_LIMITS, browserAssetReferences } from "./asset-discovery.js";

test("HTML parsing follows actual static resources and decodes attributes without granting document links", () => {
  const result = browserAssetReferences(`<!doctype html><base href="./assets/">
    <!-- <script src="comment.js"></script> -->
    <link href="theme.css?x=1&amp;y=2" rel="stylesheet"><link href="app.mjs" rel="modulepreload">
    <script src="app.js"></script><img src="one.png" srcset="two.png 2x, data:image/png;base64,AAAA 1x, three.png 3x">
    <source srcset="four.webp 1x"><video poster="poster.png"></video>
    <a href="private.html">Other</a><iframe src="private.html"></iframe><object data="private.pdf"></object>
    <template><img src="inert.png"></template><script>const text='<img src="fake.png">';fetch('private.svg');</script>
    <style>@import "inline.css";body{background:url('background.png')}</style>
    <div style="background:url('inline.png')"></div><script type="module">import './inline.mjs';</script>`, "html");
  assert.equal(result.baseHref, "./assets/");
  assert.deepEqual(result.urls, ["theme.css?x=1&y=2", "app.mjs", "app.js", "one.png", "two.png", "data:image/png;base64,AAAA", "three.png", "four.webp", "poster.png", "background.png", "inline.css", "inline.png", "./inline.mjs"]);
  assert.equal(result.incomplete, false);
});

test("CSS tokens support imports, escaped URLs, fonts and image sets but ignore ordinary strings", () => {
  const result = browserAssetReferences(`/*url(comment.png)*/ @import url("nested.css") layer(theme);@import 'print.css' print;
    @font-face{src:url(font.woff2) format('woff2')}body{background:image-set('one.png' 1x,url(two.png) 2x);content:'url(fake.png)';--icon:url(icon\\20 name.svg)}`, "css");
  assert.deepEqual(new Set(result.urls), new Set(["nested.css", "print.css", "font.woff2", "one.png", "two.png", "icon name.svg"]));
  assert.equal(result.incomplete, false);
});

test("module parser discovers literal imports and reexports without executing source or inferring dynamic paths", () => {
  const result = browserAssetReferences(`import './one.js';import {x} from './two.js';export {x} from '/root.js';export * from './three.js';
    async function load(){ await import('./chunk.js');await import('./' + computed); }
    const string="import './fake.js'"; fetch('./private.svg');import 'package';`, "module");
  assert.deepEqual(new Set(result.urls), new Set(["./one.js", "./two.js", "/root.js", "./three.js", "./chunk.js"]));
  assert.equal(result.incomplete, false);
});

test("parse failures and reference overflow remain explicit and bounded", () => {
  assert.equal(browserAssetReferences("import {", "module").incomplete, true);
  assert.equal(browserAssetReferences("a{", "css").incomplete, true);
  const result = browserAssetReferences(Array.from({ length: 600 }, (_, index) => `<img src="${index}.png">`).join(""), "html");
  assert.equal(result.urls.length, BROWSER_DISCOVERY_LIMITS.references);
  assert.equal(result.incomplete, true);
});
