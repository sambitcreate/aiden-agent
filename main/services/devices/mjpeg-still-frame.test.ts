import assert from "node:assert/strict";
import test from "node:test";
import { mjpegBoundary, repeatStillFrame, type StillFrameTimers } from "./mjpeg-still-frame.js";

class ManualTimers implements StillFrameTimers {
  private pending = new Map<number, { callback: () => void; at: number }>();
  private nextId = 1;
  now = 0;

  set(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, { callback, at: this.now + ms });
    return id;
  }

  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  get size(): number {
    return this.pending.size;
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.pending]) {
      if (timer.at > this.now) continue;
      this.pending.delete(id);
      timer.callback();
    }
  }
}

function part(body: Buffer | string, boundary = "frame"): Buffer {
  const bytes = typeof body === "string" ? Buffer.from(body, "latin1") : body;
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${bytes.length}\r\n\r\n`, "latin1"),
    bytes,
    Buffer.from("\r\n"),
  ]);
}

/**
 * An independent reading of a multipart stream: split on `--boundary` lines,
 * take each part's Content-Length body, and require the CRLF after it.
 */
function parseMultipart(stream: Buffer, boundary = "frame"): string[] {
  const text = stream.toString("latin1");
  const bodies: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    while (text.startsWith("\r\n", offset)) offset += 2;
    if (offset >= text.length) break;
    assert.ok(text.startsWith(`--${boundary}\r\n`, offset), `delimiter expected at ${offset}`);
    const headersEnd = text.indexOf("\r\n\r\n", offset);
    assert.ok(headersEnd > 0, "header block must end");
    const length = Number(/content-length:\s*(\d+)/iu.exec(text.slice(offset, headersEnd))?.[1]);
    assert.ok(Number.isInteger(length), "every part carries a Content-Length");
    const bodyStart = headersEnd + 4;
    bodies.push(text.slice(bodyStart, bodyStart + length));
    offset = bodyStart + length;
    if (offset < text.length) {
      assert.equal(text.slice(offset, offset + 2), "\r\n", "a CRLF follows every body");
    }
  }
  return bodies;
}

function harness(boundary = "frame", options: { maxPartBytes?: number; maxHeaderBytes?: number } = {}) {
  const timers = new ManualTimers();
  const stream = repeatStillFrame(boundary, { idleMs: 100, timers, ...options });
  const out: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => out.push(chunk));
  const write = (chunk: Buffer | string) => stream.write(typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk);
  const output = () => Buffer.concat(out);
  return { timers, stream, write, output };
}

test("mjpegBoundary reads multipart/x-mixed-replace only, as the phone parsers do", () => {
  assert.equal(mjpegBoundary("multipart/x-mixed-replace; boundary=frame"), "frame");
  assert.equal(mjpegBoundary("Multipart/X-Mixed-Replace;BOUNDARY=\"--sim42\""), "sim42");
  assert.equal(mjpegBoundary("multipart/x-mixed-replace"), "frame");
  assert.equal(mjpegBoundary("multipart/x-mixed-replace; charset=binary; boundary=sim-42"), "sim-42");
  assert.equal(mjpegBoundary("image/jpeg"), null);
  assert.equal(mjpegBoundary("application/json; boundary=frame"), null);
  assert.equal(mjpegBoundary(undefined), null);
});

test("a still frame is repeated once after the idle delay, and only once", () => {
  const { timers, write, output } = harness();
  write(part("JPEG-1"));
  timers.advance(99);
  assert.deepEqual(parseMultipart(output()), ["JPEG-1"]);
  timers.advance(1);
  assert.deepEqual(parseMultipart(output()), ["JPEG-1", "JPEG-1"]);
  timers.advance(10_000);
  assert.deepEqual(parseMultipart(output()), ["JPEG-1", "JPEG-1"]);
  assert.equal(timers.size, 0);
});

test("the next still frame is repeated once too, and the output stays a valid stream", () => {
  const { timers, write, output } = harness();
  write(part("A"));
  timers.advance(100);
  write(part("B"));
  timers.advance(100);
  timers.advance(100);
  assert.deepEqual(parseMultipart(output()), ["A", "A", "B", "B"]);
});

test("frames arriving faster than the idle delay are never duplicated", () => {
  const { timers, write, output } = harness();
  for (const body of ["1", "2", "3", "4"]) {
    write(part(body));
    timers.advance(40);
  }
  assert.deepEqual(parseMultipart(output()), ["1", "2", "3", "4"]);
});

test("nothing is inserted into a part that is still arriving", () => {
  const { timers, write, output } = harness();
  write(part("FIRST"));
  const next = part("SECOND-FRAME");
  // The next part stalls mid-body when the idle delay passes.
  write(next.subarray(0, 50));
  timers.advance(500);
  assert.equal(Buffer.compare(output(), Buffer.concat([part("FIRST"), next.subarray(0, 50)])), 0);
  write(next.subarray(50));
  timers.advance(100);
  assert.deepEqual(parseMultipart(output()), ["FIRST", "SECOND-FRAME", "SECOND-FRAME"]);
});

test("a part split across many chunks, with its CRLF arriving late, still repeats as a valid part", () => {
  const { timers, write, output } = harness();
  const bytes = part(Buffer.from([0xff, 0xd8, 0x0d, 0x0a, 0x2d, 0x2d, 0xff, 0xd9]));
  // Byte by byte, holding back the trailing CRLF.
  for (let index = 0; index < bytes.length - 2; index += 1) write(bytes.subarray(index, index + 1));
  timers.advance(100);
  write(bytes.subarray(bytes.length - 2));
  write(part("NEXT"));
  const bodies = parseMultipart(output());
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(bodies[2], "NEXT");
});

test("a hub that sends the CRLF before each delimiter is followed too", () => {
  const { timers, write, output } = harness("sim42");
  const head = (body: string) => `--sim42\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
  write(head("A"));
  write(`\r\n${head("B")}`);
  timers.advance(100);
  write(`\r\n${head("C")}`);
  assert.deepEqual(parseMultipart(output(), "sim42"), ["A", "B", "B", "C"]);
});

test("unrecognized framing passes through byte for byte and is never repeated", () => {
  const cases = [
    // No Content-Length.
    "--frame\r\nContent-Type: image/jpeg\r\n\r\nJPEG\r\n",
    // A different boundary than the Content-Type named.
    part("JPEG", "other").toString("latin1"),
    // Not multipart at all.
    "HTTP garbage that is not a part",
  ];
  for (const input of cases) {
    const { timers, write, output } = harness();
    write(input);
    write(part("LATER"));
    timers.advance(1_000);
    assert.equal(output().toString("latin1"), input + part("LATER").toString("latin1"));
    assert.equal(timers.size, 0);
  }
});

test("a close delimiter stops tracking", () => {
  const { timers, write, output } = harness();
  write(part("A"));
  write("--frame--\r\n");
  timers.advance(1_000);
  assert.equal(output().toString("latin1"), `${part("A").toString("latin1")}--frame--\r\n`);
});

test("an oversized part or header block stops tracking and passes through", () => {
  const big = harness("frame", { maxPartBytes: 16 });
  big.write(part("x".repeat(17)));
  big.write(part("small"));
  big.timers.advance(1_000);
  assert.equal(Buffer.compare(big.output(), Buffer.concat([part("x".repeat(17)), part("small")])), 0);

  const headers = harness("frame", { maxHeaderBytes: 64 });
  const longHeader = `--frame\r\nX-Pad: ${"p".repeat(80)}\r\nContent-Length: 1\r\n\r\nA\r\n`;
  headers.write(longHeader);
  headers.timers.advance(1_000);
  assert.equal(headers.output().toString("latin1"), longHeader);
});

test("ending or destroying the stream clears the pending repeat", async () => {
  const ended = harness();
  ended.write(part("A"));
  assert.equal(ended.timers.size, 1);
  ended.stream.end();
  await new Promise((resolve) => ended.stream.once("end", resolve));
  assert.equal(ended.timers.size, 0);

  const destroyed = harness();
  destroyed.write(part("A"));
  destroyed.stream.destroy();
  await new Promise((resolve) => destroyed.stream.once("close", resolve));
  assert.equal(destroyed.timers.size, 0);
});

