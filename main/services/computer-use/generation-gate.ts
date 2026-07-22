export class ComputerUseGenerationGate {
  private revision = 0;

  snapshot(): number {
    return this.revision;
  }

  isCurrent(snapshot: number): boolean {
    return snapshot === this.revision;
  }

  close(): void {
    this.revision += 1;
  }
}

export function activatedComputerUseStreamIds(
  entries: Iterable<[string, { computerUse?: unknown }]>,
): string[] {
  return [...entries]
    .filter(([, entry]) => entry.computerUse !== undefined)
    .map(([streamId]) => streamId);
}

export class ChatComputerUseMutationGate {
  private readonly changing = new Set<string>();

  tryBegin(chatId: string, busy: boolean): (() => void) | null {
    if (busy || this.changing.has(chatId)) return null;
    this.changing.add(chatId);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.changing.delete(chatId);
    };
  }

  isChanging(chatId: string): boolean {
    return this.changing.has(chatId);
  }
}
