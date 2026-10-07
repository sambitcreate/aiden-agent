import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// A real 1×1 PNG, so Aiden's output validation and the studio asset store accept it.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";

export interface FakeOpenRouterRequest {
  model: string;
  prompt: string;
  references: number;
}

export interface FakeOpenRouter {
  origin: string;
  imageRequests: FakeOpenRouterRequest[];
  otherRequests: string[];
  hold(): void;
  release(): void;
  /** The next image request answers 500 once. It is still recorded in `imageRequests`. */
  failNext(): void;
  close(): Promise<void>;
}

/** Test-owned loopback OpenRouter. It serves image generation only; everything else is 503. */
export async function startFakeOpenRouter(): Promise<FakeOpenRouter> {
  const imageRequests: FakeOpenRouterRequest[] = [];
  const otherRequests: string[] = [];
  const held = new Set<() => void>();
  let holding = false;
  let failures = 0;
  const server: Server = createServer(async (request, response) => {
    const url = request.url ?? "/";
    if (request.method !== "POST" || url !== "/api/v1/chat/completions") {
      otherRequests.push(`${request.method ?? "GET"} ${url}`);
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "The E2E OpenRouter fake serves only image generation." } }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      model: string;
      messages: { content: { type: string; text?: string }[] }[];
    };
    const content = body.messages[0]?.content ?? [];
    imageRequests.push({
      model: body.model,
      prompt: content.filter((part) => part.type === "text").map((part) => part.text ?? "").join(""),
      references: content.filter((part) => part.type === "image_url").length,
    });
    if (failures > 0) {
      failures -= 1;
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "The E2E OpenRouter fake failed this request on purpose." } }));
      return;
    }
    const reply = () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: `gen-e2e-${imageRequests.length}`,
          object: "chat.completion",
          created: 0,
          model: body.model,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "",
                images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1X1}` } }],
              },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 1290, total_tokens: 1302 },
        }),
      );
    };
    if (!holding) return reply();
    held.add(reply);
    response.once("close", () => held.delete(reply));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    imageRequests,
    otherRequests,
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const reply of [...held]) reply();
      held.clear();
    },
    failNext: () => {
      failures += 1;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
