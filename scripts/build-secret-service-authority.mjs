import { buildLinuxPkgConfigHelper } from "./build-linux-pkgconfig-helper.mjs";

await buildLinuxPkgConfigHelper({
  name: "aiden-secret-service-authority",
  sourceDirectory: "secret-service-authority",
  pkgConfigPackage: "libsecret-1",
  skipMessage: "Secret Service authority is built only on Linux.",
});
