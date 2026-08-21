export interface ProviderEditorFocusElement {
  readonly isConnected: boolean;
  focus(): void;
}

/**
 * One-shot return-focus target for a custom-provider editor. Capturing every
 * open path and consuming on close prevents an earlier Configure button from
 * stealing focus after a later Add-provider flow.
 */
export class ProviderEditorFocusTarget {
  #target: ProviderEditorFocusElement | null = null;

  capture(target: ProviderEditorFocusElement | null): void {
    this.#target = target;
  }

  take(): ProviderEditorFocusElement | null {
    const target = this.#target;
    this.#target = null;
    return target?.isConnected ? target : null;
  }
}
