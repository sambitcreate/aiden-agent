# Linux desktop support

Aiden Agent ships native x64 and arm64 Linux builds as AppImage, Debian, and
RPM packages. The `.deb` and `.rpm` formats are recommended because the distro
package manager installs Electron's runtime libraries and owns replacement or
removal. AppImage is the portable fallback.

## Install

Download the package for your architecture from
[GitHub Releases](https://github.com/sambitcreate/aiden-agent/releases).

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
- editor discovery through `PATH`, Snap command locations, JetBrains Toolbox
  scripts, and common Flatpak application IDs;
- opening folders with the default desktop file manager;
- profile snapshot export through a Save dialog;
- bundled Node mDNS publication for nearby Aiden On The Go discovery, without
  requiring Apple's `dns-sd` utility.

Computer Use, Apple Foundation Models, and Bots are not included in the Linux
build. Their settings, navigation, onboarding promises, helper bundles, and
chat controls are omitted. Global dictation remains available when the desktop can register its
shortcut, but the transcript is copied to the clipboard instead of using the
macOS Accessibility auto-paste transaction. Wayland compositors own final
placement of the dictation pill, so exact bottom-center positioning may vary.

Provider inventories may refresh only from the provider services the user has
configured. Descriptive model metadata comes from Aiden's bundled release
snapshot; ordinary app reads expose no live models.dev refresh action.

## Updates and troubleshooting

Linux builds do not apply macOS-style in-app updates. Install the newer `.deb`
or `.rpm` over the existing package, replace the AppImage, or follow the package
manager that owns the installation. Settings → About links directly to the
release page.

If a global shortcut is unavailable, check the desktop's shortcut portal or
conflicts with another application and assign another chord under Settings →
Keyboard shortcuts. If an AppImage does not start, prefer the native distro
package or use the extraction command above. When reporting a Linux issue,
include the distribution, architecture, desktop environment, X11/Wayland
session type, package format, and the exact error shown by Aiden.
