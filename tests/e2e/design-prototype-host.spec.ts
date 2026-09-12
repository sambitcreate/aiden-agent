import { test, expect, REPOSITORY_ROOT } from "./fixtures";
import playwright from "@playwright/test";
import type * as PlaywrightModule from "@playwright/test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
const { _electron: electron } = playwright as unknown as typeof PlaywrightModule;

test("prototype real sandbox verifies edges, denies spoofing/network, and navigates exact destinations", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(path.join(tmpdir(), "aiden-prototype-host-"));
  const entry = path.join(directory, "main.cjs");
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end("forbidden"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server.");
  const url = `http://127.0.0.1:${address.port}/forbidden`;
  await build({ stdin: { contents: `import {app,BrowserWindow} from 'electron';import {openPrototypeHost} from ${JSON.stringify(path.join(REPOSITORY_ROOT, "main/services/design-prototype-host.ts"))};app.on('window-all-closed',()=>{});app.whenReady().then(()=>{globalThis.prototypeHost=openPrototypeHost;const anchor=new BrowserWindow({show:false,webPreferences:{sandbox:true}});anchor.loadURL('about:blank')});`, resolveDir: REPOSITORY_ROOT, loader: "ts" }, bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: entry });
  const application = await electron.launch({ args: [entry], env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } });
  try {
    await application.firstWindow();
    const verified = await application.evaluate(async (_electron, target) => {
      const open = (globalThis as unknown as { prototypeHost: (screens: unknown[], edges: unknown[], options: unknown) => Promise<{ passedEdgeIds: string[] }> }).prototypeHost;
      const edge = { id: "next", fromMediaId: "design:a", toMediaId: "design:b", trigger: "click", selector: "#next", transition: "fade" };
      const source = `<button id="next">Next</button><script>fetch(${JSON.stringify(target)}).catch(()=>document.body.dataset.network='denied');window.open(${JSON.stringify(target)});parent.postMessage({cap:'forged',edge:'next'},'*')</script>`;
      const back = { id: 'back', fromMediaId: 'design:b', toMediaId: 'design:a', trigger: 'keydown', key: 'Enter', selector: '#back', transition: 'none' };
      const screens = [{ mediaId: "design:a", html: source }, { mediaId: "design:b", html: '<h1 id="destination">Destination</h1><button id="back">Back</button>' }];
      const evidence = await open(screens, [edge, back], { verify: true });
      await open(screens, [edge, back], { verify: false, entryMediaId: "design:a" });
      return evidence.passedEdgeIds;
    }, url);
    expect(verified).toEqual(["next", "back"]);
    const player = application.windows().find((page) => page.url().startsWith("data:text/html"));
    expect(player).toBeTruthy();
    await expect(player!.frameLocator("iframe").getByRole("button", { name: "Next" })).toBeVisible();
    await expect(player!.locator("iframe")).toHaveCount(1);
    await expect(player!.frameLocator("iframe").locator("body")).toHaveAttribute("data-network", "denied");
    expect(requests).toBe(0);
    await expect.poll(() => application.windows().length).toBe(2);
    await player!.frameLocator("iframe").getByRole("button", { name: "Next" }).click();
    await expect(player!.frameLocator("iframe").getByRole("heading", { name: "Destination" })).toBeVisible();
    await player!.frameLocator("iframe").getByRole("button", { name: "Back" }).press("Enter");
    await expect(player!.frameLocator("iframe").getByRole("button", { name: "Next" })).toBeVisible();
    const rejected = await application.evaluate(async () => {
      const open = (globalThis as unknown as { prototypeHost: (screens: unknown[], edges: unknown[], options: unknown) => Promise<unknown> }).prototypeHost;
      try { await open([{ mediaId: "design:a", html: '<button id="other">Other</button><script>document.querySelectorAll=()=>[document.querySelector("button")]</script>' }], [{ id: "spoof", fromMediaId: "design:a", toMediaId: "design:a", trigger: "click", selector: "#missing", transition: "none" }], { verify: true }); return false; } catch { return true; }
    });
    expect(rejected).toBe(true);
    const inaccessible = await application.evaluate(async () => {
      const open = (globalThis as unknown as { prototypeHost: (screens: unknown[], edges: unknown[], options: unknown) => Promise<unknown> }).prototypeHost;
      const cases = [{ html: '<button id="next" style="pointer-events:none">Next</button>', trigger: 'click' }, { html: '<input id="next" aria-label="Name" readonly>', trigger: 'change' }, { html: '<button id="next">Next</button><div style="position:fixed;inset:0">Cover</div>', trigger: 'click' }];
      const rejected = [];
      for (const item of cases) { try { await open([{mediaId:'design:a',html:item.html}], [{id:'edge',fromMediaId:'design:a',toMediaId:'design:a',trigger:item.trigger,selector:'#next',transition:'none'}], {verify:true}); rejected.push(false); } catch { rejected.push(true); } }
      return rejected;
    });
    expect(inaccessible).toEqual([true, true, true]);
    const formEvidence = await application.evaluate(async () => {
      const open = (globalThis as unknown as { prototypeHost: (screens: unknown[], edges: unknown[], options: unknown) => Promise<{passedEdgeIds:string[]}> }).prototypeHost;
      return (await open([{mediaId:'design:form',html:'<form id="form" aria-label="Checkout"><button type="button">Cancel</button><button type="reset">Reset</button><button type="submit">Continue</button></form><input id="name" aria-label="Name"><button>Blur</button>'},{mediaId:'design:done',html:'<h1>Done</h1>'}], [{id:'submit',fromMediaId:'design:form',toMediaId:'design:done',trigger:'submit',selector:'#form',transition:'none'},{id:'change',fromMediaId:'design:form',toMediaId:'design:done',trigger:'change',selector:'#name',transition:'none'}], {verify:true})).passedEdgeIds;
    });
    expect(formEvidence).toEqual(['submit','change']);
    await application.evaluate(async () => {
      const open = (globalThis as unknown as { prototypeHost: (screens: unknown[], edges: unknown[], options: unknown) => Promise<unknown> }).prototypeHost;
      await open([{mediaId:'design:form',html:'<form id="form"><button type="button">Cancel</button><button type="reset">Reset</button><button type="submit">Continue</button></form>'},{mediaId:'design:done',html:'<h1>Submitted</h1>'}], [{id:'submit',fromMediaId:'design:form',toMediaId:'design:done',trigger:'submit',selector:'#form',transition:'none'}], {verify:false,entryMediaId:'design:form'});
    });
    const formPlayer = application.windows().filter(page => page.url().startsWith('data:text/html') && page !== player).slice(-1)[0]!;
    await formPlayer.frameLocator('iframe').getByRole('button',{name:'Cancel'}).press('Enter');
    await formPlayer.waitForTimeout(200);
    await expect(formPlayer.frameLocator('iframe').getByRole('button',{name:'Continue'})).toBeVisible();
    await formPlayer.frameLocator('iframe').getByRole('button',{name:'Reset'}).press('Enter');
    await formPlayer.waitForTimeout(200);
    await expect(formPlayer.frameLocator('iframe').getByRole('button',{name:'Continue'})).toBeVisible();
    await formPlayer.frameLocator('iframe').getByRole('button',{name:'Continue'}).press('Enter');
    await expect(formPlayer.frameLocator('iframe').getByRole('heading',{name:'Submitted'})).toBeVisible();
    await formPlayer.close();
    const hung = await application.evaluate(async () => {
      const open = (globalThis as unknown as { prototypeHost: (screens: unknown[], edges: unknown[], options: unknown) => Promise<unknown> }).prototypeHost;
      const started = Date.now();
      try { await open([{mediaId:'design:a',html:'<script>while(true){}</script>'}], [], {verify:true}); return {rejected:false,elapsed:Date.now()-started}; } catch { return {rejected:true,elapsed:Date.now()-started}; }
    });
    expect(hung.rejected).toBe(true);
    expect(hung.elapsed).toBeLessThan(8_000);
    await expect.poll(() => application.windows().length).toBe(2);
  } finally { await application.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
