import { randomUUID } from "node:crypto";
import { request } from "node:http";
import * as fs from "node:fs/promises";
import path from "node:path";
import { parseAidenRemoteJson } from "./aiden-remote-protocol.js";
import {
  withAidenTailscaleRouteLock,
  createSystemTailscaleCommandRunner,
  type AidenTailscaleCommandRunner,
} from "./aiden-remote-tailscale.js";

export interface TailscalePreviewRecord {
  id: string;
  workspaceId: string;
  localPort: number;
  exposedPort: number;
  dnsName: string;
  phase: "opening" | "active" | "stopping";
  createdAt: number;
}
export interface TailscalePreview extends Omit<
  TailscalePreviewRecord,
  "phase"
> {
  url: string;
  /** Active verifies the private Serve configuration, not end-to-end tailnet reachability. */
  status: "active" | "missing" | "changed";
}
export interface TailscalePreviewStore {
  read(): Promise<TailscalePreviewRecord[]>;
  /** Atomically replace the journal. Called under the shared cross-process route lock. */
  write(records: TailscalePreviewRecord[]): Promise<void>;
}
export interface TailscalePreviewOptions {
  runner: AidenTailscaleCommandRunner;
  store: TailscalePreviewStore;
  lock?: <T>(action: () => Promise<T>) => Promise<T>;
  probe?: (localPort: number) => Promise<boolean>;
  protectedLocalPorts?: () => Promise<readonly number[]>;
}
export class TailscalePreviewError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "not_connected"
      | "conflict"
      | "not_found"
      | "server_unreachable"
      | "outcome_unknown",
    message: string,
  ) {
    super(message);
    this.name = "TailscalePreviewError";
  }
}
const fail = (code: TailscalePreviewError["code"], message: string): never => {
  throw new TailscalePreviewError(code, message);
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const port = (value: unknown): value is number =>
  Number.isInteger(value) &&
  (value as number) >= 1024 &&
  (value as number) <= 65535;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const dns = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 253 &&
  value.endsWith(".ts.net") &&
  value.split(".").length >= 4 &&
  value
    .split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label));
const target = (row: TailscalePreviewRecord) =>
  `http://127.0.0.1:${row.localPort}`;
function json(raw: string): Record<string, unknown> {
  if (Buffer.byteLength(raw) > 1024 * 1024)
    return fail("conflict", "Tailscale status is too large to inspect safely.");
  const value = parseAidenRemoteJson(raw, "Tailscale preview status");
  if (!object(value))
    return fail("conflict", "Tailscale status is unavailable.");
  return value;
}
function stable(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : object(v)
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, sort(x)]),
          )
        : v;
  return JSON.stringify(sort(value));
}
function map(
  config: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const value = config[field];
  if (value === undefined || value === null) return {};
  if (!object(value))
    return fail(
      "conflict",
      "Tailscale configuration cannot be safely inspected.",
    );
  return value;
}
/** Inspect every authority, including foreground sessions; unknown aliases fail closed. */
function selected(
  config: Record<string, unknown>,
  exposedPort: number,
  depth = 0,
): {
  tcp: unknown;
  web: Array<[string, unknown]>;
  funnel: boolean;
  foreground: boolean;
} {
  if (depth > 1)
    return fail(
      "conflict",
      "Nested Tailscale foreground configuration is unsupported.",
    );
  const tcp = map(config, "TCP");
  for (const key of Object.keys(tcp))
    if (!/^[1-9][0-9]{0,4}$/u.test(key) || Number(key) > 65535)
      return fail("conflict", "Ambiguous Tailscale listener port.");
  const onPort = (key: string): boolean => {
    const match = /^(?:\[[0-9a-f:]+\]|[A-Za-z0-9.-]+):([1-9][0-9]{0,4})$/u.exec(
      key,
    );
    if (!match || Number(match[1]) > 65535)
      return fail("conflict", "Ambiguous Tailscale listener authority.");
    return Number(match[1]) === exposedPort;
  };
  const web = Object.entries(map(config, "Web")).filter(([key]) => onPort(key));
  const funnel = Object.entries(map(config, "AllowFunnel")).some(
    ([key, value]) => onPort(key) && value !== false,
  );
  let foreground = false;
  for (const child of Object.values(map(config, "Foreground"))) {
    if (!object(child))
      return fail("conflict", "Invalid Tailscale foreground configuration.");
    const entry = selected(child, exposedPort, depth + 1);
    foreground ||=
      entry.tcp !== undefined ||
      entry.web.length > 0 ||
      entry.funnel ||
      entry.foreground;
  }
  return { tcp: tcp[String(exposedPort)], web, funnel, foreground };
}
function routeState(
  config: Record<string, unknown>,
  row: TailscalePreviewRecord,
): TailscalePreview["status"] {
  const entry = selected(config, row.exposedPort);
  if (
    entry.tcp === undefined &&
    entry.web.length === 0 &&
    !entry.funnel &&
    !entry.foreground
  )
    return "missing";
  if (
    entry.funnel ||
    entry.foreground ||
    stable(entry.tcp) !== stable({ HTTP: true }) ||
    entry.web.length !== 1
  )
    return "changed";
  return entry.web[0]![0] === `${row.dnsName}:${row.exposedPort}` &&
    stable(entry.web[0]![1]) ===
      stable({ Handlers: { "/": { Proxy: target(row) } } })
    ? "active"
    : "changed";
}
/** Remove only the exact selected slot to compare all unrelated configuration. */
function preserved(
  config: Record<string, unknown>,
  row: TailscalePreviewRecord,
): string {
  const copy = structuredClone(config);
  for (const field of ["TCP", "Web", "AllowFunnel"]) {
    if (copy[field] == null) {
      delete copy[field];
      continue;
    }
    const values = map(copy, field);
    delete values[
      field === "TCP"
        ? String(row.exposedPort)
        : `${row.dnsName}:${row.exposedPort}`
    ];
    if (!Object.keys(values).length) delete copy[field];
  }
  return stable(copy);
}
async function probe(localPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (value: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      req.destroy();
      resolve(value);
    };
    const req = request(
      {
        hostname: "127.0.0.1",
        port: localPort,
        path: "/",
        method: "HEAD",
        agent: false,
      },
      (res) => {
        res.destroy();
        finish(true);
      },
    );
    // Absolute deadline also bounds a server that dribbles partial response headers.
    const deadline = setTimeout(() => finish(false), 1500);
    deadline.unref();
    req.once("error", () => finish(false));
    req.end();
  });
}

/** Exact private HTTP routes only. Never calls Funnel, reset, set-config, or a shell. */
export class TailscalePreviewService {
  private readonly lock: NonNullable<TailscalePreviewOptions["lock"]>;
  constructor(private readonly options: TailscalePreviewOptions) {
    this.lock = options.lock ?? withAidenTailscaleRouteLock;
  }
  private async rows(): Promise<TailscalePreviewRecord[]> {
    const rows = await this.options.store.read();
    if (
      !Array.isArray(rows) ||
      rows.length > 128 ||
      rows.some(
        (row) =>
          !object(row) ||
          !identifier(row.id) ||
          !identifier(row.workspaceId) ||
          !port(row.localPort) ||
          !port(row.exposedPort) ||
          !dns(row.dnsName) ||
          !["opening", "active", "stopping"].includes(row.phase) ||
          !Number.isSafeInteger(row.createdAt),
      )
    )
      return fail("conflict", "The preview ownership journal is invalid.");
    if (
      new Set(rows.map((row) => row.id)).size !== rows.length ||
      new Set(rows.map((row) => row.exposedPort)).size !== rows.length
    )
      return fail("conflict", "The preview ownership journal is ambiguous.");
    return structuredClone(rows);
  }
  private async node(): Promise<string> {
    const value = json(
      await this.options.runner.run(["status", "--json", "--peers=false"]),
    );
    const self = object(value.Self) ? value.Self : {};
    const host =
      typeof self.DNSName === "string"
        ? self.DNSName.replace(/\.$/u, "").toLowerCase()
        : undefined;
    if (value.BackendState !== "Running" || self.Online === false || !dns(host))
      return fail(
        "not_connected",
        "Connect this Mac to Tailscale before exposing a preview.",
      );
    return host;
  }
  private async config(): Promise<Record<string, unknown>> {
    return json(await this.options.runner.run(["serve", "status", "--json"]));
  }
  private view(
    row: TailscalePreviewRecord,
    config: Record<string, unknown>,
  ): TailscalePreview {
    const { phase: _phase, ...publicRow } = row;
    return {
      ...publicRow,
      url: `http://${row.dnsName}:${row.exposedPort}/`,
      status: routeState(config, row),
    };
  }
  async list(workspaceId: string): Promise<TailscalePreview[]> {
    if (!identifier(workspaceId))
      return fail("invalid_request", "Invalid workspace.");
    return this.lock(async () => {
      const rows = await this.rows();
      const host = await this.node();
      const config = await this.config();
      return rows
        .filter((row) => row.workspaceId === workspaceId)
        .map((row) => ({
          ...this.view(row, config),
          ...(row.dnsName !== host ? { status: "changed" as const } : {}),
        }));
    });
  }
  async open(
    workspaceId: string,
    input: { localPort: number; exposedPort?: number },
    beforeEffect: () => void | Promise<void> = () => {},
  ): Promise<TailscalePreview> {
    if (
      !identifier(workspaceId) ||
      !object(input) ||
      Object.keys(input).some(
        (k) => !["localPort", "exposedPort"].includes(k),
      ) ||
      !port(input.localPort) ||
      !port(input.exposedPort ?? input.localPort)
    )
      return fail(
        "invalid_request",
        "Use local and exposed ports from 1024 to 65535.",
      );
    const exposedPort = input.exposedPort ?? input.localPort;
    return this.lock(async () => {
      const rows = await this.rows();
      const dnsName = await this.node();
      const config = await this.config();
      await beforeEffect();
      const protectedPorts = await this.options.protectedLocalPorts?.();
      if (
        protectedPorts?.includes(input.localPort) ||
        protectedPorts?.includes(exposedPort)
      )
        return fail(
          "invalid_request",
          "This internal Aiden listener cannot be exposed as a website.",
        );
      const old = rows.find((row) => row.exposedPort === exposedPort);
      if (old) {
        if (
          old.workspaceId === workspaceId &&
          old.localPort === input.localPort &&
          old.dnsName === dnsName &&
          old.phase !== "stopping" &&
          routeState(config, old) === "active"
        )
          return this.view(old, config);
        return fail(
          "conflict",
          "This preview port already has an owner or an unresolved operation. List or stop it first.",
        );
      }
      if (rows.length >= 128)
        return fail(
          "conflict",
          "Stop an existing preview before opening another.",
        );
      const row: TailscalePreviewRecord = {
        id: `preview_${randomUUID()}`,
        workspaceId,
        localPort: input.localPort,
        exposedPort,
        dnsName,
        phase: "opening",
        createdAt: Date.now(),
      };
      if (routeState(config, row) !== "missing")
        return fail(
          "conflict",
          "This Tailscale port is already configured. Choose another exposed port; existing routes will not be overwritten.",
        );
      if (!(await (this.options.probe ?? probe)(input.localPort)))
        return fail(
          "server_unreachable",
          "Start an HTTP server on the requested Mac localhost port first.",
        );
      await beforeEffect();
      await this.options.store.write([...rows, row]);
      // Recheck after durable journal I/O: the shared lock serializes cooperating Aiden processes.
      const latest = await this.config();
      await beforeEffect();
      if (stable(latest) !== stable(config))
        return fail(
          "conflict",
          "Tailscale configuration changed before preview setup. No route was changed.",
        );
      let commandFailed = false;
      try {
        await this.options.runner.run([
          "serve",
          "--yes",
          "--bg",
          `--http=${exposedPort}`,
          "--set-path=/",
          target(row),
        ]);
      } catch {
        commandFailed = true;
      }
      let after: Record<string, unknown>;
      try {
        after = await this.config();
      } catch {
        return fail(
          "outcome_unknown",
          "Preview setup could not be verified. The journal is retained; list previews before retrying.",
        );
      }
      if (
        routeState(after, row) !== "active" ||
        preserved(after, row) !== preserved(config, row)
      ) {
        if (
          routeState(after, row) === "missing" &&
          preserved(after, row) === preserved(config, row)
        )
          await this.options.store.write(rows);
        return fail(
          commandFailed ? "outcome_unknown" : "conflict",
          "Preview setup did not produce the expected isolated route. Existing configuration was not reset.",
        );
      }
      row.phase = "active";
      await this.options.store.write([...rows, row]);
      await beforeEffect();
      return this.view(row, after);
    });
  }
  async stop(
    workspaceId: string,
    input: { id: string },
    beforeEffect: () => void | Promise<void> = () => {},
  ): Promise<{ stopped: true }> {
    if (
      !identifier(workspaceId) ||
      !object(input) ||
      Object.keys(input).some((k) => k !== "id") ||
      !identifier(input.id)
    )
      return fail("invalid_request", "Invalid preview identifier.");
    return this.lock(async () => {
      const rows = await this.rows();
      const row = rows.find(
        (row) => row.id === input.id && row.workspaceId === workspaceId,
      );
      if (!row)
        return fail(
          "not_found",
          "No preview owned by this workspace has that identifier.",
        );
      const host = await this.node();
      const config = await this.config();
      await beforeEffect();
      if (host !== row.dnsName)
        return fail(
          "conflict",
          "The Mac's Tailscale identity changed; the old route will not be modified.",
        );
      const state = routeState(config, row);
      if (state === "missing") {
        await this.options.store.write(rows.filter((r) => r.id !== row.id));
        return { stopped: true };
      }
      if (state !== "active")
        return fail(
          "conflict",
          "This route changed outside Aiden and will not be stopped.",
        );
      row.phase = "stopping";
      await this.options.store.write(rows);
      const latest = await this.config();
      await beforeEffect();
      if (stable(latest) !== stable(config))
        return fail(
          "conflict",
          "Tailscale configuration changed before stopping. No route was changed.",
        );
      try {
        await this.options.runner.run([
          "serve",
          "--yes",
          "--bg",
          `--http=${row.exposedPort}`,
          "--set-path=/",
          "off",
        ]);
      } catch {
        /* Verify effect even if CLI exits after committing. */
      }
      let after: Record<string, unknown>;
      try {
        after = await this.config();
      } catch {
        return fail(
          "outcome_unknown",
          "Preview stop could not be verified. Its ownership journal is retained.",
        );
      }
      if (
        routeState(after, row) !== "missing" ||
        preserved(after, row) !== preserved(config, row)
      )
        return fail(
          "outcome_unknown",
          "Preview stop did not match the expected route removal. No configuration was reset.",
        );
      await this.options.store.write(rows.filter((r) => r.id !== row.id));
      return { stopped: true };
    });
  }
}

let singleton: Promise<TailscalePreviewService> | undefined;
/** Lazy: importing the service in unit tests or an unused tool never loads Electron or runs Tailscale. */
export function getTailscalePreviewService(): Promise<TailscalePreviewService> {
  singleton ??= (async () => {
    const { app } = await import("../platform.js");
    const runner = await createSystemTailscaleCommandRunner();
    if (!runner)
      return fail(
        "not_connected",
        "Install and connect Tailscale on this Mac first.",
      );
    const directory = path.join(app.getPath("userData"), "tailscale-previews");
    const file = path.join(directory, "routes.json");
    const ensureDirectory = async () => {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("The preview journal directory is unsafe.");
    };
    const store: TailscalePreviewStore = {
      read: async () => {
        await ensureDirectory();
        try {
          const stat = await fs.lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024)
            throw new Error("The preview journal is invalid.");
          return parseAidenRemoteJson(
            await fs.readFile(file, "utf8"),
            "Preview journal",
          ) as TailscalePreviewRecord[];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
      },
      write: async (rows) => {
        await ensureDirectory();
        const temporary = path.join(directory, `${randomUUID()}.tmp`);
        const handle = await fs.open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(rows));
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await fs.rename(temporary, file);
          const dir = await fs.open(directory, "r");
          try {
            await dir.sync();
          } finally {
            await dir.close();
          }
        } finally {
          await fs.rm(temporary, { force: true });
        }
      },
    };
    return new TailscalePreviewService({
      runner,
      store,
      protectedLocalPorts: async () => {
        const { getAidenRemoteRuntime } =
          await import("./aiden-remote-service-main.js");
        const { lanPort } = await (
          await getAidenRemoteRuntime()
        ).state.snapshot();
        // Include both isolated profile port ranges, plus any operator-selected live pair.
        return [
          lanPort,
          lanPort === 65535 ? 49221 : lanPort + 1,
          ...Array.from({ length: 128 }, (_, index) => 49220 + index),
          ...Array.from({ length: 128 }, (_, index) => 50220 + index),
        ];
      },
    });
  })().catch((error) => {
    singleton = undefined;
    throw error;
  });
  return singleton;
}
