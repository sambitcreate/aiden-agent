import type { AcpRelease } from "../acp/harness.js";

/**
 * Google Antigravity ACP server, pinned per Aiden release.
 *
 * URLs and SHA-256 hashes come from the official ACP registry
 * (`antigravity-acp/agent.json`, version 1.4.3). All four archives were
 * downloaded from dl.google.com on 2026-10-27, re-hashed to match the registry,
 * and their exact member sizes read from the archives; the linux-x64 server
 * also passed a live `initialize` identity check.
 * The installer re-verifies every value and the server's live identity before
 * activation. Updating the runtime means updating this table in a reviewed
 * change; Aiden never fetches release metadata at runtime.
 */
export const ANTIGRAVITY_RELEASE: AcpRelease = {
  version: "1.4.3",
  platforms: {
    "darwin-arm64": {
      url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.3-darwin-arm64.zip",
      sha256: "c57db0a9b8b712daa9c3c17cdb990a61842ea569f279e8bd79d7aa85a303b20b",
      archiveBytes: 114_147_623,
      members: [
        { name: "agy_acp_server.par", bytes: 282_446_160 },
        { name: "localharness_external", bytes: 122_957_936 },
      ],
      executable: "agy_acp_server.par",
      args: [],
    },
    "darwin-x64": {
      url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.3-darwin-x86_64.zip",
      sha256: "9392dbbdad7f0663dbfb5a0bf641297b0cf80d2ee9cd2d49a616bbbc7378731d",
      archiveBytes: 119_801_100,
      members: [
        { name: "agy_acp_server.par", bytes: 286_653_712 },
        { name: "localharness_external", bytes: 127_612_208 },
      ],
      executable: "agy_acp_server.par",
      args: [],
    },
    "linux-x64": {
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.3-linux-x86_64.zip",
      sha256: "0634ce5306ba92c932945455e7a83fda78e2d99c33fa8aa6ee0566206a382714",
      archiveBytes: 336_846_435,
      members: [
        { name: "agy_acp_server.par", bytes: 927_707_135 },
        { name: "localharness_external", bytes: 133_926_136 },
      ],
      executable: "agy_acp_server.par",
      args: ["--uid="],
    },
    "linux-arm64": {
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.3-linux-arm64.zip",
      sha256: "05c153443b0b1175151c760eeddea538950bc9843e317d54786a1f03670182bc",
      archiveBytes: 322_887_047,
      members: [
        { name: "agy_acp_server.par", bytes: 932_662_106 },
        { name: "localharness_external", bytes: 127_512_832 },
      ],
      executable: "agy_acp_server.par",
      args: ["--uid="],
    },
  },
};

export const ANTIGRAVITY_HARNESS_MEMBER = "localharness_external";
