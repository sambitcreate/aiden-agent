// Inline visuals on a chat hosted by `aiden serve`: which browser draws them,
// what reaches the person's app with and without one, and what Aiden is told.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as api from "../dist/parity-test-api.js";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");

/** An fs where only `files` exist; `executable` lists those with the execute bit. */
function fakeFs(files, executable = files) {
  const asked = [];
  return {
    asked,
    isFile(path) { asked.push(path); return files.includes(path); },
    isExecutable(path) { return executable.includes(path); },
  };
}

test("a server finds a browser only at its fixed install paths, in order", () => {
  const both = fakeFs(["/usr/bin/chromium", "/usr/bin/google-chrome-stable"]);
  assert.deepEqual(api.findServerBrowser({ platform: "linux", isRoot: false, fs: both }), { kind: "found", path: "/usr/bin/google-chrome-stable" });
  assert.deepEqual(api.findServerBrowser({ platform: "linux", isRoot: false, fs: fakeFs(["/usr/bin/chromium"]) }), { kind: "found", path: "/usr/bin/chromium" });
  assert.deepEqual(
    api.findServerBrowser({ platform: "darwin", isRoot: false, fs: fakeFs(["/Applications/Chromium.app/Contents/MacOS/Chromium"]) }),
    { kind: "found", path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
  );
  // Browsers elsewhere (PATH directories, a snap, Playwright's cache, a home folder) are never used.
  const elsewhere = fakeFs(["/usr/local/bin/chromium", "/snap/bin/chromium", "/opt/pw-browsers/chromium/chrome", "/home/me/bin/google-chrome"]);
  assert.deepEqual(api.findServerBrowser({ platform: "linux", isRoot: false, fs: elsewhere }), { kind: "none" });
  assert.ok(elsewhere.asked.every((path) => path.startsWith("/usr/bin/")), "only /usr/bin is looked at on Linux");
  // A file without the execute bit is skipped for the next one.
  assert.deepEqual(
    api.findServerBrowser({ platform: "linux", isRoot: false, fs: fakeFs(["/usr/bin/google-chrome", "/usr/bin/chromium"], ["/usr/bin/chromium"]) }),
    { kind: "found", path: "/usr/bin/chromium" },
  );
  assert.deepEqual(api.findServerBrowser({ platform: "win32", isRoot: false, fs: fakeFs(["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]) }), { kind: "none" });
  // As root the browser would need its sandbox off, so nothing is drawn and nothing is looked up.
  const root = fakeFs(["/usr/bin/chromium"]);
  assert.deepEqual(api.findServerBrowser({ platform: "linux", isRoot: true, fs: root }), { kind: "root" });
  assert.deepEqual(root.asked, []);
});

test("the browser runs headless with its own profile, no network and its sandbox on", () => {
  const args = api.serverBrowserArguments("/tmp/aiden-visual-x", "linux");
  assert.ok(args.includes("--headless=new"));
  assert.ok(args.includes("--user-data-dir=/tmp/aiden-visual-x"));
  assert.ok(args.includes("--proxy-server=http://127.0.0.1:9"), "every connection goes to a closed local port");
  assert.ok(args.includes("--host-resolver-rules=MAP * ~NOTFOUND"), "no host name resolves");
  assert.ok(!args.some((arg) => /no-sandbox|disable-setuid-sandbox|remote-debugging-port/u.test(arg)));
});

/** Registers the artifacts extension against a stand-in for Pi and returns its tools. */
function tools(dir, options) {
  const registered = {};
  api.createArtifactsExtension(dir, options).factory({ on() {}, registerTool(tool) { registered[tool.name] = tool; } });
  return registered;
}
const ctx = { sessionManager: { getSessionId: () => "session-1" } };
const run = async (tool, id, input) => (await tool.execute(id, input, undefined, () => {}, ctx)).content[0].text;
const publicIds = (raw) => ({ raw_ui: "call-1", raw_html: "call-2" })[raw];

const chartMarkup = `<Visual title="Revenue"><Data name="months">[{"month":"Jan","revenue":1200},{"month":"Feb","revenue":1500}]</Data><Chart kind="bar" data={$months} x="month" y="revenue" format="currency" label="By month" /><Checklist items={[{"label":"Ship","done":true},{"label":"Review"}]} /></Visual>`;

test("a native visual reaches a phone as plain text with its chart as lined-up rows, and Aiden is told a paired Mac draws it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aiden-server-visuals-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const visuals = api.createServerVisualCollector();
  const text = await run(tools(dir, { visuals }).render_ui, "raw_ui", { title: "Revenue", markup: chartMarkup, layout: "wide" });
  assert.match(text, /^Shown as text: a phone shows "Revenue" as the text below, not as a drawn visual/u);
  assert.match(text, /a Mac paired to this server draws the visual itself/u);
  // Phones draw the text as-is, so the table has no Markdown pipes and its columns line up.
  assert.match(text, /^month {2}revenue\nJan {4}\$1,200\.00\nFeb {4}\$1,500\.00$/mu);
  assert.doesNotMatch(text, /\|/u);
  assert.match(text, /- \[x\] Ship\n- \[ \] Review/u);
  const fields = visuals.messageFields("chat-1", "message-1", publicIds);
  assert.equal(fields.uiVisuals.length, 1);
  const [visual] = fields.uiVisuals;
  assert.equal(visual.toolCallId, "call-1");
  assert.equal(visual.layout, "wide");
  assert.match(visual.fallbackText, /^Feb {4}\$1,500\.00$/mu);
  assert.equal(fields.attachments, undefined, "no picture is claimed for a native visual");

  // A chat at its visual limit stores nothing, and Aiden is told the person sees nothing.
  const full = api.createServerVisualCollector({ existingUiVisuals: 60 });
  const refused = await run(tools(dir, { visuals: full }).render_ui, "raw_ui", { title: "Revenue", markup: chartMarkup });
  assert.match(refused, /^Not shown: the person cannot see "Revenue", because this reply or chat already has as many visuals as it can hold\./u);
  assert.deepEqual(full.messageFields("chat-1", "message-1", publicIds), {});
});

test("without a browser an HTML visual is not shown, Aiden is told to give the facts as text, and the reply keeps no visual", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aiden-server-visuals-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.AIDEN_CLI_ENTRY; process.env.AIDEN_CLI_ENTRY = join(pkg, "dist/app/cli.js");
  t.after(() => { if (previous === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = previous; });
  let rendered = 0;
  const render = async () => { rendered += 1; return null; };
  for (const [browser, reason] of [[{ kind: "none" }, /no Chrome or Chromium installed/u], [{ kind: "root" }, /runs as root/u]]) {
    const visuals = api.createServerVisualCollector();
    const text = await run(tools(dir, { visuals, findBrowser: () => browser, render }).render_artifact, "raw_html", { title: "Plan", html: "<p>Hello</p>" });
    assert.match(text, /^Not shown: the person cannot see the visual "Plan", because/u);
    assert.match(text, reason);
    assert.match(text, /Give the key facts in your reply as text or a Markdown table\. The HTML is saved at .+\.html\.$/u);
    assert.deepEqual(visuals.messageFields("chat-1", "message-1", publicIds), {});
  }
  assert.equal(rendered, 0);
  // HTML that would load from the network is refused before anything is saved or drawn, as on the desktop.
  await assert.rejects(
    run(tools(dir, { visuals: api.createServerVisualCollector(), findBrowser: () => ({ kind: "found", path: "/usr/bin/chromium" }), render }).render_artifact, "raw_html", { title: "Plan", html: '<img src="https://example.com/pixel.png">' }),
    /cannot load remote images or scripts/u,
  );
  assert.equal(rendered, 0);
  // A browser that draws nothing is reported the same way.
  const failed = api.createServerVisualCollector();
  const text = await run(tools(dir, { visuals: failed, findBrowser: () => ({ kind: "found", path: "/usr/bin/chromium" }), render }).render_artifact, "raw_html", { title: "Plan", html: "<p>Hello</p>" });
  assert.match(text, /^Not shown: .+drawing it failed or took too long/u);
  assert.deepEqual(failed.messageFields("chat-1", "message-1", publicIds), {});
});

test("a drawn HTML visual is kept as the reply's snapshot picture, the way a phone reads a desktop visual", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aiden-server-visuals-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.AIDEN_CLI_ENTRY; process.env.AIDEN_CLI_ENTRY = join(pkg, "dist/app/cli.js");
  t.after(() => { if (previous === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = previous; });
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  let page = "";
  const render = async (options) => { page = options.hostPage; assert.equal(options.width, 1024); return { bytes: png, mimeType: "image/png" }; };
  const visuals = api.createServerVisualCollector();
  const html = `<canvas id="c"></canvas><script>new Chart(document.getElementById("c"), {type:"bar",data:{labels:["a"],datasets:[{data:[1]}]}})</script>`;
  const text = await run(tools(dir, { visuals, findBrowser: () => ({ kind: "found", path: "/usr/bin/chromium" }), render }).render_artifact, "raw_html", { title: "Sales", html, layout: "wide" });
  assert.match(text, /^Shown as an image: the person sees a still picture of the visual "Sales" in the chat\. It was drawn once on this server, so nothing in it moves or responds to taps\./u);
  // The drawn page carries Chart.js inline (the visual names it) but not Plotly, and loads nothing from outside.
  assert.match(page, /Chart\.js v/u);
  assert.doesNotMatch(page, /plotly/iu);
  assert.doesNotMatch(page, /aiden-genui:\/\//u);

  const fields = visuals.messageFields("chat-1", "message-1", publicIds);
  assert.equal(fields.htmlArtifacts.length, 1);
  const [artifact] = fields.htmlArtifacts;
  assert.equal(artifact.title, "Sales");
  assert.deepEqual(fields.htmlArtifactPlacements, [{ mediaId: artifact.mediaId, toolCallId: "call-2", layout: "wide" }]);
  assert.equal(fields.attachments.length, 1);
  assert.equal(fields.attachments[0].kind, "image");
  assert.equal(fields.attachments[0].name, "Sales.png");
  assert.deepEqual(fields.visualSnapshots, [{ visualId: artifact.mediaId, attachmentId: fields.attachments[0].id }]);

  // The phone's projection shows that picture for the visual.
  const now = new Date().toISOString();
  const chat = { id: "chat-1", title: "Chat", workspaceId: "default", createdAt: now, updatedAt: now, messages: [
    { id: "message-1", role: "assistant", content: "Here it is.", createdAt: now, ...fields },
  ] };
  const [message] = api.projectAidenRemoteChat(chat).messages;
  const [visual] = message.visuals;
  assert.equal(visual.kind, "html");
  assert.ok(visual.snapshotAttachmentId, "the phone gets a picture for the visual");
  assert.ok(message.attachments.some((attachment) => attachment.id === visual.snapshotAttachmentId));
});

test("a reply holds no more pictures than one message can carry, and Aiden is told the rest are not shown", async () => {
  const visuals = api.createServerVisualCollector();
  const big = { bytes: Buffer.alloc(9 * 1024 * 1024), mimeType: "image/jpeg" };
  const entry = (n) => ({ toolCallId: `raw_${n}`, image: big, artifact: { version: 1, kind: "html", id: "a".repeat(64), title: `V${n}`, mimeType: "text/html", size: 1, mediaId: `m${n}` } });
  assert.equal(visuals.addHtml(entry(1)), true);
  assert.equal(visuals.canHoldImage(big.bytes.length), false);
  assert.equal(visuals.addHtml(entry(2)), false);
  assert.equal(visuals.messageFields("c", "m", () => undefined).htmlArtifacts.length, 1);
  assert.match(api.htmlVisualResultText("V2", "full", "/x.html"), /^Not shown: .+as many pictures as one message can/u);
});

const browser = api.findServerBrowser({ platform: process.platform, isRoot: process.getuid?.() === 0 });

test("an installed browser draws a chart offline into a picture and leaves no profile behind", { skip: browser.kind !== "found" && "no Chrome or Chromium at a fixed path" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aiden-server-visuals-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.AIDEN_CLI_ENTRY; process.env.AIDEN_CLI_ENTRY = join(pkg, "dist/app/cli.js");
  t.after(() => { if (previous === undefined) delete process.env.AIDEN_CLI_ENTRY; else process.env.AIDEN_CLI_ENTRY = previous; });
  const profiles = () => readdirSync(tmpdir()).filter((name) => name.startsWith("aiden-visual-")).length;
  const before = profiles();
  const visuals = api.createServerVisualCollector();
  const html = `<div style="height:240px"><canvas id="c"></canvas></div><script>new Chart(document.getElementById("c"), {type:"bar",data:{labels:["Q1","Q2"],datasets:[{label:"Sales",data:[3,5]}]},options:{animation:false,maintainAspectRatio:false}})</script>`;
  const started = Date.now();
  const text = await run(tools(dir, { visuals }).render_artifact, "raw_html", { title: "Quarterly sales", html });
  assert.ok(Date.now() - started < 20_000);
  assert.match(text, /^Shown as an image:/u, text);
  const [attachment] = visuals.messageFields("chat-1", "message-1", publicIds).attachments;
  const bytes = Buffer.from(attachment.data, "base64");
  assert.equal(attachment.mimeType, "image/png");
  assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG");
  // Reading column plus padding, at twice the pixel density.
  assert.equal(bytes.readUInt32BE(16), (720 + 32) * 2);
  assert.ok(bytes.readUInt32BE(20) >= (240 + 32) * 2);
  assert.equal(profiles(), before, "the temporary profile is deleted");
});
