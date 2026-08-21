// Late-bound direct delivery runtime avoids coupling generic tool assembly to the Telegram service graph.

export interface TelegramDirectRuntime {
  listProfiles(): Promise<readonly { name: string; hasToken: boolean; settings: { allowedUserId?: number } }[]>;
  listTargets(profile?: string): Promise<readonly { threadId: number; name: string; workspaceId?: string }[]>;
  sendDirectMessage(input: { profile?: string; thread?: string | number; text: string }): Promise<unknown>;
  sendDirectAttachment(input: { profile?: string; thread?: string | number; path: string; caption?: string }): Promise<unknown>;
  sendDirectVoice(input: { profile?: string; thread?: string | number; text: string; lang?: string; rate?: string }): Promise<unknown>;
}

let runtime: TelegramDirectRuntime | undefined;

export function registerTelegramDirectRuntime(value: TelegramDirectRuntime): () => void {
  runtime = value;
  return () => {
    if (runtime === value) runtime = undefined;
  };
}

export function getTelegramDirectRuntime(): TelegramDirectRuntime | undefined {
  return runtime;
}
