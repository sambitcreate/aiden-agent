import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, createDecipheriv, pbkdf2Sync } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync, backup } from "node:sqlite";
import type { CookiesSetDetails, Session } from "electron";
import type { BrowserImportResult, BrowserImportSource } from "../../../renderer/shared/browser.js";

const runFile = promisify(execFile);
type Source = BrowserImportSource & {
  engine: "chromium" | "firefox" | "safari";
  service?: string;
  account?: string;
  application?: string;
};
const sourceRegistry = new Map<string, Source>();
const chromiumDefinitions = [
  {
    id: "chrome",
    name: "Chrome",
    mac: ["Google", "Chrome"],
    linux: ["google-chrome"],
    service: "Chrome Safe Storage",
    account: "Chrome",
    application: "chrome",
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    mac: ["Microsoft Edge"],
    linux: ["microsoft-edge"],
    service: "Microsoft Edge Safe Storage",
    account: "Microsoft Edge",
    application: "msedge",
  },
  {
    id: "brave",
    name: "Brave",
    mac: ["BraveSoftware", "Brave-Browser"],
    linux: ["BraveSoftware", "Brave-Browser"],
    service: "Brave Safe Storage",
    account: "Brave",
    application: "brave",
  },
  {
    id: "vivaldi",
    name: "Vivaldi",
    mac: ["Vivaldi"],
    linux: ["vivaldi"],
    service: "Vivaldi Safe Storage",
    account: "Vivaldi",
    application: "vivaldi",
  },
  {
    id: "opera",
    name: "Opera",
    mac: ["com.operasoftware.Opera"],
    linux: ["opera"],
    service: "Opera Safe Storage",
    account: "Opera",
    application: "opera",
  },
  {
    id: "arc",
    name: "Arc",
    mac: ["Arc", "User Data"],
    linux: [],
    service: "Arc Safe Storage",
    account: "Arc",
    application: "",
  },
  {
    id: "helium",
    name: "Helium",
    mac: ["net.imput.helium"],
    linux: ["net.imput.helium"],
    service: "Helium Storage Key",
    account: "Helium",
    application: "chromium",
  },
];
async function exists(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}
function sourceId(browser: string, file: string): string {
  return `${browser}-${createHash("sha256").update(file).digest("hex").slice(0, 20)}`;
}
function register(source: Omit<Source, "id">): void {
  const id = sourceId(source.browser, source.path);
  sourceRegistry.set(id, { ...source, id });
}
async function runningBrowsers(): Promise<Set<string>> {
  const running = new Set<string>();
  const aliases: Record<string, string[]> = {
    Chrome: ["Google Chrome", "chrome", "google-chrome"],
    "Microsoft Edge": ["Microsoft Edge", "msedge"],
    Brave: ["Brave Browser", "brave", "brave-browser"],
    Vivaldi: ["Vivaldi", "vivaldi-bin"],
    Opera: ["Opera", "opera"],
    Arc: ["Arc"],
    Helium: ["Helium", "helium"],
    Safari: ["Safari"],
    Firefox: ["firefox", "Firefox"],
  };
  const output = await runFile(
    process.platform === "win32" ? "tasklist" : "/bin/ps",
    process.platform === "win32" ? ["/fo", "csv", "/nh"] : ["-axo", "comm="],
    { timeout: 5_000, maxBuffer: 2_000_000 },
  );
  const names = output.stdout
    .split(/\r?\n/)
    .map((line) => path.basename(line.trim()).toLowerCase());
  for (const [browser, executables] of Object.entries(aliases))
    if (
      executables.some((executable) =>
        names.some(
          (name) =>
            name === executable.toLowerCase() ||
            name.startsWith(`"${executable.toLowerCase()}.exe"`),
        ),
      )
    )
      running.add(browser);
  return running;
}

/** Listing only discovers known browser paths. It never reads credentials or cookie values. */
export async function browserImportSources(): Promise<BrowserImportSource[]> {
  sourceRegistry.clear();
  const home = os.homedir();
  if (process.platform === "darwin" || process.platform === "linux")
    for (const definition of chromiumDefinitions) {
      const parts = process.platform === "darwin" ? definition.mac : definition.linux;
      if (!parts.length) continue;
      const root = path.join(
        home,
        process.platform === "darwin" ? "Library/Application Support" : ".config",
        ...parts,
      );
      let profiles: Record<string, { name?: string }> = {};
      try {
        profiles =
          JSON.parse(await fs.readFile(path.join(root, "Local State"), "utf8")).profile
            ?.info_cache ?? {};
      } catch {
        /* This browser may not have a readable profile inventory. */
      }
      const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
      const names = new Set([
        "Default",
        ...Object.keys(profiles),
        ...entries
          .filter((e) => e.isDirectory() && /^Profile \d+$/.test(e.name))
          .map((e) => e.name),
        "",
      ]);
      for (const folder of names) {
        if (folder.includes("/") || folder.includes("\\") || folder === "..") continue;
        const candidate = [
          path.join(root, folder, "Network", "Cookies"),
          path.join(root, folder, "Cookies"),
        ];
        for (const file of candidate)
          if (await exists(file)) {
            register({
              browser: definition.name,
              profile: profiles[folder]?.name ?? folder ?? "Default",
              path: file,
              engine: "chromium",
              service: definition.service,
              account: definition.account,
              application: definition.application,
            });
            break;
          }
      }
    }
  const firefoxRoot =
    process.platform === "darwin"
      ? path.join(home, "Library/Application Support/Firefox")
      : process.platform === "win32"
        ? path.join(process.env.APPDATA ?? home, "Mozilla/Firefox")
        : path.join(home, ".mozilla/firefox");
  try {
    const ini = await fs.readFile(path.join(firefoxRoot, "profiles.ini"), "utf8");
    for (const section of ini.split(/(?=^\[)/m)) {
      const pairs = Object.fromEntries(
        section.split(/\r?\n/).flatMap((line) => {
          const index = line.indexOf("=");
          return index > 0 ? [[line.slice(0, index), line.slice(index + 1)]] : [];
        }),
      );
      if (!pairs.Path) continue;
      const folder = pairs.IsRelative === "0" ? pairs.Path : path.resolve(firefoxRoot, pairs.Path);
      const file = path.join(folder, "cookies.sqlite");
      if (await exists(file))
        register({
          browser: "Firefox",
          profile: pairs.Name ?? path.basename(folder),
          path: file,
          engine: "firefox",
        });
    }
  } catch {
    /* This browser may not have a readable profile inventory. */
  }
  if (process.platform === "darwin") {
    const container = path.join(home, "Library/Containers/com.apple.Safari/Data/Library");
    for (const file of [
      path.join(container, "Cookies/Cookies.binarycookies"),
      path.join(home, "Library/Cookies/Cookies.binarycookies"),
    ])
      if (await exists(file)) {
        register({ browser: "Safari", profile: "Default", path: file, engine: "safari" });
        break;
      }
  }
  const running = await runningBrowsers();
  for (const source of sourceRegistry.values()) source.running = running.has(source.browser);
  return [...sourceRegistry.values()].map(({ id, browser, profile, path: file, running }) => ({
    id,
    browser,
    profile: profile || "Default",
    path: file,
    running,
  }));
}

export function browserCookieScope(
  domain: string,
  cookiePath: string,
  secure: boolean,
): Pick<CookiesSetDetails, "url" | "domain" | "path"> {
  if (!domain || /[\s/:?#@\\]/.test(domain)) throw new Error("Invalid cookie domain.");
  const host = domain.startsWith(".") ? domain.slice(1) : domain;
  const pathname = cookiePath.startsWith("/") ? cookiePath : "/";
  return {
    url: `${secure ? "https" : "http"}://${host}${pathname}`,
    path: pathname,
    ...(domain.startsWith(".") ? { domain } : {}),
  };
}
export function decryptBrowserCookie(
  payload: Buffer,
  key: Buffer,
  domain: string,
  version: number,
): string | null {
  try {
    if (!["v10", "v11"].includes(payload.subarray(0, 3).toString())) return null;
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
    let plain = Buffer.concat([decipher.update(payload.subarray(3)), decipher.final()]);
    if (version >= 24) {
      const hash = createHash("sha256").update(domain).digest();
      if (plain.length < 32 || !plain.subarray(0, 32).equals(hash)) return null;
      plain = plain.subarray(32);
    }
    return plain.toString("utf8");
  } catch {
    return null;
  }
}
export function firefoxCookieExpiry(expiry: number, version: number): number | undefined {
  return expiry > 0 ? (version >= 16 ? Math.floor(expiry / 1000) : expiry) : undefined;
}
export function firefoxCookieSameSite(
  value: unknown,
  rawValue: unknown,
): CookiesSetDetails["sameSite"] {
  if (value === null || (value === 1 && rawValue === 0)) return "unspecified";
  return value === 0
    ? "no_restriction"
    : value === 1
      ? "lax"
      : value === 2
        ? "strict"
        : "unspecified";
}
async function encryptionKey(source: Source): Promise<Buffer> {
  // Keychain access is reached exclusively by the explicit Import action.
  if (process.platform === "darwin") {
    try {
      const result = await runFile(
        "/usr/bin/security",
        ["find-generic-password", "-s", source.service!, "-a", source.account!, "-w"],
        { timeout: 30_000, maxBuffer: 16_384 },
      );
      return pbkdf2Sync(result.stdout.replace(/\r?\n$/, ""), "saltysalt", 1003, 16, "sha1");
    } catch {
      throw new Error(
        `Allow Aiden to read ${source.browser}'s Safe Storage key in the macOS Keychain, then try importing again.`,
      );
    }
  }
  try {
    const result = await runFile("secret-tool", ["lookup", "application", source.application!], {
      timeout: 30_000,
      maxBuffer: 16_384,
    });
    if (!result.stdout.trim()) throw new Error("No key");
    return pbkdf2Sync(result.stdout.replace(/\r?\n$/, ""), "saltysalt", 1, 16, "sha1");
  } catch {
    throw new Error(
      `${source.browser}'s cookie key is unavailable from the desktop credential store.`,
    );
  }
}

export function parseSafariCookies(buffer: Buffer): CookiesSetDetails[] {
  const invalid = () => {
    throw new Error("Safari's cookie file is malformed.");
  };
  if (buffer.length < 8 || buffer.toString("latin1", 0, 4) !== "cook") return invalid();
  const count = buffer.readUInt32BE(4);
  if (count > 10_000 || 8 + count * 4 > buffer.length) return invalid();
  const cookies: CookiesSetDetails[] = [];
  let start = 8 + count * 4;
  for (let i = 0; i < count; i++) {
    const size = buffer.readUInt32BE(8 + i * 4);
    if (size < 12 || start + size > buffer.length) return invalid();
    const page = buffer.subarray(start, start + size);
    start += size;
    const records = page.readUInt32LE(4),
      tableEnd = 12 + records * 4;
    if (tableEnd > page.length) return invalid();
    const accepted: Array<[number, number]> = [];
    for (let j = 0; j < records; j++) {
      const offset = page.readUInt32LE(8 + j * 4);
      if (offset < tableEnd || offset + 56 > page.length) return invalid();
      const recordSize = page.readUInt32LE(offset),
        end = offset + recordSize;
      if (recordSize < 56 || end > page.length || accepted.some(([a, b]) => offset < b && end > a))
        return invalid();
      accepted.push([offset, end]);
      const record = page.subarray(offset, end);
      const read = (position: number) => {
        const field = record.readUInt32LE(position);
        if (field < 56 || field >= record.length) return invalid();
        const end = record.indexOf(0, field);
        if (end < 0) return invalid();
        return record.toString("utf8", field, end);
      };
      const domain = read(16),
        name = read(20),
        cookiePath = read(24),
        value = read(28),
        flags = record.readUInt32LE(8),
        expires = record.readDoubleLE(40);
      if (!domain || !name) continue;
      if (!Number.isFinite(expires)) return invalid();
      const secure = (flags & 1) !== 0;
      cookies.push({
        ...browserCookieScope(domain, cookiePath, secure),
        name,
        value,
        secure,
        httpOnly: (flags & 4) !== 0,
        sameSite: "lax",
        ...(expires > 0 ? { expirationDate: Math.floor(expires) + 978_307_200 } : {}),
      });
    }
  }
  const trailer = buffer.length - start;
  if (
    trailer !== 0 &&
    trailer !== 8 &&
    !(trailer >= 12 && trailer === 12 + buffer.readUInt32BE(start + 8))
  )
    return invalid();
  return cookies;
}

export async function readBrowserCookieDatabase(
  source: Source,
): Promise<{ cookies: CookiesSetDetails[]; skipped: number }> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-browser-import-"));
  await fs.chmod(temporary, 0o700);
  let original: DatabaseSync | undefined;
  let database: DatabaseSync | undefined;
  try {
    // SQLite backup reads a consistent transaction including WAL; copying only Cookies would lose recent logins.
    original = new DatabaseSync(source.path, { readOnly: true });
    const target = path.join(temporary, "cookies.sqlite");
    await backup(original, target);
    original.close();
    original = undefined;
    database = new DatabaseSync(target, { readOnly: true });
    const cookies: CookiesSetDetails[] = [];
    let skipped = 0;
    if (source.engine === "firefox") {
      const columns = database
        .prepare("PRAGMA table_info(moz_cookies)")
        .all()
        .map((r) => r.name);
      const version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
      if (!columns.includes("originAttributes"))
        throw new Error("Firefox's cookie schema is unsupported.");
      const rows = database
        .prepare(
          `SELECT host,name,value,path,expiry,isSecure,isHttpOnly,sameSite,${columns.includes("rawSameSite") ? "rawSameSite" : "null AS rawSameSite"} FROM moz_cookies WHERE originAttributes = '' LIMIT 50000`,
        )
        .all();
      for (const row of rows) {
        try {
          const secure = Number(row.isSecure) === 1;
          const expiry = firefoxCookieExpiry(Number(row.expiry), version);
          cookies.push({
            ...browserCookieScope(String(row.host), String(row.path), secure),
            name: String(row.name),
            value: String(row.value),
            secure,
            httpOnly: Number(row.isHttpOnly) === 1,
            sameSite: firefoxCookieSameSite(
              row.sameSite,
              version >= 10 && version <= 14 ? row.rawSameSite : null,
            ),
            ...(expiry ? { expirationDate: expiry } : {}),
          });
        } catch {
          skipped++;
        }
      }
    } else {
      const version = Number(
        database.prepare("SELECT value FROM meta WHERE key='version'").get()?.value ?? 0,
      );
      const columns = database
        .prepare("PRAGMA table_info(cookies)")
        .all()
        .map((row) => row.name);
      const rows = database
        .prepare(
          `SELECT host_key,name,value,encrypted_value,path,CAST(expires_utc/1000000 AS REAL) AS expires_seconds,is_secure,is_httponly,samesite,${columns.includes("top_frame_site_key") ? "top_frame_site_key" : "'' AS top_frame_site_key"} FROM cookies LIMIT 50000`,
        )
        .all();
      const needsKey = rows.some((row) => {
        const payload = Buffer.from(row.encrypted_value as Uint8Array);
        return (
          payload.length > 0 &&
          (process.platform !== "linux" || payload.subarray(0, 3).toString() === "v11")
        );
      });
      const key = needsKey ? await encryptionKey(source) : undefined;
      const legacyLinuxKey =
        process.platform === "linux"
          ? pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1")
          : undefined;
      try {
        for (const row of rows) {
          if (row.top_frame_site_key) {
            skipped++;
            continue;
          }
          try {
            const domain = String(row.host_key),
              payload = Buffer.from(row.encrypted_value as Uint8Array);
            const rowKey =
              legacyLinuxKey && payload.subarray(0, 3).toString() === "v10" ? legacyLinuxKey : key;
            const value = payload.length
              ? decryptBrowserCookie(payload, rowKey!, domain, version)
              : String(row.value);
            if (value === null) {
              skipped++;
              continue;
            }
            const secure = Number(row.is_secure) === 1;
            const expiry = Number(row.expires_seconds) - 11_644_473_600;
            const sameSite = Number(row.samesite);
            cookies.push({
              ...browserCookieScope(domain, String(row.path), secure),
              name: String(row.name),
              value,
              secure,
              httpOnly: Number(row.is_httponly) === 1,
              sameSite:
                sameSite === 0
                  ? "no_restriction"
                  : sameSite === 1
                    ? "lax"
                    : sameSite === 2
                      ? "strict"
                      : "unspecified",
              ...(expiry > 0 ? { expirationDate: expiry } : {}),
            });
          } catch {
            skipped++;
          }
        }
      } finally {
        key?.fill(0);
        legacyLinuxKey?.fill(0);
      }
    }
    return { cookies, skipped };
  } finally {
    original?.close();
    database?.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export async function importBrowserCookies(
  sourceId: string,
  target: Pick<Session, "cookies">,
): Promise<BrowserImportResult> {
  // Refresh known sources and resolve the opaque ID. Renderer-supplied paths never reach file IO.
  await browserImportSources();
  const source = sourceRegistry.get(sourceId);
  if (!source) throw new Error("The selected browser profile is no longer available.");
  if (source.running)
    throw new Error(`Quit ${source.browser} before importing its cookies, then try again.`);
  let read: { cookies: CookiesSetDetails[]; skipped: number };
  try {
    read =
      source.engine === "safari"
        ? { cookies: parseSafariCookies(await fs.readFile(source.path)), skipped: 0 }
        : await readBrowserCookieDatabase(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EPERM" && source.engine === "safari")
      throw new Error(
        "Safari cookie access requires Full Disk Access for Aiden in System Settings. Grant it and retry importing.",
      );
    throw error;
  }
  let imported = 0,
    skipped = read.skipped;
  for (const cookie of read.cookies) {
    if (cookie.expirationDate && cookie.expirationDate < Date.now() / 1000) {
      skipped++;
      continue;
    }
    try {
      await target.cookies.set(cookie);
      imported++;
    } catch {
      skipped++;
    }
  }
  await target.cookies.flushStore();
  return {
    imported,
    skipped,
    warnings: skipped ? ["Some expired, partitioned, or unsupported cookies were skipped."] : [],
  };
}
