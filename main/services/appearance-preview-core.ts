import type {
  AppearanceConfig,
  AppearancePreviewSnapshot,
} from "../../renderer/shared/appearance.js";

function fingerprint(config: AppearanceConfig): string {
  return JSON.stringify(config);
}

/**
 * Owns the newest safe appearance preview until that exact value is persisted.
 * An older save completing after a newer preview must never roll auxiliary
 * windows back to the older palette.
 */
export class AppearancePreviewState {
  private pending: AppearanceConfig | null = null;

  preview(config: AppearanceConfig): AppearanceConfig {
    this.pending = config;
    return config;
  }

  effective(persisted: AppearanceConfig): AppearanceConfig {
    return this.pending ?? persisted;
  }

  snapshot(persisted: AppearanceConfig): AppearancePreviewSnapshot {
    return {
      appearance: this.effective(persisted),
      pending: this.pending !== null,
    };
  }

  persisted(config: AppearanceConfig): AppearanceConfig {
    if (
      this.pending
      && fingerprint(this.pending) === fingerprint(config)
    ) {
      this.pending = null;
    }
    return this.pending ?? config;
  }
}
