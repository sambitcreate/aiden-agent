# Linux desktop support

Aiden Agent's release pipeline produces native x64 and arm64 Linux builds as
AppImage, Debian, and RPM packages. The current public `v0.40.0` release predates
that pipeline and contains only the arm64 Mac build; Linux installation becomes
available with the next accepted release. The `.deb` and `.rpm` formats are
recommended because the distro package manager installs Electron's runtime
libraries and owns replacement or removal. AppImage is the portable fallback.

## Install

The cross-platform installer detects macOS or Linux, the native architecture,
and common Debian or RPM distribution families:

```sh
curl -fsSL https://raw.githubusercontent.com/sambitcreate/aiden-agent/main/install.sh | sh
```

Linux installation requires a current trusted GitHub CLI so the selected package
can be checked against Aiden's main-branch release-workflow attestation. Pass an
independently reviewed release commit for the strictest path:

```sh
curl -fsSL https://raw.githubusercontent.com/sambitcreate/aiden-agent/main/install.sh | \
  sh -s -- --expected-commit REPLACE_WITH_APPROVED_40_CHARACTER_COMMIT
```

Without that option, the installer pins verification to the exact commit in the
GitHub release record and says so. This is convenient release authentication,
not approval for the separate Computer Use runtime boundary. Use `--user` for a
writable AppImage under `~/.local/share/aiden-agent`, or `--download-only DIR`
to retain the verified package without installing it. `--plan --version X.Y.Z`
prints the platform decision without network access.

You can also download the package for your architecture manually from
[GitHub Releases](https://github.com/sambitcreate/aiden-agent/releases):

Debian, Ubuntu, Linux Mint, Pop!_OS, and related distributions:

```sh
sudo apt install ./Aiden-Agent-*-linux.deb
```

Fedora, RHEL, Rocky Linux, and other RPM-based distributions:

```sh
sudo dnf install ./Aiden-Agent-*-linux.rpm
```

Portable AppImage:

```sh
chmod +x Aiden-Agent-*-linux.AppImage
./Aiden-Agent-*-linux.AppImage
```

The AppImage uses a pinned static launcher, so it does not depend on the legacy
FUSE 2 userspace library. A container, locked-down host, or other environment
without a usable FUSE mount can still use AppImage's extraction fallback:

```sh
./Aiden-Agent-*-linux.AppImage --appimage-extract-and-run
```

## Desktop requirements

- A glibc 2.34 or newer x64 or arm64 desktop distribution supported by
  Electron. This includes RHEL/Rocky Linux 9, Debian 12, Ubuntu 22.04, and newer
  releases in those families.
- A working graphical session under X11 or Wayland.
- A Secret Service or KWallet credential backend when saving provider, MCP,
  ChatGPT, or model-data credentials. GNOME Keyring, KDE Wallet, and compatible
  desktop keyrings provide this on common desktop installations.
- `tar` for on-device speech-model installation and `openssl` only when the
  optional nearby Aiden On The Go listener creates its local TLS identity.
- Tailscale only when the optional private-tailnet remote route is selected.

Aiden deliberately refuses to save secrets when Electron reports the Linux
`basic_text` backend. Unlock or configure the desktop keyring and restart Aiden;
the app will not silently downgrade credentials to reversible local storage.
Keyless local connections such as LM Studio and Ollama do not use secret
storage and remain available when no keyring session is running.

## Tailscale remote access

Tailscale installs its CLI at `/usr/bin/tailscale` on mainstream Linux
packages. After signing in, grant your desktop user one-time permission to
manage Serve routes:

```sh
sudo tailscale set --operator=$USER
```

Aiden changes only its scoped `/api/aiden/v1` HTTPS Serve path and preserves
unrelated Serve configuration. Without the operator grant, status remains
readable but Aiden reports the permission requirement instead of claiming an
uncertain connection.

## Platform behavior

The workspace agent, providers, local models, MCP, skills, Web Search,
schedules, terminal, Git, file editor, generative UI artifacts, diagnostics,
Gemini voice transcription, remote access, notifications, profile, themes, and
native subagents use the same contracts as macOS. Linux-specific integrations include:

- native distro window chrome and conventional File/Edit/View/Window/Help menus;
- Ctrl-based app and global shortcuts, including the Wayland Global Shortcuts
  portal on desktops that implement it;
- Vulkan disabled on Wayland sessions to avoid Chromium's Ozone incompatibility
  warning (pass `--ozone-platform=x11` to keep the default feature set);
- editor discovery through `PATH`, Snap command locations, JetBrains Toolbox
  scripts, and common Flatpak application IDs;
- opening folders with the default desktop file manager;
- profile snapshot export through a Save dialog;
- bundled Node mDNS publication for nearby Aiden On The Go discovery, without
  requiring Apple's `dns-sd` utility.

Bots use the same roster, definitions, access controls, conversations, schedules,
and Telegram bindings as macOS. Their native authority helper requires an
unlocked Secret Service collection (for example GNOME Keyring, or a KDE Wallet
that exposes the Secret Service API). KWallet support for Electron credentials
alone does not establish this requirement. Bot authority and rollback anchors
never fall back to files or plaintext. If the helper or keyring is unavailable,
Bot operations fail closed while ordinary workspace chat remains available;
unlock or configure the keyring and restart Aiden to restore Bot access.

Computer Use and Apple Foundation Models are not included in the Linux
build. Their settings, navigation, onboarding promises, helper bundles, and
chat controls are omitted. Global dictation remains available when the desktop can register its
shortcut, but the transcript is copied to the clipboard instead of using the
macOS Accessibility auto-paste transaction. To use hold-to-dictate, choose Hold
in Settings → Voice and assign a shortcut in your desktop’s Global Shortcuts
portal. Hold setup requires the package's desktop entry to be installed under a
system or user applications directory; development runs and non-integrated
AppImages retain toggle dictation. Setup is explicit for each app session; startup never opens a permission
dialog. The desktop may assign a different trigger, which Aiden displays. If
the session ends, or shortcuts are edited, Aiden returns to toggle behavior.
Desktops without this portal keep toggle dictation. Wayland compositors own final
placement of the dictation pill, so exact bottom-center positioning may vary.

Provider inventories may refresh only from the provider services the user has
configured. Descriptive model metadata uses the bundled release snapshot or a validated
device-local display cache. The explicit **Update model catalogs** action in
Settings may refresh that cache; startup and ordinary reads stay offline.

## Updates and troubleshooting

Writable production AppImages mounted by their launcher use Settings → About
for update checks, downloads, and restart. Downloads are verified against the
SHA-512 digest in the architecture-specific GitHub release feed. Updates retain
the current AppImage filename. Unlike macOS releases, this does not provide Apple
code-signing verification.

Native subagent file replacement preserves metadata or fails closed. On an
SELinux host, Aiden preserves a non-default `security.selinux` label when the
active policy permits the user-owned helper to copy it. If the kernel denies
copying that label or Linux file capabilities, Aiden leaves the original file
unchanged and reports the mutation as unavailable. Restore a normal workspace
label or apply denied privileged metadata outside the subagent transaction
before retrying.

Install the newer `.deb` or `.rpm` through the package manager that owns the
installation. Read-only AppImages and extraction-mode launches also use manual
replacement. Settings → About links to GitHub Releases for these installations.

If a global shortcut is unavailable, check the desktop's shortcut portal or
conflicts with another application and assign another chord under Settings →
Keyboard shortcuts. If an AppImage does not start, prefer the native distro
package or use the extraction command above. When reporting a Linux issue,
include the distribution, architecture, desktop environment, X11/Wayland
session type, package format, and the exact error shown by Aiden.
