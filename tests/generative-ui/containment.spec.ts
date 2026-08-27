import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import playwrightTest from "@playwright/test";
import type * as PlaywrightTestModule from "@playwright/test";
import {
  GENERATIVE_UI_GUEST_CSP,
  GENERATIVE_UI_IFRAME_SANDBOX,
  GENERATIVE_UI_PARENT_FRAME_SRC,
} from "../../renderer/shared/generative-ui";
import { generativeUiExportDocument } from "../../main/services/generative-ui-html";

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
