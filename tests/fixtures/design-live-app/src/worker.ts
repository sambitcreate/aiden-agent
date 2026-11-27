// A dedicated or shared worker that tries one fetch of the URL it is sent and
// answers with the outcome.
async function attempt(url: string): Promise<string> {
  try {
    const response = await fetch(url, { mode: "no-cors", cache: "no-store" });
    return `ok:${response.type}`;
  } catch (error) {
    return `failed:${(error as Error).name}`;
  }
}

const scope = self as unknown as {
  onconnect?: (event: MessageEvent) => void;
  onmessage?: (event: MessageEvent) => void;
  postMessage?: (value: unknown) => void;
};
if ("SharedWorkerGlobalScope" in self) {
  scope.onconnect = (event) => {
    const port = event.ports[0]!;
    port.onmessage = (message) => void attempt(String(message.data)).then((result) => port.postMessage(result));
  };
} else {
  scope.onmessage = (message) => void attempt(String(message.data)).then((result) => scope.postMessage?.(result));
}
