{
  description = "Development environment for Aiden Agent";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { nixpkgs, rust-overlay, ... }:
    let
      # macOS only: the Apple Foundation Models helper targets macOS 26 and
      # packaging runs through `electron-builder --mac`.
      forAllSystems = nixpkgs.lib.genAttrs [
        "aarch64-darwin"
        "x86_64-darwin"
      ];
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ rust-overlay.overlays.default ];
          };
        in
        {
          default = pkgs.mkShell {
            packages = [
              # package.json requires >=22.19; CI runs 22.22.3.
              pkgs.nodejs_22

              # Read the file cargo and rustup already read, so the pinned
              # toolchain cannot drift from this shell. `npm test` runs
              # `cargo clippy --locked -- -D warnings`, which is sensitive to
              # the exact release.
              (pkgs.rust-bin.fromRustupToolchainFile ./native/computer-use-broker/rust-toolchain.toml)
            ];

            # DEVELOPER_DIR, SDKROOT, CC and CXX are deliberately unset: the
            # Swift helper builds against Apple's SDK and signing identities
            # live in the login keychain, so both come from the host Xcode.
          };
        }
      );
    };
}
