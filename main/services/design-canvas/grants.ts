// Grants for the aiden-design scheme. A grant is a random token that main
// maps to one chat and that chat's workspace root, for this app run only.
// Nothing is persisted: a restart revokes everything.

import { randomBytes } from "node:crypto";
import path from "node:path";

/**
 * 32 random bytes as lowercase RFC 4648 base32 (52 characters). Chromium
 * lowercases the host of a standard scheme, so the token alphabet must be
 * case-free to survive the round trip through a frame's URL.
 */
const GRANT_PATTERN = /^[a-z2-7]{52}$/u;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export type DesignGrant = { chatId: string; workspaceRoot: string };

function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

export class DesignGrantRegistry {
  private readonly byGrant = new Map<string, DesignGrant>();
  private readonly byChat = new Map<string, string>();

  /** The chat's grant for `workspaceRoot`; a different root replaces (and revokes) the old grant. */
  issue(chatId: string, workspaceRoot: string): string {
    const existing = this.byChat.get(chatId);
    if (existing !== undefined) {
      if (this.byGrant.get(existing)?.workspaceRoot === workspaceRoot) return existing;
      this.byGrant.delete(existing);
    }
    let grant = base32(randomBytes(32));
    while (this.byGrant.has(grant)) grant = base32(randomBytes(32));
    this.byGrant.set(grant, { chatId, workspaceRoot });
    this.byChat.set(chatId, grant);
    return grant;
  }

  resolve(grant: string): DesignGrant | null {
    if (typeof grant !== "string" || !GRANT_PATTERN.test(grant)) return null;
    const entry = this.byGrant.get(grant);
    return entry ? { ...entry } : null;
  }

  revokeChat(chatId: string): void {
    const grant = this.byChat.get(chatId);
    if (grant === undefined) return;
    this.byChat.delete(chatId);
    this.byGrant.delete(grant);
  }

  /** Revokes every grant on `workspaceRoot`, as when its workspace is removed. */
  revokeRoot(workspaceRoot: string): void {
    const target = path.resolve(workspaceRoot);
    for (const [grant, entry] of this.byGrant) {
      if (path.resolve(entry.workspaceRoot) !== target) continue;
      this.byGrant.delete(grant);
      if (this.byChat.get(entry.chatId) === grant) this.byChat.delete(entry.chatId);
    }
  }

  revokeAll(): void {
    this.byGrant.clear();
    this.byChat.clear();
  }
}
