import playwrightTest from "@playwright/test";
import type * as PlaywrightTestModule from "@playwright/test";
const { test, expect } = playwrightTest as unknown as typeof PlaywrightTestModule;
import { build } from "esbuild";
import path from "node:path";

test("Design scrubbing coalesces requests and reuses only reauthorized identical content", async ({ page }) => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {useDesignPreview} from './renderer/lib/use-design-preview';
    import {chatsApi} from './renderer/lib/ipc';
    window.calls=[]; window.pending={};
    chatsApi.htmlArtifactSrcdoc=async(chat,id)=>{window.calls.push([chat,id]);
      if(id==='missing') return undefined;
      if(id==='late') return new Promise(resolve=>window.pending.late=resolve);
      return {src:'about:blank#'+chat+'-'+id,contentHash:id==='changed'?'different':'same',designCapability:id};};
    let chat='one', id='first'; const root=createRoot(document.getElementById('root'));
    function App(){const {preview,ready,error}=useDesignPreview(chat,id,id);
      return <div><output>{ready?'ready':error||'loading'}</output>{preview?<iframe src={preview.src}/>:null}</div>}
    window.choose=(next,nextChat='one')=>{id=next;chat=nextChat;render()};function render(){root.render(<App/>)}render();
  `, resolveDir: path.resolve(import.meta.dirname, "../.."), loader: "tsx" }, bundle: true, format: "iife", platform: "browser", write: false, define: { "process.env.NODE_ENV": '"test"' } });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  await expect(page.locator("output")).toHaveText("ready");
  await page.evaluate(() => { (window as any).original = document.querySelector("iframe"); });
  await page.evaluate(() => (window as any).choose("second"));
  await expect(page.locator("output")).toHaveText("loading");
  await page.evaluate(() => (window as any).choose("third"));
  await expect(page.locator("output")).toHaveText("ready");
  expect(await page.evaluate(() => (window as any).calls)).toEqual([["one", "first"], ["one", "third"]]);
  expect(await page.evaluate(() => document.querySelector("iframe") === (window as any).original)).toBe(true);
  await expect(page.locator("iframe")).toHaveAttribute("src", "about:blank#one-first");
  await page.evaluate(() => (window as any).choose("changed"));
  await expect(page.locator("iframe")).toHaveAttribute("src", "about:blank#one-changed");
  await page.evaluate(() => (window as any).choose("late"));
  await expect.poll(() => page.evaluate(() => Boolean((window as any).pending.late))).toBe(true);
  await page.evaluate(() => (window as any).choose("third", "two"));
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveAttribute("src", "about:blank#two-third");
  await page.evaluate(() => (window as any).pending.late({src:"about:blank#stale",contentHash:"same"}));
  await expect(page.locator("iframe")).toHaveAttribute("src", "about:blank#two-third");
  await page.evaluate(() => (window as any).choose("missing", "two"));
  await expect(page.locator("output")).toHaveText("This design version is no longer available.");
  await expect(page.locator("iframe")).toHaveCount(0);
});
