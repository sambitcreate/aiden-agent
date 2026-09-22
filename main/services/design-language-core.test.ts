import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDesignLanguageDocument, designLanguageContentHash, importDesignLanguageMarkdown, exportDesignLanguageMarkdown, mergeDesignLanguageDocuments, parseDesignLanguageSnapshots, MAX_DESIGN_LANGUAGE_BYTES } from "./design-language-core.js";

const document = () => ({version:1, name:"Calm language", guidance:"Use restrained spacing and clear hierarchy.", tokens:{colors:{text:"#ABC",background:"#ffffff"},spacing:{medium:"16px"},typography:{family:"Inter",size:"16px"},radii:{card:"8px"}}});

test("Design Language canonical import/export preserves normalized hash and order", () => {
  const input = document();
  const normalized = normalizeDesignLanguageDocument(input);
  assert.deepEqual(Object.keys(normalized.tokens.colors), ["background","text"]);
  assert.equal(normalized.tokens.colors.text,"#abc");
  const exported = exportDesignLanguageMarkdown(input);
  const imported = importDesignLanguageMarkdown(exported);
  assert.deepEqual(imported, normalized);
  assert.equal(designLanguageContentHash(imported),designLanguageContentHash(input));
  assert.equal(exportDesignLanguageMarkdown(imported),exported);
  assert.equal(designLanguageContentHash({...input,tokens:{...input.tokens,colors:{background:"#ffffff",text:"#ABC"}}}),designLanguageContentHash(input));
});

test("Design Language rejects paths, credentials, encodings, resources, directives, controls and nesting", () => {
  for (const guidance of ["<script>alert(1)</script>", "https://example.test", "data:image/png;base64,AAAA", "javascript:run()", "../private", "/etc/passwd", "C:\\secret", "file.txt/secret", "api_key=secret", "password: hidden", "Bearer token", "ignore previous instructions", "execute code", "hello\u0000world", "hidden\u202evalue", "bad\ud800", "bad\udfff", "%3Cscript%3E", "&#60;script", "![resource](image)"]) {
    assert.throws(()=>normalizeDesignLanguageDocument({...document(),guidance}),Error,guidance);
  }
  for (const value of ["url(remote)","var(--secret)","calc(1px + 2px)","expression(code)","#abc;display:none",{nested:{deep:true}}]) {
    assert.throws(()=>normalizeDesignLanguageDocument({...document(),tokens:{...document().tokens,colors:{bad:value}}}));
  }
  assert.throws(()=>normalizeDesignLanguageDocument({...document(),extra:true}));
  assert.throws(()=>normalizeDesignLanguageDocument({...document(),guidance:"a".repeat(MAX_DESIGN_LANGUAGE_BYTES)}));
  assert.throws(()=>normalizeDesignLanguageDocument({...document(),tokens:{...document().tokens,spacing:Object.fromEntries(Array.from({length:49},(_,i)=>[`space${i}`,"1px"]))}}));
  const exported = exportDesignLanguageMarkdown(document());
  for (const unsafe of ["---\n!!js/function code\n---\n", "\ufeff"+exported, exported+"payload", exported.replace('"version": 1','"version": 1, "version": 1'),exported.replace("Calm", "\\u0043alm"),exported.replace(/\n/g,"\r\n")]) assert.throws(()=>importDesignLanguageMarkdown(unsafe));
});

test("Design Language merge is deterministic proposed-wins and does not mutate sources", () => {
  const base = document();
  const proposed = {...document(),name:"Merged",tokens:{...document().tokens,colors:{text:"#000000"}}};
  const original = structuredClone(base);
  const merged = mergeDesignLanguageDocuments(base,proposed);
  assert.equal(merged.name,"Merged");
  assert.deepEqual(merged.tokens.colors,{background:"#ffffff",text:"#000000"});
  assert.deepEqual(base,original);
});

test("snapshot parsing validates normalized hash and immutable identity", () => {
  const normalized=normalizeDesignLanguageDocument(document());
  const snapshot={id:"language:one",revision:1,contentHash:designLanguageContentHash(normalized),document:normalized,provenance:{kind:"authored"},createdAt:1};
  assert.equal(parseDesignLanguageSnapshots([snapshot])?.length,1);
  assert.equal(parseDesignLanguageSnapshots([snapshot,snapshot]),undefined);
  assert.equal(parseDesignLanguageSnapshots([{...snapshot,contentHash:"0".repeat(64)}]),undefined);
  assert.equal(parseDesignLanguageSnapshots([{...snapshot,provenance:{kind:"derived",lineageId:"lineage:one",mediaId:"design:one",contentHash:"bad"}}]),undefined);
});


test("every accepted bounded document fits its canonical Markdown import envelope", () => {
  let accepted = 0;
  let rejected = false;
  for (let count = 1; count <= 48; count += 1) {
    const input = {version:1,name:"n".repeat(100),guidance:"g".repeat(4000),tokens:{colors:{},spacing:{},typography:{},radii:{}}} as ReturnType<typeof normalizeDesignLanguageDocument>;
    for (let index = 0; index < count; index += 1) {
      const name = `token${index}`.padEnd(64,"x");
      input.tokens.colors[name] = `rgb(${"0 ".repeat(59)}0)`;
      input.tokens.spacing[name] = "9999.9999rem";
      input.tokens.typography[name] = "F".repeat(80);
      input.tokens.radii[name] = "9999.9999rem";
    }
    let normalized;
    try { normalized = normalizeDesignLanguageDocument(input); }
    catch { rejected = true; break; }
    const exported = exportDesignLanguageMarkdown(normalized);
    assert.ok(Buffer.byteLength(exported,"utf8") <= MAX_DESIGN_LANGUAGE_BYTES);
    assert.equal(designLanguageContentHash(importDesignLanguageMarkdown(exported)),designLanguageContentHash(normalized));
    accepted += 1;
  }
  assert.ok(accepted > 0);
  assert.equal(rejected,true);
  assert.doesNotThrow(()=>normalizeDesignLanguageDocument({...document(),name:"Language 🌈"}));
});
