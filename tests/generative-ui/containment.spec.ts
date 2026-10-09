import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import playwrightTest from "@playwright/test";
import type * as PlaywrightTestModule from "@playwright/test";
import {
  GENERATIVE_UI_GUEST_CSP,
  GENERATIVE_UI_ESCAPE_MESSAGE,
  GENERATIVE_UI_IFRAME_SANDBOX,
  GENERATIVE_UI_PARENT_FRAME_SRC,
  generativeUiDraftCsp,
} from "../../renderer/shared/generative-ui";
import {
  generativeUiDraftDocumentHead,
  generativeUiExportDocument,
  wrapGenerativeUiHtml,
} from "../../main/services/generative-ui-html";

// Playwright's config loader resolves this ESM repo through the CommonJS
// condition. Named exports are unavailable; the default object carries them.
const { expect, test } = playwrightTest as unknown as typeof PlaywrightTestModule;

async function listen(
  onRequest: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer(onRequest);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

type Probe = {
  fetchOutcome: string;
  parentDocument: string;
  origin: string;
  connectSrcViolation: boolean;
};

test("sandboxed unique-origin guest cannot fetch the network or read parent DOM", async ({
  page,
}) => {
  expect(GENERATIVE_UI_IFRAME_SANDBOX).toBe("allow-scripts");
  expect(GENERATIVE_UI_IFRAME_SANDBOX).not.toMatch(/allow-same-origin/);
  expect(GENERATIVE_UI_PARENT_FRAME_SRC).toBe("'self' aiden-genui:");

  // Parent and guest share one HTTP origin so a missing unique-origin sandbox
  // would make window.parent.document readable. That is the containment proof.
  const site = await listen((request, response) => {
    if (request.url === "/artifact") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": GENERATIVE_UI_GUEST_CSP,
      });
      response.end(`<!DOCTYPE html><html><body data-probe="pending"><script>
        window.__probe = (async () => {
          const connectSrcSeen = new Promise((resolve) => {
            document.addEventListener("securitypolicyviolation", (event) => {
              if (event.effectiveDirective === "connect-src") resolve(true);
            });
          });
          let fetchOutcome = "ran";
          try {
            await fetch("https://example.com/");
            fetchOutcome = "completed";
          } catch (error) {
            fetchOutcome = "threw:" + (error instanceof Error ? error.name : "error");
          }
          let parentDocument = "readable";
          try {
            void window.parent.document.title;
          } catch {
            parentDocument = "denied";
          }
          const connectSrcViolation = await Promise.race([
            connectSrcSeen,
            new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
          ]);
          const result = {
            fetchOutcome,
            parentDocument,
            origin: String(self.origin),
            connectSrcViolation,
          };
          document.body.setAttribute("data-probe", JSON.stringify(result));
          return result;
        })();
      </script></body></html>`);
      return;
    }
    if (request.url !== "/") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'self'; script-src 'self'; frame-src 'self';",
    });
    response.end(`<!DOCTYPE html><html><body>
      <iframe
        id="guest"
        title="artifact"
        sandbox="${GENERATIVE_UI_IFRAME_SANDBOX}"
        src="/artifact"
        referrerpolicy="no-referrer"
      ></iframe>
    </body></html>`);
  });

  try {
    await page.goto(`${site.origin}/`, { waitUntil: "domcontentloaded" });
    const body = page.frameLocator("#guest").locator("body");
    await expect(body).not.toHaveAttribute("data-probe", "pending");
    const encoded = await body.getAttribute("data-probe");
    expect(encoded).toBeTruthy();
    const probe = JSON.parse(encoded ?? "") as Probe;
    expect(probe.parentDocument).toBe("denied");
    expect(probe.fetchOutcome).toMatch(/^threw:/);
    expect(probe.connectSrcViolation).toBe(true);
  } finally {
    await site.close();
  }
});

test("srcdoc in a privileged parent CSP does not run guest scripts", async ({ page }) => {
  const parent = await listen((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'self'; script-src 'self'; frame-src 'self';",
    });
    response.end(`<!DOCTYPE html><html><body>
      <iframe
        id="inherited"
        sandbox="${GENERATIVE_UI_IFRAME_SANDBOX}"
        srcdoc="<body data-marker='idle'><script>document.body.setAttribute('data-ran','1')</script></body>"
      ></iframe>
    </body></html>`);
  });
  try {
    await page.goto(`${parent.origin}/`, { waitUntil: "domcontentloaded" });
    const body = page.frameLocator("#inherited").locator("body");
    await expect(body).toHaveAttribute("data-marker", "idle");
    await expect(body).not.toHaveAttribute("data-ran", "1");
  } finally {
    await parent.close();
  }
});

test("parent frame-src does not load arbitrary https frames", async ({ page }) => {
  const parent = await listen((request, response) => {
    if (request.url === "/listener.js") {
      response.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      response.end(`window.__csp = [];
document.addEventListener("securitypolicyviolation", (event) => {
  window.__csp.push(event.effectiveDirective + " " + event.blockedURI);
});`);
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'self'; script-src 'self'; frame-src 'self' aiden-genui:;",
    });
    response.end(`<!DOCTYPE html><html><head><script src="/listener.js"></script></head><body>
      <iframe id="remote" src="https://example.com/"></iframe>
    </body></html>`);
  });
  try {
    await page.goto(`${parent.origin}/`, { waitUntil: "domcontentloaded" });
    await expect
      .poll(() => page.frames().some((frame) => frame.url().startsWith("https://example.com")))
      .toBe(false);
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (window as unknown as { __csp?: string[] }).__csp?.some((entry) =>
              /frame-src/u.test(entry),
            ) ?? false,
        ),
      )
      .toBe(true);
  } finally {
    await parent.close();
  }
});

test("standalone export stays interactive without allowing guest navigation", async ({
  page,
}) => {
  let navigationRequests = 0;
  const site = await listen((request, response) => {
    if (request.url?.startsWith("/escaped") === true) {
      navigationRequests += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url !== "/export") {
      response.writeHead(404);
      response.end();
      return;
    }
    const target = `http://${request.headers.host}/escaped?artifact=secret`;
    const exported = generativeUiExportDocument(
      `<button id="counter" type="button">0</button><script>
        document.getElementById("counter").addEventListener("click", (event) => {
          event.currentTarget.textContent = String(Number(event.currentTarget.textContent) + 1);
          window.location.href = ${JSON.stringify(target)};
        });
        try { window.top.location.href = ${JSON.stringify(target)}; } catch {}
      </script>`,
      "Contained export",
      {
        "chart.js": "window.Chart = {};",
        "plotly.js": "window.Plotly = {};",
        "katex.js": "window.katex = {};",
        "katex.css": "body { min-height: 100%; }",
      },
    );
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(exported);
  });

  try {
    await page.goto(`${site.origin}/export`, { waitUntil: "domcontentloaded" });
    const counter = page.frameLocator("iframe").locator("#counter");
    await expect(counter).toHaveText("0");
    await counter.click();
    await expect.poll(() => page.url()).toBe(`${site.origin}/export`);
    await expect.poll(() => navigationRequests).toBe(0);
  } finally {
    await site.close();
  }
});

test("a top-layer artifact escapes transcript stacking and preserves its browsing context", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 500 });
  await page.setContent(`<!DOCTYPE html><html><head><style>
    #scroll { isolation: isolate; position: relative; z-index: 0; mask-image: linear-gradient(black, transparent); }
    #host { width: 320px; height: 180px; border: 0; padding: 0; }
    #host:not(:popover-open) { display: block !important; position: static; inset: auto; margin: 0; }
    #host:popover-open { inset: 12px; width: auto; height: auto; margin: 0; }
    #artifact { width: 100%; height: 100%; border: 0; }
    #cover { display: none; position: fixed; inset: 0; z-index: 9999; background: white; }
    body[data-expanded] #cover { display: block; }
  </style></head><body>
    <button id="opener" type="button">Expand</button>
    <div id="scroll"><section id="host" popover="auto"><iframe id="artifact" sandbox="allow-scripts" srcdoc="<button id='counter' type='button'>0</button><script>document.getElementById('counter').onclick = (event) => event.currentTarget.textContent = String(Number(event.currentTarget.textContent) + 1); document.addEventListener('keydown', (event) => { if (event.key === 'Escape') parent.postMessage('${GENERATIVE_UI_ESCAPE_MESSAGE}', '*'); }, true)</script>"></iframe></section></div>
    <div id="cover"></div>
    <script>
      const host = document.querySelector('#host');
      const opener = document.querySelector('#opener');
      const artifact = document.querySelector('#artifact');
      opener.onclick = () => { document.body.dataset.expanded = 'true'; host.showPopover(); };
      window.addEventListener('message', (event) => {
        if (event.source === artifact.contentWindow && event.data === ${JSON.stringify(GENERATIVE_UI_ESCAPE_MESSAGE)}) host.hidePopover();
      });
      host.addEventListener('toggle', () => {
        if (!host.matches(':popover-open')) {
          delete document.body.dataset.expanded;
          opener.focus();
        }
      });
    </script>
  </body></html>`);
  const counter = page.frameLocator("#artifact").locator("#counter");
  await expect(page.locator("#host")).toHaveCSS("position", "static");
  await counter.evaluate((button: HTMLButtonElement) => button.click());
  await expect(counter).toHaveText("1");

  await page.locator("#opener").click();
  await expect(page.locator("#host")).toHaveCSS("position", "fixed");
  await expect(page.locator("iframe")).toHaveCount(1);
  await expect(counter).toHaveText("1");
  await expect(counter).toBeVisible();
  await counter.click();
  await expect(counter).toHaveText("2");
  expect(
    await page.evaluate(() => document.elementFromPoint(320, 250)?.id),
  ).toBe("artifact");
  const bounds = await page.locator("#host").boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect(bounds?.y).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(640);
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(500);

  await page.keyboard.press("Escape");
  await expect.poll(() => page.locator("#host").evaluate((host) => host.matches(":popover-open"))).toBe(false);
  await expect(page.locator("iframe")).toHaveCount(1);
  await expect(counter).toHaveText("2");
  await expect(page.locator("#host")).toHaveCSS("position", "static");
  await expect(page.locator("#opener")).toBeFocused();
});

type BridgeMessage = { type?: string; height?: number; text?: string } | string | null;

/**
 * Serve a parent page embedding the main-wrapped guest exactly as the app does
 * (unique-origin sandbox, guest CSP) and record every message it posts.
 */
async function loadWrappedGuest(
  page: PlaywrightTestModule.Page,
  html: string,
): Promise<{ messages: () => Promise<BridgeMessage[]>; close: () => Promise<void> }> {
  const guest = wrapGenerativeUiHtml(html, "Bridge probe", undefined, { inline: true });
  const site = await listen((request, response) => {
    if (request.url === "/guest") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": GENERATIVE_UI_GUEST_CSP,
      });
      response.end(guest);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!DOCTYPE html><html><body>
      <script>window.__msgs = []; window.addEventListener("message", (e) => window.__msgs.push(e.data));</script>
      <iframe id="artifact" sandbox="${GENERATIVE_UI_IFRAME_SANDBOX}" src="/guest" style="width:600px;height:300px"></iframe>
    </body></html>`);
  });
  await page.goto(site.origin);
  return {
    messages: () => page.evaluate(() => (window as unknown as { __msgs: BridgeMessage[] }).__msgs),
    close: site.close,
  };
}

const ofType = (messages: BridgeMessage[], type: string) =>
  messages.filter((m): m is { type: string; height?: number; text?: string } =>
    typeof m === "object" && m !== null && m.type === type);

test("draft preview renders partial markup without running model scripts", async ({ page }) => {
  const nonce = "Zm9vYmFyYmF6cXV4MTIzNA==";
  const draft = `${generativeUiDraftDocumentHead("Draft", undefined, nonce)}<p id="x">ok</p><script>parent.postMessage("ran", "*")</script><div style="height:400px">`;
  let openDraft: { end: () => void } | undefined;
  const site = await listen((request, response) => {
    if (request.url === "/draft") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": generativeUiDraftCsp(nonce),
      });
      // Leave the document open, as a streaming draft is.
      response.write(draft);
      openDraft = response;
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!DOCTYPE html><html><body>
      <script>window.__msgs = []; window.addEventListener("message", (e) => window.__msgs.push(e.data));</script>
      <iframe id="artifact" sandbox="${GENERATIVE_UI_IFRAME_SANDBOX}" src="/draft" style="width:600px;height:300px"></iframe>
    </body></html>`);
  });
  try {
    await page.goto(site.origin, { waitUntil: "commit" });
    await expect(page.frameLocator("#artifact").locator("#x")).toHaveText("ok");
    const messages = () => page.evaluate(() => (window as unknown as { __msgs: BridgeMessage[] }).__msgs);
    await expect.poll(async () => ofType(await messages(), "aiden:generative-ui:ready").length).toBe(1);
    await expect.poll(async () => ofType(await messages(), "aiden:generative-ui:resize").length).toBeGreaterThan(0);
    expect((await messages()).includes("ran")).toBe(false);
  } finally {
    openDraft?.end();
    await site.close().catch(() => undefined);
  }
});

test("bridge reports content height to the parent", async ({ page }) => {
  const guest = await loadWrappedGuest(page, '<div style="height:640px">tall</div>');
  try {
    await expect
      .poll(async () => {
        const resizes = ofType(await guest.messages(), "aiden:generative-ui:resize");
        return resizes[resizes.length - 1]?.height ?? 0;
      })
      .toBeGreaterThanOrEqual(640);
  } finally {
    await guest.close();
  }
});

test("bridge height follows content down as well as up, independent of the frame viewport", async ({ page }) => {
  const guest = await loadWrappedGuest(
    page,
    '<h1>Title</h1><div id="box" style="height:600px"></div><script>setTimeout(() => { document.getElementById("box").style.height = "40px"; }, 300)</script>',
  );
  const lastHeight = async () => {
    const resizes = ofType(await guest.messages(), "aiden:generative-ui:resize");
    return resizes[resizes.length - 1]?.height ?? 0;
  };
  try {
    await expect.poll(lastHeight).toBeGreaterThanOrEqual(600);
    // The frame in this harness is 300px tall; the content is now ~40px + heading.
    await expect.poll(lastHeight).toBeLessThan(160);
    await expect.poll(lastHeight).toBeGreaterThan(40);
  } finally {
    await guest.close();
  }
});

for (const [label, html, minimum] of [
  ["an absolutely positioned diagram", '<div style="position:absolute;top:0;left:0;width:200px;height:500px"></div>', 500],
  ["an absolute child inside a relative box", '<div style="position:relative;height:45px"><div style="position:absolute;top:30px;height:500px;width:10px"></div></div>', 530],
  ["a fixed-height box that overflows", '<div style="height:50px"><div style="height:500px"></div></div>', 500],
] as const) {
  test(`bridge height includes ${label}`, async ({ page }) => {
    const guest = await loadWrappedGuest(page, html);
    try {
      await expect
        .poll(async () => {
          const resizes = ofType(await guest.messages(), "aiden:generative-ui:resize");
          return resizes[resizes.length - 1]?.height ?? 0;
        })
        .toBeGreaterThanOrEqual(minimum);
    } finally {
      await guest.close();
    }
  });
}

test("wrapped documents keep the browser's 16px rem in inline and standalone modes", async ({ page }) => {
  for (const inline of [true, false]) {
    const doc = wrapGenerativeUiHtml('<p id="p" style="width:10rem">x</p>', "Rem", undefined, { inline });
    const site = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(doc);
    });
    try {
      await page.goto(site.origin);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("16px");
      expect(await page.locator("#p").evaluate((el) => el.getBoundingClientRect().width)).toBe(160);
    } finally {
      await site.close();
    }
  }
});

test("sendPrompt posts a typed prompt message and nothing else", async ({ page }) => {
  const guest = await loadWrappedGuest(
    page,
    '<button id="b" onclick="aiden.sendPrompt(\'Drill in\')">go</button>',
  );
  try {
    await page.frameLocator("#artifact").locator("#b").click();
    await expect
      .poll(async () => ofType(await guest.messages(), "aiden:generative-ui:prompt"))
      .toEqual([{ type: "aiden:generative-ui:prompt", text: "Drill in" }]);
  } finally {
    await guest.close();
  }
});

test("theme messages from the parent update guest variables without reloading", async ({ page }) => {
  const guest = await loadWrappedGuest(
    page,
    "<p id=p>x</p><script>window.__loaded = (window.__loaded || 0) + 1</script>",
  );
  try {
    const paragraph = page.frameLocator("#artifact").locator("#p");
    await expect(paragraph).toHaveText("x");
    await page.evaluate(() => {
      const iframe = document.querySelector("iframe") as HTMLIFrameElement;
      iframe.contentWindow!.postMessage(
        { type: "aiden:generative-ui:theme", colorScheme: "dark", vars: { "--accent": "#ff0000", "--bad": "x;}" } },
        "*",
      );
    });
    await expect
      .poll(() => paragraph.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()))
      .toBe("#ff0000");
    expect(await paragraph.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--bad").trim())).toBe("");
    expect(await paragraph.evaluate(() => document.documentElement.dataset.colorScheme)).toBe("dark");
    expect(await paragraph.evaluate(() => (window as unknown as { __loaded: number }).__loaded)).toBe(1);
  } finally {
    await guest.close();
  }
});

test("a guest can steal focus without a gesture, but only a real click activates the parent", async ({ page }) => {
  // The sendPrompt admission relies on this platform behavior: scripted focus
  // moves activeElement to the frame, yet only user input inside it grants
  // the parent transient activation. Playwright's evaluate() itself counts as
  // a gesture, so the parent records state when each guest message arrives.
  const guestHtml = `<input id="field"><button id="b" onclick="aiden.sendPrompt('clicked')">go</button>
<script>setTimeout(() => { document.getElementById("field").focus(); setTimeout(() => aiden.sendPrompt("scripted"), 100); }, 200)</script>`;
  const guest = wrapGenerativeUiHtml(guestHtml, "Activation probe", undefined, { inline: true });
  const site = await listen((request, response) => {
    if (request.url === "/guest") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": GENERATIVE_UI_GUEST_CSP,
      });
      response.end(guest);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!DOCTYPE html><html><body>
      <script>
        window.__probes = [];
        window.addEventListener("message", (e) => {
          if (!e.data || e.data.type !== "aiden:generative-ui:prompt") return;
          window.__probes.push({ text: e.data.text, active: navigator.userActivation.isActive, tag: document.activeElement && document.activeElement.tagName });
          console.log("probe:" + e.data.text);
        });
      </script>
      <iframe id="artifact" sandbox="${GENERATIVE_UI_IFRAME_SANDBOX}" src="/guest" style="width:600px;height:300px"></iframe>
    </body></html>`);
  });
  try {
    const scripted = page.waitForEvent("console", (message) => message.text() === "probe:scripted");
    await page.goto(site.origin);
    await scripted;
    const clicked = page.waitForEvent("console", (message) => message.text() === "probe:clicked");
    await page.frameLocator("#artifact").locator("#b").click();
    await clicked;
    const probes = await page.evaluate(() => (window as unknown as { __probes: unknown[] }).__probes);
    expect(probes).toEqual([
      { text: "scripted", active: false, tag: "IFRAME" },
      { text: "clicked", active: true, tag: "IFRAME" },
    ]);
  } finally {
    await site.close();
  }
});

test("guest code cannot replace window.aiden", async ({ page }) => {
  const guest = await loadWrappedGuest(
    page,
    "<script>try { window.aiden.sendPrompt = () => {}; } catch (e) {} try { window.aiden = {}; } catch (e) {} window.aiden.sendPrompt('still works');</script>",
  );
  try {
    await expect
      .poll(async () => ofType(await guest.messages(), "aiden:generative-ui:prompt").map((m) => m.text))
      .toEqual(["still works"]);
  } finally {
    await guest.close();
  }
});
