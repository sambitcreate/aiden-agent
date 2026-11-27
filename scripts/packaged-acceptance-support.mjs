/* global Buffer, process */

import { readdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const DEFAULT_MAX_JSON_REQUEST_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_JSON_REQUEST_MESSAGE = "Acceptance model request exceeded 64 MiB.";

export function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export async function readJsonRequest(
  request,
  {
    limit = DEFAULT_MAX_JSON_REQUEST_BYTES,
    message = DEFAULT_MAX_JSON_REQUEST_MESSAGE,
  } = {},
) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error(message);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function writeSse(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

export function monitorChild(child) {
  let outcome = null;
  const promise = new Promise((resolve) => {
    child.once("error", (error) => {
      outcome = { error };
      resolve(outcome);
    });
    child.once("exit", (code, signal) => {
      if (outcome) return;
      outcome = { code, signal };
      resolve(outcome);
    });
  });
  return { promise, outcome: () => outcome };
}

export function commandMatchesExecutable(command, executable) {
  return command === executable || command.startsWith(`${executable} `);
}

export async function findApps(root) {
  const results = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory() && entry.name.endsWith(".app")) results.push(candidate);
    else if (entry.isDirectory()) results.push(...(await findApps(candidate)));
  }
  return results;
}

export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve a DevTools port.");
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
