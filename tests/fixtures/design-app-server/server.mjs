// A dev server stand-in for design mode's process tests: plain Node, no
// dependencies. It listens on --host/--port (or HOST/PORT), prints a
// Vite-style URL and answers 200. The --fake-* flags make it misbehave the
// ways real dev servers do.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import http from "node:http";

const args = process.argv.slice(2);
function option(name) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === `--${name}`) return args[index + 1];
    if (args[index].startsWith(`--${name}=`)) return args[index].slice(name.length + 3);
  }
  return undefined;
}
const has = (name) => args.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
const host = option("host") ?? process.env.HOST ?? "127.0.0.1";
const port = Number(option("port") ?? process.env.PORT ?? 5173);
const print = (shown) => console.log(`  ➜  Local:   http://127.0.0.1:${shown}/`);
const keepAlive = () => setInterval(() => {}, 1_000);

function listen(address, wanted, onListening) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  server.listen(wanted, address, () => onListening?.(server.address().port));
  return server;
}

function flood(bytes) {
  const chunk = `${"x".repeat(1023)}\n`;
  let left = bytes;
  const write = () => {
    while (left > 0) {
      left -= chunk.length;
      if (!process.stdout.write(chunk)) {
        process.stdout.once("drain", write);
        return;
      }
    }
  };
  write();
}

const inUseOnce = option("fake-in-use-once");
if (inUseOnce && !existsSync(inUseOnce)) {
  writeFileSync(inUseOnce, "");
  console.error(`Something is already running on port ${port}.`);
  process.exit(1);
} else if (has("fake-never-listen")) {
  keepAlive();
} else if (has("fake-chatty-never-listen")) {
  setInterval(() => console.log("compiling…"), 1_000);
} else if (has("fake-wildcard")) {
  listen("0.0.0.0", 0, () => print(port));
} else if (has("fake-other-port")) {
  listen(host, 0, () => print(port));
} else {
  listen(host, port, (bound) => {
    print(bound);
    const lateWildcard = option("fake-late-wildcard");
    if (lateWildcard) setTimeout(() => listen("0.0.0.0", 0), Number(lateWildcard));
    const crashAfter = option("fake-crash-after");
    if (crashAfter) {
      setTimeout(() => {
        console.error("Error: the fake server broke");
        process.exit(1);
      }, Number(crashAfter));
    }
    const floodBytes = option("fake-flood");
    if (floodBytes) flood(Number(floodBytes));
    if (has("fake-child")) {
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
      console.log(`child pid ${child.pid}`);
    }
    if (has("fake-setsid-child")) {
      // `detached` makes the child call setsid(): it leaves the job's process group.
      const child = spawn(process.execPath, ["-e", "require('node:net').createServer().listen(0, '0.0.0.0'); setInterval(() => {}, 1000)"], {
        stdio: "ignore",
        detached: true,
      });
      console.log(`setsid pid ${child.pid}`);
    }
  });
}
