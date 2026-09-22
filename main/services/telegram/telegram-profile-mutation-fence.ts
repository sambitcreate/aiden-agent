export const TELEGRAM_PROFILE_CHANGED_MESSAGE =
  "The Telegram profile changed before the Bot connection finished. Try again.";

export interface TelegramProfileMutationAdmission {
  readonly profile: string;
  readonly incarnation: number;
  assertCurrent(): void;
}

/**
 * Serializes profile reset/delete against Bot binding and synchronously
 * invalidates an in-flight binding as soon as a destructive mutation begins.
 */
export class TelegramProfileMutationFence {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly incarnations = new Map<string, number>();

  private current(profile: string): number {
    return this.incarnations.get(profile) ?? 0;
  }

  private runSerialized<Result>(
    profile: string,
    action: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.tails.get(profile) ?? Promise.resolve();
    const result = previous.then(action, action);
    this.tails.set(profile, result);
    void result
      .finally(() => {
        if (this.tails.get(profile) === result) this.tails.delete(profile);
      })
      .catch(() => undefined);
    return result;
  }

  runBinding<Result>(
    profile: string,
    action: (admission: TelegramProfileMutationAdmission) => Promise<Result>,
  ): Promise<Result> {
    return this.runSerialized(profile, async () => {
      const incarnation = this.current(profile);
      const admission: TelegramProfileMutationAdmission = {
        profile,
        incarnation,
        assertCurrent: () => {
          if (this.current(profile) !== incarnation) {
            throw new Error(TELEGRAM_PROFILE_CHANGED_MESSAGE);
          }
        },
      };
      admission.assertCurrent();
      const result = await action(admission);
      admission.assertCurrent();
      return result;
    });
  }

  runDestructive<Result>(
    profile: string,
    action: () => Promise<Result>,
  ): Promise<Result> {
    // Invalidate before waiting for the serialized lane. An active binding
    // must not publish after reset/delete has already been requested.
    this.incarnations.set(profile, this.current(profile) + 1);
    return this.runSerialized(profile, action);
  }
}

export const telegramProfileMutationFence = new TelegramProfileMutationFence();
