// A package manager stand-in for design mode's process tests. `install` and
// `ci` write node_modules/.fake-installed and exit with FAKE_INSTALL_EXIT
// (default 0); `install`, like npm's, also writes package-lock.json when there
// is none. `run <script> [--] args…` runs the package.json script with
// `sh -c`, the args appended, as npm does.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [command, ...rest] = process.argv.slice(2);
if (command === "install" || command === "ci") {
  mkdirSync("node_modules", { recursive: true });
  writeFileSync(path.join("node_modules", ".fake-installed"), `${command}\n`);
  if (command === "install" && !existsSync("package-lock.json")) {
    writeFileSync("package-lock.json", `${JSON.stringify({ name: "fixture", lockfileVersion: 3, packages: {} }, null, 2)}\n`);
  }
  console.log(`fake-pm ${command}: added 0 packages`);
  process.exit(Number(process.env.FAKE_INSTALL_EXIT ?? 0));
} else if (command === "run") {
  const [script, ...extra] = rest;
  const scriptArgs = extra[0] === "--" ? extra.slice(1) : extra;
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const text = pkg.scripts?.[script];
  if (typeof text !== "string") {
    console.error(`Missing script: "${script}"`);
    process.exit(1);
  }
  const child = spawn("sh", ["-c", `${text} "$@"`, "sh", ...scriptArgs], {
    stdio: "inherit",
    env: { ...process.env, PATH: `${path.resolve("node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}` },
  });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  console.error(`fake-pm: unknown command ${command}`);
  process.exit(2);
}
