// A stand-in for expo-device-hub in the Simulator stream E2E. The spec seeds
// it as the "installed" hub entry, so Aiden's real local host spawns it with
// `--port <n>` under ELECTRON_RUN_AS_NODE and reaches it only through the real
// token proxy. It never touches Xcode.
//
// - AVCC answers with an H.264 description no decoder supports, so the client
//   takes its real MJPEG fallback.
// - MJPEG serves a small portrait JPEG every 200ms.
// - The per-device input socket pushes a screen config, logs every packet, and
//   closes the first connection after its first touch so the client must reconnect.
//
// Every request is appended as a JSON line to AIDEN_E2E_FAKE_HUB_LOG.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import process from "node:process";
import { clearInterval, setInterval } from "node:timers";
import { URL, URLSearchParams } from "node:url";

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAALqADAAQAAAABAAAAZAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAZAAuAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMACQkJCQkJEAkJEBYQEBAWHhYWFhYeJh4eHh4eJi4mJiYmJiYuLi4uLi4uLjc3Nzc3N0BAQEBASEhISEhISEhISP/bAEMBCwwMEhESHxERH0szKjNLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS//dAAQAA//aAAwDAQACEQMRAD8Ay6KKK+nPngooooAKKKKAP//Qy6KKK+nPngooooAKKKKAP//Ry6KKK+nPngooooAKKKKAP//Sy6KKK+nPngooooAKKKKAP//Ty6KKK+nPngooooAKKKKAP//Uy6KKK+nPngooooAKKKKAP//Vy6KKK+nPngooooAKKKKAP//Z",
  "base64",
);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAC4AAABkCAIAAAB2GJVqAAAAV0lEQVR4nO3OQREAAAQAMHFEFFEsKRyP3S3AIqufiPOBioqKiorKORUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFZUdA6N/RjiLn5tkAAAAAElFTkSuQmCC",
  "base64",
);
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TAG_SCREEN_CONFIG = 0x82;
const MSG_TOUCH = 0x03;

const portIndex = process.argv.indexOf("--port");
const port = Number(process.argv[portIndex + 1]);
const logPath = process.env.AIDEN_E2E_FAKE_HUB_LOG;
if (!Number.isInteger(port) || port <= 0 || !logPath) {
  throw new Error("The fake device hub needs --port and AIDEN_E2E_FAKE_HUB_LOG.");
}

const log = (entry) => appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
let inputConnections = 0;

function requestEntry(kind, request) {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  return {
    kind,
    method: request.method,
    path: url.pathname,
    query: url.search,
    origin: request.headers.origin ?? null,
    cookie: request.headers.cookie ?? null,
  };
}

function json(response, body) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const server = createServer((request, response) => {
  const entry = requestEntry("http", request);
  if (entry.path !== "/readyz") log(entry);
  if (entry.path === "/readyz") return json(response, { ok: true });
  if (request.method === "POST" && (entry.path === "/api/devices/boot" || entry.path === "/vendor/serve-sim/grid/api/start")) {
    request.resume();
    return json(response, { ok: true });
  }
  if (request.method === "POST" && entry.path === "/vendor/serve-sim/api/screenshot") {
    request.resume();
    response.writeHead(200, { "content-type": "image/png" });
    return response.end(PNG);
  }
  if (entry.path.endsWith("/stream.avcc")) {
    // Tag 1 is the decoder description; profile 0xff is not a real H.264 profile.
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.write(Buffer.from([0, 0, 0, 5, 1, 1, 0xff, 0xff, 0xff]));
    return;
  }
  if (entry.path.endsWith("/stream.mjpeg")) {
    response.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
    const send = () =>
      response.write(
        Buffer.concat([
          Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${JPEG.length}\r\n\r\n`),
          JPEG,
          Buffer.from("\r\n"),
        ]),
      );
    send();
    const timer = setInterval(send, 200);
    response.once("close", () => clearInterval(timer));
    return;
  }
  response.writeHead(404).end();
});

function frame(opcode, payload) {
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

/** Reads masked client frames. Enough for the small packets the stream client sends. */
function readFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset] & 0x0f;
    let length = buffer[offset + 1] & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      throw new Error("The fake hub does not accept 64-bit frames.");
    }
    if (buffer.length - cursor < 4 + length) break;
    const mask = buffer.subarray(cursor, cursor + 4);
    const payload = Buffer.from(buffer.subarray(cursor + 4, cursor + 4 + length));
    for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
    frames.push({ opcode, payload });
    offset = cursor + 4 + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

server.on("upgrade", (request, socket) => {
  const entry = requestEntry("ws-open", request);
  const key = request.headers["sec-websocket-key"];
  // Like the real hub: WebSocket routes match the exact path, and the device rides in `?device=`.
  const device = new URLSearchParams(entry.query).get("device");
  if (entry.path !== "/vendor/serve-sim/helper/ws" || !device || typeof key !== "string") {
    socket.destroy();
    return;
  }
  const connection = ++inputConnections;
  log({ ...entry, connection });
  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.write(
    frame(
      0x2,
      Buffer.concat([
        Buffer.from([TAG_SCREEN_CONFIG]),
        Buffer.from(JSON.stringify({ width: 460, height: 1000, orientation: "portrait" })),
      ]),
    ),
  );
  let pending = Buffer.alloc(0);
  let dropped = false;
  socket.on("data", (chunk) => {
    const { frames, rest } = readFrames(Buffer.concat([pending, chunk]));
    pending = rest;
    for (const { opcode, payload } of frames) {
      if (opcode === 0x8) {
        socket.end(frame(0x8, Buffer.alloc(0)));
        return;
      }
      if (opcode !== 0x2 || payload.length < 1) continue;
      let body = null;
      try {
        body = JSON.parse(payload.subarray(1).toString("utf8"));
      } catch {
        // Logged without a body.
      }
      log({ kind: "ws-message", connection, tag: payload[0], body });
      if (connection === 1 && payload[0] === MSG_TOUCH && body?.type === "end" && !dropped) {
        dropped = true;
        const reason = Buffer.from("e2e drop");
        const close = Buffer.concat([Buffer.from([0x03, 0xf3]), reason]); // 1011
        socket.end(frame(0x8, close));
      }
    }
  });
  socket.on("error", () => undefined);
});

server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
