import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { request as httpRequest } from "node:http";
import { BROWSER_PREVIEW_AUTH_HEADER, BrowserFileService, browserPreviewRequestHeaders, type BrowserFileWorkspace } from "./files.js";

async function fixture(beforeRead?: () => Promise<void>) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-browser-files-"));
  const root = path.join(folder, "workspace");
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.mkdir(path.join(root, "assets"));
  await fs.writeFile(
    path.join(root, "docs", "index.html"),
    '<!doctype html><link href="style.css" rel="stylesheet"><script src="/assets/app.js"></script><p>Preview</p>',
  );
  await fs.writeFile(
    path.join(root, "docs", "style.css"),
    'body{background:url("/assets/icon.svg")}',
  );
  await fs.writeFile(path.join(root, "assets", "app.js"), "globalThis.ready = true;");
  await fs.writeFile(
    path.join(root, "assets", "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  await fs.writeFile(path.join(root, "report.pdf"), "%PDF-1.7\nfixture document");
  let workspace: BrowserFileWorkspace | undefined = {
    id: "workspace",
    folderPath: root,
    permission: "full",
  };
  const service = new BrowserFileService({
    getWorkspace: async (id) => (id === "workspace" ? workspace : undefined),
    beforeRead,
  });
  return {
    folder,
    root,
    service,
    open: async (...args: Parameters<BrowserFileService["open"]>) =>
      (await service.open(...args)).url,
    setWorkspace(value: BrowserFileWorkspace | undefined) {
      workspace = value;
    },
    async close() {
      await service.shutdown();
      await fs.rm(folder, { recursive: true, force: true });
    },
  };
}

function raw(
  url: string,
  options: {
    path?: string;
    method?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{
  status: number;
  body: string;
  headers: import("node:http").IncomingHttpHeaders;
}> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: options.path ?? `${parsed.pathname}${parsed.search}`,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: response.headers,
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
}
function authorization(url: string): Record<string, string> {
  const token = new URL(url).searchParams.get("__aiden_preview");
  assert.ok(token);
  return { [BROWSER_PREVIEW_AUTH_HEADER]: token };
}

test("serves HTML unchanged with explicitly declared relative and root-relative assets", async () => {
  const f = await fixture();
  try {
    const url = await f.open("workspace", "docs/index.html", {
      assetPaths: ["style.css", "../assets/app.js", "../assets/icon.svg"],
    });
    assert.equal(f.service.isPreviewUrl(url), true);
    assert.equal(f.service.isPreviewUrl(new URL("/report.pdf", url).href), true);
    assert.equal(f.service.isPreviewUrl("http://127.0.0.1:1/report.pdf"), false);
    assert.equal(f.service.isPreviewUrl("invalid"), false);
    const initial = await raw(url);
    assert.equal(initial.status, 200);
    assert.equal(initial.body, await fs.readFile(path.join(f.root, "docs/index.html"), "utf8"));
    assert.match(initial.headers["content-type"]!, /text\/html/);
    const headers = {
      ...authorization(url),
      "Sec-Fetch-Site": "same-origin",
    };
    assert.equal(
      (await raw(new URL("style.css", url).href, { headers })).body,
      'body{background:url("/assets/icon.svg")}',
    );
    assert.equal(
      (await raw(new URL("/assets/app.js", url).href, { headers })).body,
      "globalThis.ready = true;",
    );
    assert.match((await raw(new URL("/assets/icon.svg", url).href, { headers })).body, /<svg/);
    assert.equal(initial.headers["cache-control"], "no-store");
    assert.equal(initial.headers["referrer-policy"], "no-referrer");
    assert.equal(initial.headers["access-control-allow-origin"], undefined);
    assert.equal(initial.headers["set-cookie"], undefined);
    assert.equal(initial.headers["cross-origin-resource-policy"], "same-origin");
    await f.service.closeForWorkspace("workspace");
    assert.equal(f.service.isPreviewUrl(new URL("/report.pdf", url).href), true);
  } finally {
    await f.close();
  }
});

test("workspace previews implicitly authorize only the entry and declared assets, never siblings", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, "payroll.js"), "confidential payroll data");
    await fs.writeFile(path.join(f.root, "docs", "other.html"), "private sibling document");
    const prepared = await f.service.prepare("workspace", "docs/index.html", {
      assetPaths: ["style.css"],
    });
    assert.equal(prepared.requiresApproval, false);
    const reservation = await f.service.open("workspace", "docs/index.html", {
      preparedFile: prepared,
      assetPaths: ["style.css"],
    });
    const headers = { ...authorization(reservation.url), "Sec-Fetch-Site": "same-origin" };
    assert.equal((await raw(new URL("style.css", reservation.url).href, { headers })).status, 200);
    for (const route of [
      "/payroll.js",
      "/docs/other.html",
      "/report.pdf",
      "/assets/app.js",
      "/assets/icon.svg",
    ]) {
      const result = await raw(new URL(route, reservation.url).href, { headers });
      assert.equal(result.status, 404, route);
      assert.doesNotMatch(result.body, /confidential payroll|private sibling/);
    }
    reservation.release();
    f.setWorkspace({ id: "workspace", folderPath: f.root, permission: "ask" });
    const ask = await f.service.prepare("workspace", "docs/index.html", {
      assetPaths: ["style.css"],
    });
    assert.equal(ask.requiresApproval, false);
    const askReservation = await f.service.open("workspace", "docs/index.html", {
      preparedFile: ask,
      assetPaths: ["style.css"],
    });
    assert.equal((await raw(askReservation.url)).status, 200);
    askReservation.release();
  } finally {
    await f.close();
  }
});

test("a second workspace document or expanded asset grant cannot widen an earlier origin", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, "docs", "second.html"), "second document");
    const first = await f.open("workspace", "docs/index.html", { assetPaths: ["style.css"] });
    const firstHeaders = authorization(first);
    const second = await f.open("workspace", "docs/second.html", {
      assetPaths: ["../assets/app.js"],
    });
    const secondHeaders = authorization(second);
    assert.notEqual(new URL(first).origin, new URL(second).origin);
    assert.equal(
      (await raw(new URL("/assets/app.js", second).href, { headers: secondHeaders })).status,
      200,
    );
    assert.equal(
      (await raw(new URL("/docs/second.html", first).href, { headers: firstHeaders })).status,
      404,
    );
    assert.equal(
      (await raw(new URL("/assets/app.js", first).href, { headers: firstHeaders })).status,
      404,
    );
    assert.equal(
      (await raw(new URL("/docs/index.html", second).href, { headers: secondHeaders })).status,
      404,
    );
    const expanded = await f.open("workspace", "docs/index.html", {
      assetPaths: ["style.css", "../assets/app.js"],
    });
    assert.notEqual(new URL(first).origin, new URL(expanded).origin);
    assert.equal(
      (await raw(new URL("/assets/app.js", first).href, { headers: firstHeaders })).status,
      404,
    );
    const repeated = await f.open("workspace", "docs/index.html", { assetPaths: ["style.css"] });
    assert.equal(new URL(repeated).origin, new URL(first).origin);
  } finally {
    await f.close();
  }
});

test("an outside asset added to a workspace document requires exact approval", async () => {
  const f = await fixture();
  try {
    const outsideAsset = path.join(f.folder, "outside.css");
    await fs.writeFile(outsideAsset, "p{color:blue}");
    const prepared = await f.service.prepare("workspace", "docs/index.html", {
      assetPaths: [outsideAsset],
    });
    assert.equal(prepared.requiresApproval, true);
    await assert.rejects(
      f.service.open("workspace", "docs/index.html", {
        preparedFile: prepared,
        assetPaths: [outsideAsset],
      }),
      /needs approval/,
    );
    f.service.approve(prepared);
    const opened = await f.service.open("workspace", "docs/index.html", {
      preparedFile: prepared,
      assetPaths: [outsideAsset],
    });
    const headers = authorization(opened.url);
    assert.equal(
      (await raw(new URL("../../outside.css", opened.url).href, { headers })).body,
      "p{color:blue}",
    );
    assert.equal(
      (await raw(new URL("/workspace/assets/app.js", opened.url).href, { headers })).status,
      404,
    );
    opened.release();
  } finally {
    await f.close();
  }
});

test("workspace entry and asset identities stay pinned after preparation", async () => {
  const f = await fixture();
  try {
    const prepared = await f.service.prepare("workspace", "docs/index.html", {
      assetPaths: ["style.css"],
    });
    const opened = await f.service.open("workspace", "docs/index.html", {
      preparedFile: prepared,
      assetPaths: ["style.css"],
    });
    const headers = authorization(opened.url);
    const asset = path.join(f.root, "docs/style.css");
    await fs.rename(asset, `${asset}.original`);
    await fs.writeFile(asset, "replacement must not be served");
    const denied = await raw(new URL("style.css", opened.url).href, { headers });
    assert.equal(denied.status, 409);
    assert.doesNotMatch(denied.body, /replacement must not be served/);
    const entry = path.join(f.root, "docs/index.html");
    await fs.rename(entry, `${entry}.original`);
    await fs.writeFile(entry, "replacement entry must not be served");
    await assert.rejects(
      f.service.open("workspace", "docs/index.html", {
        preparedFile: prepared,
        assetPaths: ["style.css"],
      }),
      /identity changed/,
    );
    opened.release();
  } finally {
    await f.close();
  }
});

test("PDF supports bounded byte ranges and HEAD without exposing other file types", async () => {
  const f = await fixture();
  try {
    const url = await f.open("workspace", path.join(f.root, "report.pdf"));
    const first = await raw(url, { headers: { Range: "bytes=0-7" } });
    assert.equal(first.status, 206);
    assert.equal(first.body, "%PDF-1.7");
    assert.equal(first.headers["content-type"], "application/pdf");
    assert.match(first.headers["content-range"]!, /^bytes 0-7\//);
    const head = await raw(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    assert.equal(
      Number(head.headers["content-length"]),
      (await fs.stat(path.join(f.root, "report.pdf"))).size,
    );
    assert.equal((await raw(url, { headers: { Range: "bytes=99999-" } })).status, 416);
    assert.equal((await raw(url, { headers: { Range: "bytes=0-1,3-4" } })).status, 416);
    assert.equal((await raw(url, { headers: { Range: "bytes=-8" } })).body, "document");
  } finally {
    await f.close();
  }
});

test("rejects missing/tampered capabilities, hostile hosts, cross-origin fetches and writes", async () => {
  const f = await fixture();
  try {
    const url = await f.open("workspace", "docs/index.html");
    const headers = authorization(url);
    const plain = new URL(url);
    plain.search = "";
    assert.equal((await raw(plain.href)).status, 403);
    assert.equal((await raw(plain.href, { headers: { Cookie: `aiden_preview_old=${new URL(url).searchParams.get("__aiden_preview")}` } })).status, 403);
    assert.equal((await raw(`${plain.href}?__aiden_preview=wrong`, { headers })).status, 403);
    assert.equal((await raw(url, { headers: { Host: "evil.example" } })).status, 403);
    assert.equal((await raw(url, { headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal(
      (
        await raw(plain.href, {
          headers: { ...headers, "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await raw(plain.href, {
          headers: { ...headers, "Sec-Fetch-Site": "same-site" },
        })
      ).status,
      403,
    );
    assert.equal((await raw(url, { method: "POST" })).status, 405);
    assert.equal((await raw(url, { method: "OPTIONS" })).status, 405);
  } finally {
    await f.close();
  }
});

test("native request authorization requires an active exact grant and the committed frame origin", async () => {
  const f = await fixture();
  try {
    const opened = await f.service.open("workspace", "docs/index.html", { assetPaths: ["style.css"] });
    const parsed = new URL(opened.url);
    const token = parsed.searchParams.get("__aiden_preview");
    const asset = new URL("style.css", opened.url).href;
    assert.equal(f.service.authorizationForRequest("workspace", asset, parsed.origin), token);
    for (const [workspace, target, initiator] of [
      ["another-workspace", asset, parsed.origin],
      ["workspace", new URL("/assets/app.js", opened.url).href, parsed.origin],
      ["workspace", asset, "https://attacker.example"],
      ["workspace", asset, "http://127.0.0.1:1"],
      ["workspace", asset, "null"],
      ["workspace", asset, ""],
      ["workspace", "http://127.0.0.1:1/collect", parsed.origin],
    ]) assert.equal(f.service.authorizationForRequest(workspace!, target!, initiator!), undefined);
    assert.equal(f.service.redactText(`${BROWSER_PREVIEW_AUTH_HEADER}: ${token}`), `${BROWSER_PREVIEW_AUTH_HEADER}: [private-preview]`);
    opened.release();
    assert.equal(f.service.authorizationForRequest("workspace", asset, parsed.origin), undefined);
  } finally { await f.close(); }
});

test("every outbound request strips supplied internal authorization and legacy preview cookies", () => {
  const supplied = {
    [BROWSER_PREVIEW_AUTH_HEADER]: "old-preview-token",
    [BROWSER_PREVIEW_AUTH_HEADER.toLowerCase()]: "spoofed-preview-token",
    Cookie: "site_session=keep; aiden_preview_old=secret; aiden_preview_other=other; preference=light",
    Authorization: "Bearer ordinary-site-auth",
  };
  const publicHeaders = browserPreviewRequestHeaders(supplied);
  assert.deepEqual(publicHeaders, { Cookie: "site_session=keep; preference=light", Authorization: "Bearer ordinary-site-auth" });
  const previewHeaders = browserPreviewRequestHeaders(supplied, "current-exact-grant");
  assert.equal(previewHeaders[BROWSER_PREVIEW_AUTH_HEADER], "current-exact-grant");
  assert.deepEqual(browserPreviewRequestHeaders(previewHeaders), publicHeaders, "redirects and unowned requests lose the grant");
  assert.deepEqual(browserPreviewRequestHeaders({ cookie: "aiden_preview_old=secret" }), {});
  assert.equal(supplied[BROWSER_PREVIEW_AUTH_HEADER], "old-preview-token");
});

test("blocks traversal, dotfiles, directories, secrets and unsupported assets", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.folder, "outside.html"), "outside");
    await fs.writeFile(path.join(f.root, ".env"), "secret");
    await fs.writeFile(path.join(f.root, "credentials.js"), "secret");
    await fs.writeFile(path.join(f.root, "data.json"), "{}");
    const url = await f.open("workspace", "docs/index.html");
    const headers = authorization(url);
    for (const requestPath of [
      "/../outside.html",
      "/%2e%2e/outside.html",
      "/docs/%2e%2e/%2e%2e/outside.html",
      "/docs%2f../outside.html",
      "/.env",
      "/%2eenv",
      "/credentials.js",
      "/data.json",
      "/",
      "/docs/",
      "/docs\\index.html",
      "/docs/%00.html",
    ]) {
      assert.equal((await raw(url, { path: requestPath, headers })).status, 404, requestPath);
    }
    await assert.rejects(f.open("workspace", "../outside.html"));
    await assert.rejects(f.open("workspace", ".env"));
    await assert.rejects(f.open("workspace", "assets/app.js"));
  } finally {
    await f.close();
  }
});

test("blocks external and disguised symlinks but permits assets linked inside the approved root", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.folder, "outside.html"), "outside");
    await fs.writeFile(path.join(f.root, ".secret.html"), "secret");
    await fs.symlink(path.join(f.folder, "outside.html"), path.join(f.root, "escaped.html"));
    await fs.symlink(path.join(f.root, ".secret.html"), path.join(f.root, "disguised.html"));
    await fs.symlink(path.join(f.root, "docs", "index.html"), path.join(f.root, "linked.html"));
    await assert.rejects(f.open("workspace", "escaped.html"));
    await assert.rejects(f.open("workspace", "disguised.html"));
    assert.equal((await raw(await f.open("workspace", "linked.html"))).status, 200);
  } finally {
    await f.close();
  }
});

test("rechecks workspace permissions/removal and does not resurrect a revoked capability", async () => {
  const f = await fixture();
  try {
    const url = await f.open("workspace", "docs/index.html");
    f.setWorkspace({ id: "workspace", folderPath: f.root, permission: "none" });
    assert.equal((await raw(url)).status, 403);
    f.setWorkspace({ id: "workspace", folderPath: f.root, permission: "full" });
    await assert.rejects(raw(url));
    const reopened = await f.open("workspace", "docs/index.html");
    assert.notEqual(reopened, url);
    assert.equal((await raw(reopened)).status, 200);
    f.setWorkspace(undefined);
    assert.equal((await raw(reopened)).status, 403);
  } finally {
    await f.close();
  }
});

test("external documents need authentic exact-file approval and expose only declared assets", async () => {
  const f = await fixture();
  try {
    const entry = path.join(f.folder, "sample.html");
    await fs.writeFile(entry, '<link rel="stylesheet" href="sample.css"><p>Temporary preview</p>');
    await fs.writeFile(path.join(f.folder, "sample.css"), "p{color:red}");
    await fs.writeFile(path.join(f.folder, "unapproved.js"), "privateContent");
    const prepared = await f.service.prepare("workspace", entry, { assetPaths: ["sample.css"] });
    assert.equal(prepared.requiresApproval, true);
    await assert.rejects(
      f.service.open("workspace", entry, { preparedFile: prepared, assetPaths: ["sample.css"] }),
      /needs approval/,
    );
    assert.throws(() => f.service.approve({ ...prepared }), /not authentic/);
    f.service.approve(prepared);
    await assert.rejects(
      f.service.open("workspace", entry, { preparedFile: prepared, assetPaths: [] }),
      /exact request/,
    );
    const reservation = await f.service.open("workspace", entry, {
      preparedFile: prepared,
      assetPaths: ["sample.css"],
    });
    const initial = await raw(reservation.url);
    assert.equal(initial.status, 200);
    const headers = authorization(reservation.url);
    assert.equal(
      (await raw(new URL("sample.css", reservation.url).href, { headers })).body,
      "p{color:red}",
    );
    assert.equal(
      (await raw(new URL("unapproved.js", reservation.url).href, { headers })).status,
      404,
    );
    f.service.commitConsumer("workspace", "tab-one", reservation.url);
    reservation.release();
    f.service.releaseConsumer("tab-one");
    await assert.rejects(raw(reservation.url));
    assert.match(await fs.readFile(entry, "utf8"), /Temporary preview/);
  } finally {
    await f.close();
  }
});

test("approved file identity is pinned across approval and symlink replacement", async () => {
  const f = await fixture();
  try {
    const entry = path.join(f.folder, "sample.html");
    await fs.writeFile(entry, "original");
    const prepared = await f.service.prepare("workspace", entry);
    f.service.approve(prepared);
    await fs.rename(entry, `${entry}.original`);
    await fs.writeFile(entry, "replacement must not leak");
    await assert.rejects(
      f.service.open("workspace", entry, { preparedFile: prepared }),
      /identity changed/,
    );
    const next = await f.service.prepare("workspace", entry);
    f.service.approve(next);
    const opened = await f.service.open("workspace", entry, { preparedFile: next });
    await fs.unlink(entry);
    await fs.symlink(path.join(f.root, "docs/index.html"), entry);
    const denied = await raw(opened.url);
    assert.notEqual(denied.status, 200);
    assert.doesNotMatch(denied.body, /replacement must not leak|Preview/);
    opened.release();
  } finally {
    await f.close();
  }
});

test("multiple tabs and pending navigation retain a preview until its final consumer leaves", async () => {
  const f = await fixture();
  try {
    const first = await f.service.open("workspace", "docs/index.html");
    f.service.commitConsumer("workspace", "tab-one", first.url);
    first.release();
    const second = f.service.reserveUrl("workspace", first.url)!;
    f.service.releaseConsumer("tab-one");
    assert.equal((await raw(second.url)).status, 200);
    f.service.commitConsumer("workspace", "tab-two", second.url);
    second.release();
    assert.equal((await raw(second.url)).status, 200);
    f.service.commitConsumer("workspace", "tab-two", "https://example.com/");
    await assert.rejects(raw(second.url));
    assert.throws(() => f.service.reserveUrl("workspace", second.url), /expired/);
  } finally {
    await f.close();
  }
});

test("a queued acquisition reserves its shared listener before asynchronous revalidation", async () => {
  const f = await fixture();
  let pause = false;
  let entered!: () => void;
  let resume!: () => void;
  const checking = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const service = new BrowserFileService({
    getWorkspace: async () => {
      if (pause) {
        entered();
        await gate;
      }
      return { id: "workspace", folderPath: f.root, permission: "full" };
    },
  });
  try {
    const prepared = await service.prepare("workspace", "docs/index.html");
    const first = await service.open("workspace", "docs/index.html", { preparedFile: prepared });
    service.commitConsumer("workspace", "first", first.url);
    first.release();
    pause = true;
    const reopening = service.open("workspace", "docs/index.html", { preparedFile: prepared });
    await checking;
    service.releaseConsumer("first");
    pause = false;
    resume();
    const next = await reopening;
    assert.equal(new URL(next.url).origin, new URL(first.url).origin);
    assert.equal((await raw(next.url)).status, 200);
    next.release();
    await assert.rejects(raw(next.url));
  } finally {
    resume();
    await service.shutdown();
    await f.close();
  }
});

test("cancelled reservations release listeners and cannot close a reopened origin", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const first = await f.service.open("workspace", "docs/index.html", {
      signal: controller.signal,
    });
    controller.abort(new Error("generation cancelled"));
    await assert.rejects(raw(first.url));
    const second = await f.service.open("workspace", "docs/index.html");
    first.release();
    assert.notEqual(new URL(first.url).origin, new URL(second.url).origin);
    assert.equal((await raw(second.url)).status, 200);
    second.release();
    await assert.rejects(raw(second.url));
    await assert.rejects(
      f.service.open("workspace", "docs/index.html", { signal: controller.signal }),
      /generation cancelled/,
    );
  } finally {
    await f.close();
  }
});

test("known capabilities are scrubbed from bare and encoded text after closure", async () => {
  const f = await fixture();
  try {
    const reservation = await f.service.open("workspace", "docs/index.html");
    const token = new URL(reservation.url).searchParams.get("__aiden_preview")!;
    assert.equal(f.service.redactText(`token: ${token}`), "token: [private-preview]");
    assert.doesNotMatch(
      f.service.redactText(encodeURIComponent(reservation.url)),
      new RegExp(token),
    );
    assert.equal(f.service.redactText("Ordinary page text"), "Ordinary page text");
    reservation.release();
    assert.equal(f.service.redactText(token), "[private-preview]");
  } finally {
    await f.close();
  }
});

test("cancellation during filesystem authority lookup creates no listener", async () => {
  const f = await fixture();
  let entered!: () => void;
  let resume!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const events: unknown[] = [];
  const service = new BrowserFileService({
    getWorkspace: async () => {
      entered();
      await gate;
      return { id: "workspace", folderPath: f.root, permission: "full" };
    },
    onLifecycle: (event) => events.push(event),
  });
  try {
    const controller = new AbortController();
    const opening = service.open("workspace", "docs/index.html", { signal: controller.signal });
    await ready;
    controller.abort(new Error("cancelled during lookup"));
    resume();
    await assert.rejects(opening, /cancelled during lookup/);
    assert.deepEqual(events, []);
  } finally {
    resume();
    await service.shutdown();
    await f.close();
  }
});

test("an admitted reader drains after the final tab closes while new readers are refused", async () => {
  let entered!: () => void;
  let resume!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const f = await fixture(async () => {
    entered();
    await gate;
  });
  try {
    const reservation = await f.service.open("workspace", "docs/index.html");
    f.service.commitConsumer("workspace", "tab", reservation.url);
    reservation.release();
    const response = raw(reservation.url);
    await reading;
    f.service.releaseConsumer("tab");
    await assert.rejects(raw(reservation.url));
    resume();
    assert.equal((await response).status, 200);
    await assert.rejects(raw(reservation.url));
  } finally {
    resume();
    await f.close();
  }
});

test("workspace revocation invalidates approved preparations and immediately closes live readers", async () => {
  let entered!: () => void;
  let resume!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const f = await fixture(async () => {
    entered();
    await gate;
  });
  try {
    const prepared = await f.service.prepare("workspace", "docs/index.html");
    const reservation = await f.service.open("workspace", "docs/index.html", {
      preparedFile: prepared,
    });
    const response = raw(reservation.url).then(
      () => false,
      () => true,
    );
    await reading;
    await f.service.closeForWorkspace("workspace");
    assert.equal(await response, true);
    assert.throws(() => f.service.approve(prepared), /closed/);
    await assert.rejects(
      f.service.open("workspace", "docs/index.html", { preparedFile: prepared }),
      /closed/,
    );
  } finally {
    resume();
    await f.close();
  }
});

test("workspace directory replacement invalidates old previews even at the same pathname", async () => {
  const f = await fixture();
  try {
    const url = await f.open("workspace", "docs/index.html");
    await fs.rename(f.root, `${f.root}-old`);
    await fs.mkdir(path.join(f.root, "docs"), { recursive: true });
    await fs.writeFile(path.join(f.root, "docs/index.html"), "replacement must not leak");
    const denied = await raw(url);
    assert.equal(denied.status, 403);
    assert.doesNotMatch(denied.body, /replacement must not leak/);
  } finally {
    await f.close();
  }
});

test("a symlink swap after descriptor opening cannot disclose replacement content", async () => {
  let swap: (() => Promise<void>) | undefined;
  const f = await fixture(async () => {
    const action = swap;
    swap = undefined;
    await action?.();
  });
  try {
    const url = await f.open("workspace", "docs/index.html");
    await fs.writeFile(path.join(f.folder, "outside.html"), "outside must not leak");
    swap = async () => {
      await fs.unlink(path.join(f.root, "docs/index.html"));
      await fs.symlink(path.join(f.folder, "outside.html"), path.join(f.root, "docs/index.html"));
    };
    const denied = await raw(url);
    assert.equal(denied.status, 404);
    assert.doesNotMatch(denied.body, /outside must not leak|Preview/);
  } finally {
    await f.close();
  }
});

test("rejects oversized assets using file metadata before reading bytes", async () => {
  const f = await fixture();
  try {
    const file = await fs.open(path.join(f.root, "large.pdf"), "w");
    await file.truncate(32 * 1024 * 1024 + 1);
    await file.close();
    await assert.rejects(f.open("workspace", "large.pdf"), /32 MB/);
  } finally {
    await f.close();
  }
});

test("literal URL punctuation in filenames is encoded and each workspace closure revokes its listener", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, "report ?#%.html"), "literal filename");
    const url = await f.open("workspace", "report ?#%.html");
    assert.equal((await raw(url)).body, "literal filename");
    const repeated = await f.open("workspace", "docs/index.html");
    assert.notEqual(new URL(repeated).origin, new URL(url).origin);
    await f.service.closeForWorkspace("workspace");
    await assert.rejects(raw(url));
    const fresh = await f.open("workspace", "docs/index.html");
    assert.notEqual(new URL(fresh).origin, new URL(url).origin);
    await f.service.shutdown();
    await assert.rejects(f.open("workspace", "docs/index.html"), /closed/);
  } finally {
    await f.close();
  }
});
