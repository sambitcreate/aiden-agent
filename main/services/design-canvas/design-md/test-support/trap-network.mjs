/* global process */
// Test preload: traps every network and subprocess entry point and logs each
// resolved module URL, per thread, to the file named by AIDEN_TEST_TRAP_LOG.
// It proves the DESIGN.md lint worker stays offline and loads only the linter.
import { appendFileSync } from "node:fs";
import childProcess from "node:child_process";
import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { threadId } from "node:worker_threads";

const logFile = process.env.AIDEN_TEST_TRAP_LOG;
const log = (line) => {
  if (logFile) appendFileSync(logFile, `${line}\n`);
};

function trap(target, name, label) {
  if (typeof target[name] !== "function") return;
  target[name] = function trapped() {
    log(`call ${threadId} ${label}.${name}`);
    throw new Error(`${label}.${name} is not allowed here`);
  };
}

globalThis.fetch = function trappedFetch() {
  log(`call ${threadId} fetch`);
  throw new Error("fetch is not allowed here");
};
for (const name of ["request", "get"]) {
  trap(http, name, "http");
  trap(https, name, "https");
}
for (const name of ["connect", "createConnection", "createServer"]) trap(net, name, "net");
trap(tls, "connect", "tls");
trap(dgram, "createSocket", "dgram");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  trap(childProcess, name, "child_process");
}
syncBuiltinESMExports();

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    log(`resolve ${threadId} ${result.url}`);
    return result;
  },
});

log(`installed ${threadId}`);
