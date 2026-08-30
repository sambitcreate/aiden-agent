import {
  emptyAdvisorConfiguration,
  parseAdvisorConfiguration,
  parseAdvisorSelection,
  type AdvisorConfigurationV1,
  type AdvisorSelectionV1,
} from "../../renderer/shared/advisor.js";
import { DataStore } from "./data-store.js";

const MAX_SETTINGS_BYTES = 64 * 1024;

export interface AdvisorSettingsStoreOptions {
  root?: () => string;
  filename?: string;
  dataStore?: DataStore<AdvisorConfigurationV1>;
}

export class AdvisorSettingsStore {
  private readonly data: DataStore<AdvisorConfigurationV1>;
  private initialized = false;

  constructor(options: AdvisorSettingsStoreOptions = {}) {
    this.data =
      options.dataStore ??
      new DataStore<AdvisorConfigurationV1>(
        options.filename ?? "advisor-settings.json",
        emptyAdvisorConfiguration(),
        options.root,
        {
          maxBytes: MAX_SETTINGS_BYTES,
          fileMode: 0o600,
          normalize: (value) => parseAdvisorConfiguration(value) ?? emptyAdvisorConfiguration(),
          isSafe: (value) => parseAdvisorConfiguration(value) !== null,
          rejectCorruptWrite: true,
          rejectUnsafeWrite: true,
        },
      );
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.data.load();
    if (await this.data.loadedFromCorruptFile()) {
      throw new Error("Advisor settings are unreadable and were preserved.");
    }
    if (await this.data.loadedFromUnsafeFile()) {
      throw new Error("Advisor settings use an unsupported schema and were preserved.");
    }
    this.initialized = true;
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error("Advisor settings are not initialized.");
  }

  async get(): Promise<AdvisorConfigurationV1> {
    this.requireInitialized();
    return structuredClone(await this.data.load());
  }

  async setSelection(
    value: unknown,
    assertCurrent: () => void = () => undefined,
  ): Promise<AdvisorConfigurationV1> {
    this.requireInitialized();
    const selection = parseAdvisorSelection(value);
    if (selection === undefined) throw new Error("Invalid advisor selection.");
    const result = await this.data.update((configuration) => {
      // DataStore serializes this callback immediately before the durable
      // mutation, so renderer authority is checked at the effect boundary.
      assertCurrent();
      configuration.selection = selection;
      if (selection) configuration.disabledForExecutors = selection.disabledForExecutors;
      return structuredClone(configuration);
    });
    assertCurrent();
    return result;
  }

  async replaceSelection(
    selection: AdvisorSelectionV1 | null,
    assertCurrent: () => void = () => undefined,
  ): Promise<AdvisorConfigurationV1> {
    return this.setSelection(selection, assertCurrent);
  }
}
