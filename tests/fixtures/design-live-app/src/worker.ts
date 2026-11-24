// A dedicated or shared worker that tries one fetch and reports the outcome.
const url = new URL(self.location.href).searchParams.get("url") ?? "";

async function attempt(): Promise<string> {
  try {
    const response = await fetch(url, { mode: "no-cors", cache: "no-store" });
    return `ok:${response.type}`;
  } catch (error) {
    return `failed:${(error as Error).name}`;
  }
}

const scope = self as unknown as { onconnect?: unknown; postMessage?: (value: unknown) => void };
if ("onconnect" in scope) {
  (self as unknown as { onconnect: (event: MessageEvent) => void }).onconnect = (event) => {
    const port = event.ports[0];
    void attempt().then((result) => port.postMessage(result));
  };
} else {
  void attempt().then((result) => scope.postMessage?.(result));
}
