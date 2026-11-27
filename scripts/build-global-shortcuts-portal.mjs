import { buildLinuxPkgConfigHelper } from "./build-linux-pkgconfig-helper.mjs";

await buildLinuxPkgConfigHelper({
  name: "aiden-global-shortcuts-portal",
  sourceDirectory: "global-shortcuts-portal",
  pkgConfigPackage: "gio-unix-2.0",
  skipMessage: "Global Shortcuts portal is built only on Linux.",
});
