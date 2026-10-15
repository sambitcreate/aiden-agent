import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { crc32, deflateSync } from "node:zlib";

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * A real 1×1 RGB PNG whose colour comes from `seed`, so Aiden's output validation and the studio
 * asset store accept it, and each request's image is a different asset a test can tell apart.
 */
function pngFor(seed: number): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // colour type: RGB
  const pixel = Buffer.from([0, (seed * 37) & 0xff, (seed * 91) & 0xff, (seed * 53) & 0xff]); // filter byte + RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixel)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

export interface FakeOpenRouterRequest {
  model: string;
  prompt: string;
  references: number;
}

export interface FakeOpenRouter {
  origin: string;
  imageRequests: FakeOpenRouterRequest[];
  otherRequests: string[];
  /** Held image requests whose connection Aiden closed before the fake answered (Stop or quit). */
  readonly abortedRequests: number;
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
  let aborted = 0;
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
    let body: { model: string; messages: { content: { type: string; text?: string }[] }[] };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body;
    } catch {
      // Answer instead of leaving the request open, so a malformed body fails the test quickly.
      otherRequests.push(`POST ${url} (malformed body)`);
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "The E2E OpenRouter fake could not parse this request." } }));
      return;
    }
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
    const image = pngFor(imageRequests.length);
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
                images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${image}` } }],
              },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 1290, total_tokens: 1302 },
        }),
      );
    };
    if (!holding) return reply();
    held.add(reply);
    response.once("close", () => {
      if (held.delete(reply)) aborted += 1;
    });
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
    get abortedRequests() {
      return aborted;
    },
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
