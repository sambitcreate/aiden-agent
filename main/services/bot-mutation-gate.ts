/** Serialize bot lifecycle mutations with operations that mint bot-bound chats. */
export class BotMutationGate {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(botId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(botId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    this.tails.set(botId, result);
    return result;
  }
}

export const botMutationGate = new BotMutationGate();
