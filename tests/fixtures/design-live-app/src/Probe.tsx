import { useEffect, useRef, useState } from "react";

/**
 * Tries every way out of the frame against the observers the E2E names in the
 * query, and writes each outcome to `#result` as JSON. Nothing runs until the
 * Run button is pressed, so the test controls timing (`?auto=export` runs the
 * export-window subset on load instead).
 *
 * Query: `target=127.0.0.1:P` (a TLS-less TCP observer, used for `https:`),
 * `alt=127.0.0.2:P2`, `udp=U` (a UDP observer), `own=O` (one of Aiden's own
 * ports). External hosts (`example.com`, `www.youtube.com`) are mapped to the
 * non-loopback observer by the test's host resolver rules.
 */

type Outcomes = Record<string, string>;

const params = new URLSearchParams(location.search);
const target = params.get("target") ?? "127.0.0.1:9";
const alt = params.get("alt") ?? "127.0.0.2:9";
const udp = params.get("udp") ?? "9";
const own = params.get("own") ?? "9";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(name: string, run: () => Promise<unknown>, timeoutMs = 3000): Promise<[string, string]> {
  try {
    const value = await Promise.race([
      run(),
      wait(timeoutMs).then(() => {
        throw Object.assign(new Error("timeout"), { name: "Timeout" });
      }),
    ]);
    return [name, `ok:${typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value) ?? ""}`];
  } catch (error) {
    return [name, `failed:${(error as Error)?.name ?? "error"}`];
  }
}

function fetchProbe(url: string, init?: RequestInit) {
  return async () => {
    const response = await fetch(url, { cache: "no-store", ...init });
    return `${response.status}`;
  };
}

function loadElement(tag: "img" | "script" | "link", url: string, rel?: string) {
  return () =>
    new Promise<string>((resolve, reject) => {
      const element = document.createElement(tag) as HTMLImageElement & HTMLScriptElement & HTMLLinkElement;
      element.onload = () => resolve("loaded");
      element.onerror = () => reject(Object.assign(new Error("error"), { name: "LoadError" }));
      if (tag === "link") {
        element.rel = rel ?? "stylesheet";
        element.href = url;
      } else {
        element.src = url;
      }
      document.body.appendChild(element);
      if (tag === "link" && rel && rel !== "stylesheet") setTimeout(() => resolve("hinted"), 1000);
    });
}

function cssProbe() {
  return () =>
    new Promise<string>((resolve) => {
      const style = document.createElement("style");
      style.textContent = `@import url("https://example.com/import.css");
@font-face { font-family: ProbeFont; src: url("https://example.com/font.woff2"); }
#css-probe { font-family: ProbeFont; background-image: url("https://example.com/bg.png"); }`;
      document.head.appendChild(style);
      const node = document.createElement("div");
      node.id = "css-probe";
      node.textContent = "css";
      document.body.appendChild(node);
      void document.fonts.load("16px ProbeFont").finally(() => setTimeout(() => resolve("applied"), 500));
    });
}

function speculationProbe() {
  return async () => {
    const script = document.createElement("script");
    script.type = "speculationrules";
    script.textContent = JSON.stringify({ prefetch: [{ source: "list", urls: [`https://${target}/spec`] }] });
    document.head.appendChild(script);
    await wait(1000);
    return "inserted";
  };
}

function pingProbe() {
  return async () => {
    const link = document.createElement("a");
    link.href = "#ping";
    link.setAttribute("ping", `https://${target}/p`);
    document.body.appendChild(link);
    link.click();
    await wait(500);
    return "clicked";
  };
}

function eventSourceProbe() {
  return () =>
    new Promise<string>((resolve, reject) => {
      const source = new EventSource("https://example.com/events");
      source.onopen = () => {
        source.close();
        resolve("open");
      };
      source.onerror = () => {
        source.close();
        reject(Object.assign(new Error("error"), { name: "EventSourceError" }));
      };
    });
}

function webSocketProbe(url: string) {
  return () =>
    new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.onopen = () => {
        socket.close();
        resolve("open");
      };
      socket.onerror = () => reject(Object.assign(new Error("error"), { name: "WebSocketError" }));
    });
}

function webTransportProbe() {
  return async () => {
    const ctor = (window as unknown as { WebTransport?: new (url: string) => { ready: Promise<unknown> } }).WebTransport;
    if (!ctor) return "undefined";
    const session = new ctor(`https://127.0.0.1:${udp}/wt`);
    await session.ready;
    return "ready";
  };
}

function workerProbe(kind: "dedicated" | "shared" | "blob") {
  return () =>
    new Promise<string>((resolve, reject) => {
      const url = "https://example.com/worker";
      const answer = (event: MessageEvent) =>
        String(event.data).startsWith("ok")
          ? resolve(String(event.data))
          : reject(Object.assign(new Error(String(event.data)), { name: "WorkerFetchFailed" }));
      if (kind === "shared") {
        const worker = new SharedWorker(new URL("./worker.ts", import.meta.url), { type: "module" });
        worker.port.onmessage = answer;
        worker.port.start();
        worker.port.postMessage(url);
        return;
      }
      const worker =
        kind === "blob"
          ? new Worker(
              URL.createObjectURL(
                new Blob([`onmessage = (e) => fetch(e.data, {mode: "no-cors"}).then(r => postMessage("ok:" + r.type), err => postMessage("failed:" + err.name));`], { type: "text/javascript" }),
              ),
            )
          : new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = answer;
      worker.onerror = () => reject(Object.assign(new Error("error"), { name: "WorkerError" }));
      worker.postMessage(url);
    });
}

function iframeProbe() {
  return () =>
    new Promise<string>((resolve) => {
      const frame = document.createElement("iframe");
      frame.src = "https://www.youtube.com/embed/x";
      frame.onload = () => resolve("load-event");
      document.body.appendChild(frame);
      setTimeout(() => resolve("no-load"), 2000);
    });
}

function downloadProbe() {
  return async () => {
    const link = document.createElement("a");
    link.href = "/f.zip";
    link.download = "f.zip";
    document.body.appendChild(link);
    link.click();
    await wait(500);
    return "clicked";
  };
}

async function serviceWorkerProbe(): Promise<string> {
  const registration = await navigator.serviceWorker.register("/sw.js");
  const worker = registration.active ?? registration.installing ?? registration.waiting;
  if (!worker) return "no-worker";
  if (worker.state !== "activated") {
    await new Promise<void>((resolve) => worker.addEventListener("statechange", () => worker.state === "activated" && resolve()));
  }
  const result = await new Promise<unknown>((resolve) => {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "probe-result") resolve(event.data.result);
    });
    worker.postMessage({ type: "probe", fetchUrl: "https://example.com/sw", transportUrl: `https://127.0.0.1:${udp}/sw-wt` });
  });
  return JSON.stringify(result);
}

function pagehideBeacon() {
  window.addEventListener("pagehide", () => {
    navigator.sendBeacon("https://example.com/b", "bye");
    void fetch("https://example.com/k", { method: "POST", body: "bye", keepalive: true }).catch(() => undefined);
  });
}

export async function runProbes(): Promise<Outcomes> {
  const runs: Array<Promise<[string, string]>> = [
    settle("fetchExternal", fetchProbe("https://example.com/", { mode: "no-cors" })),
    settle("fetchLan", fetchProbe("http://192.168.1.10/", { mode: "no-cors" }), 2000),
    settle("fetchAltLoopback", fetchProbe(`http://${alt}/`, { mode: "no-cors" })),
    settle("fetchHttpsLoopback", fetchProbe(`https://${target}/`, { mode: "no-cors" })),
    settle("img", loadElement("img", "https://example.com/i.png")),
    settle("wsExternal", webSocketProbe("ws://example.com/ws")),
    settle("wssExternal", webSocketProbe("wss://example.com/ws")),
    settle("eventSource", eventSourceProbe()),
    settle("css", cssProbe()),
    settle("prefetch", loadElement("link", `https://${target}/prefetch`, "prefetch")),
    settle("modulepreload", loadElement("link", `https://${target}/modulepreload.js`, "modulepreload")),
    settle("preconnect", loadElement("link", `https://${target}/`, "preconnect")),
    settle("dnsPrefetch", loadElement("link", "https://dns-prefetch.example.com/", "dns-prefetch")),
    settle("speculation", speculationProbe()),
    settle("ping", pingProbe()),
    settle("beacon", async () => String(navigator.sendBeacon("https://example.com/beacon", "x"))),
    settle("webTransport", webTransportProbe()),
    settle("dedicatedWorker", workerProbe("dedicated")),
    settle("sharedWorker", workerProbe("shared")),
    settle("blobWorker", workerProbe("blob")),
    settle("attachmentImg", loadElement("img", "aiden-attachment://probe/x.png")),
    settle("designScript", loadElement("script", "aiden-design://grant/design/x.js")),
    settle("assetLink", loadElement("link", "aiden-asset://probe/x.css")),
    settle("redirectOwn", fetchProbe(`/r-own?port=${own}`)),
    settle("redirectEvil", fetchProbe("/r-evil")),
    settle("redirectOut", fetchProbe("/go-out")),
    settle("windowOpen", async () => String(window.open("https://example.com/popup") === null)),
    settle("alert", async () => {
      const started = performance.now();
      alert("x");
      return `${Math.round(performance.now() - started)}ms`;
    }),
    settle("confirm", async () => String(confirm("x"))),
    settle("print", async () => {
      const started = performance.now();
      print();
      return `${Math.round(performance.now() - started)}ms`;
    }),
    settle("getUserMedia", async () => {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      return "granted";
    }),
    settle("getDisplayMedia", async () => {
      await navigator.mediaDevices.getDisplayMedia();
      return "granted";
    }),
    settle("notification", async () => Notification.requestPermission()),
    settle(
      "geolocation",
      () =>
        new Promise<string>((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(
            () => resolve("granted"),
            (error) => reject(Object.assign(new Error(error.message), { name: `GeolocationError${error.code}` })),
          ),
        ),
    ),
    settle("pictureInPicture", async () => {
      const video = document.createElement("video");
      video.muted = true;
      document.body.appendChild(video);
      await video.requestPictureInPicture();
      return "opened";
    }),
    settle("fullscreen", async () => {
      await document.documentElement.requestFullscreen();
      return "entered";
    }),
    settle("clipboard", async () => navigator.clipboard.readText()),
    settle("youtubeFrame", iframeProbe()),
    settle("topLocation", async () => {
      top!.location.href = "https://example.com/top";
      await wait(300);
      return "assigned";
    }),
    settle("download", downloadProbe()),
    settle("serviceWorker", serviceWorkerProbe, 8000),
  ];
  pagehideBeacon();
  return Object.fromEntries(await Promise.all(runs));
}

/** The export window's subset: download, print, WebTransport, a beacon and the microphone. */
async function runExportProbes(): Promise<Outcomes> {
  const runs = [
    settle("download", async () => {
      location.href = "/f.zip";
      return "assigned";
    }),
    settle("print", async () => {
      print();
      return "returned";
    }),
    settle("webTransport", webTransportProbe()),
    settle("beacon", async () => String(navigator.sendBeacon("https://example.com/export-beacon", "x"))),
    settle("getUserMedia", async () => {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      return "granted";
    }),
    settle("notification", async () => Notification.requestPermission()),
  ];
  return Object.fromEntries(await Promise.all(runs));
}

export function Probe() {
  const [result, setResult] = useState<Outcomes | null>(null);
  const [thief, setThief] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (params.get("auto") === "export") void runExportProbes().then(setResult);
    if (params.get("thief") === "1") setThief(true);
  }, []);
  useEffect(() => {
    if (!thief) return;
    const timer = setInterval(() => input.current?.focus(), 50);
    return () => clearInterval(timer);
  }, [thief]);
  return (
    <main>
      <h1>Probe</h1>
      <button id="run" type="button" onClick={() => void runProbes().then(setResult)}>
        Run
      </button>
      <button id="thief" type="button" onClick={() => setThief((value) => !value)}>
        Focus thief {thief ? "on" : "off"}
      </button>
      {/* Separate from Run: a refused mailto: may leave this frame on Chromium's blocked page. */}
      <button id="mailto" type="button" onClick={() => void (location.href = "mailto:x@example.com")}>
        Mail
      </button>
      <button id="history-back" type="button" onClick={() => history.go(-1)}>
        Back
      </button>
      <input ref={input} id="thief-input" aria-label="Thief input" />
      <pre id="result">{result ? JSON.stringify(result) : ""}</pre>
    </main>
  );
}
