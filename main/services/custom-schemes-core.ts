import { GENERATIVE_UI_PROTOCOL_SCHEME } from "../../renderer/shared/generative-ui.js";

export const STUDIO_ASSET_SCHEME = "aiden-asset";

export interface CustomSchemeDefinition {
  scheme: string;
  privileges: {
    standard: boolean;
    secure: boolean;
    bypassCSP: boolean;
    allowServiceWorkers: boolean;
    supportFetchAPI: boolean;
    corsEnabled: boolean;
    stream: boolean;
  };
}

const LOCAL_CONTENT_PRIVILEGES: CustomSchemeDefinition["privileges"] = Object.freeze({
  standard: true,
  secure: true,
  bypassCSP: false,
  allowServiceWorkers: false,
  supportFetchAPI: false,
  corsEnabled: false,
  stream: true,
});

/** Every custom scheme Aiden registers. Electron accepts exactly one call, before app ready. */
export function customSchemePrivileges(options: { studioAssets: boolean }): CustomSchemeDefinition[] {
  return [
    { scheme: GENERATIVE_UI_PROTOCOL_SCHEME, privileges: { ...LOCAL_CONTENT_PRIVILEGES } },
    ...(options.studioAssets
      ? [{ scheme: STUDIO_ASSET_SCHEME, privileges: { ...LOCAL_CONTENT_PRIVILEGES } }]
      : []),
  ];
}

export function createCustomSchemeRegistrar(target: {
  registerSchemesAsPrivileged(schemes: CustomSchemeDefinition[]): void;
}): (options: { studioAssets: boolean }) => boolean {
  let registered = false;
  return (options) => {
    if (registered) return false;
    target.registerSchemesAsPrivileged(customSchemePrivileges(options));
    registered = true;
    return true;
  };
}
