import type { AcpRelease } from "../acp/harness.js";

/**
 * Google Antigravity ACP server, pinned per Aiden release.
 *
 * URLs come from the official ACP registry (`antigravity-acp/agent.json`,
 * version 1.3.0). Hashes and exact sizes come from the Ed25519-signed catalog
 * in pi-antigravity-acp-provider @ 07e369b (signature verified 2026-10-06);
 * the darwin-arm64 archive was also downloaded and re-hashed independently.
 * The installer re-verifies every value and the server's live identity before
 * activation. Updating the runtime means updating this table in a reviewed
 * change; Aiden never fetches release metadata at runtime.
 */
export const ANTIGRAVITY_RELEASE: AcpRelease = {
  version: "1.3.0",
  platforms: {
    "darwin-arm64": {
      url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-arm64.zip",
      sha256: "7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88",
      archiveBytes: 111_456_962,
      members: [
        { name: "agy_acp_server.par", bytes: 278_535_456 },
        { name: "localharness_external", bytes: 118_611_392 },
      ],
      executable: "agy_acp_server.par",
      args: [],
    },
    "darwin-x64": {
      url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-x86_64.zip",
      sha256: "bb23956b89984bf5d354af2c3725e6c57f0cc1b7228e77a0e91c9c2bc1d47646",
      archiveBytes: 117_245_544,
      members: [
        { name: "agy_acp_server.par", bytes: 282_840_688 },
        { name: "localharness_external", bytes: 124_175_392 },
      ],
      executable: "agy_acp_server.par",
      args: [],
    },
    "linux-x64": {
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-x86_64.zip",
      sha256: "9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96",
      archiveBytes: 333_727_150,
      members: [
        { name: "agy_acp_server.par", bytes: 926_533_965 },
        { name: "localharness_external", bytes: 130_388_040 },
      ],
      executable: "agy_acp_server.par",
      args: ["--uid="],
    },
    "linux-arm64": {
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-arm64.zip",
      sha256: "500b0bc0fb858e88f4df404d4cedf80bf9298c178291e39e383d6c50b111cbdf",
      archiveBytes: 321_690_363,
      members: [
        { name: "agy_acp_server.par", bytes: 930_848_992 },
        { name: "localharness_external", bytes: 123_224_968 },
      ],
      executable: "agy_acp_server.par",
      args: ["--uid="],
    },
  },
};

export const ANTIGRAVITY_HARNESS_MEMBER = "localharness_external";
