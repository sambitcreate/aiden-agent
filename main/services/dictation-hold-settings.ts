/** Fence an explicit desktop bind against newer Settings mutations. */
export class DictationHoldSettingsTransaction {
  private revision = 0;
  constructor(private readonly portal: {
    active(): boolean;
    bind(): Promise<unknown>;
    disable(): Promise<void>;
  }) {}

  async apply<T>(hold: boolean, persist: (isCurrent: () => boolean) => Promise<T>): Promise<T> {
    const revision = ++this.revision;
    const newlyBound = hold && !this.portal.active();
    if (newlyBound) await this.portal.bind();
    if (revision !== this.revision) throw new Error("Dictation shortcut settings changed during setup.");
    let result: T;
    try { result = await persist(() => revision === this.revision); } catch (error) {
      if (newlyBound && revision === this.revision) await this.portal.disable();
      throw error;
    }
    if (!hold && revision === this.revision) await this.portal.disable();
    return result;
  }
}
