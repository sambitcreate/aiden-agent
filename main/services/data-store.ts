// Generic JSON file store rooted in the app's userData directory.
// Persistent app data belongs in the operating system's user-data directory.

import * as fs from "fs/promises";
import * as path from "path";
import { app } from "../platform.js";

export class DataStore<T> {
  private cache: T | null = null;
  private filePath: string | null = null;

  constructor(
    private readonly filename: string,
    private readonly defaultValue: T,
  ) {}

  private async getFilePath(): Promise<string> {
    if (!this.filePath) {
      const userDataPath = app.getPath("userData");
      await fs.mkdir(userDataPath, { recursive: true });
      this.filePath = path.join(userDataPath, this.filename);
    }
    return this.filePath;
  }

  async load(): Promise<T> {
    if (this.cache !== null) return this.cache;
    try {
      const filePath = await this.getFilePath();
      const data = await fs.readFile(filePath, "utf-8");
      this.cache = JSON.parse(data) as T;
    } catch {
      this.cache = structuredClone(this.defaultValue);
    }
    return this.cache;
  }

  async save(data: T): Promise<void> {
    this.cache = data;
    const filePath = await this.getFilePath();
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }
}

/** Returns the userData subdirectory (created if missing) — used by the chat store. */
export async function ensureUserDataDir(...segments: string[]): Promise<string> {
  const dir = path.join(app.getPath("userData"), ...segments);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
