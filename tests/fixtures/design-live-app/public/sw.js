/* global self, fetch, WebTransport, setTimeout */
// The probe's service worker. On a "probe" message it tries the network, a
// WebTransport and background sync, and answers with the outcomes.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function attempt(url) {
  try {
    const response = await fetch(url, { mode: "no-cors", cache: "no-store" });
    return `ok:${response.type}`;
  } catch (error) {
    return `failed:${error && error.name}`;
  }
}

async function transport(url) {
  if (typeof WebTransport === "undefined") return "undefined";
  try {
    const session = new WebTransport(url);
    await Promise.race([session.ready, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000))]);
    return "ready";
  } catch (error) {
    return `failed:${error && error.name}`;
  }
}

async function sync(kind) {
  try {
    const manager = kind === "periodic" ? self.registration.periodicSync : self.registration.sync;
    if (!manager) return "undefined";
    if (kind === "periodic") await manager.register("probe", { minInterval: 1000 });
    else await manager.register("probe");
    return "registered";
  } catch (error) {
    return `failed:${error && error.name}`;
  }
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "probe") return;
  event.waitUntil(
    (async () => {
      const result = {
        fetch: await attempt(data.fetchUrl),
        webTransport: data.transportUrl ? await transport(data.transportUrl) : "skipped",
        sync: await sync("one-off"),
        periodicSync: await sync("periodic"),
      };
      event.source && event.source.postMessage({ type: "probe-result", result });
    })(),
  );
});
