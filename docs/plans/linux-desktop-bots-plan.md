# Plan: Linux desktops for Bots (plus A, B, E)

Nov 23, 2026 · @sbt

## Summary

Bot computers switch from macOS virtual machines to a Linux desktop (Debian + XFCE) running in Lume on the same Apple silicon Macs, and the macOS computers are removed. This is 8 PRs, and nothing is opened until you say go.

Why it's worth it: a Linux computer downloads about 1 GB instead of 20 GB, uses about 8 GB of disk instead of 50 GB, sets up with no permission prompts, and isn't held to Apple's two-Mac-VM limit. The cost: Bots can no longer use Mac-only apps (Safari, Keynote, Xcode, Messages).

Order: **B** (CI reports) can go any time. **A** comes next (Lume, then `cua-driver`), because the Linux work needs both. Then the four **F** PRs (Linux computers), shipped together in one release. **E** (real-desktop checks) comes last.

Decisions on 24 Nov: 1a 2a 3a 4a 5a 6a (see [Decisions](#decisions-24-nov)).

## Before and after

Linux figures are estimates; the first Linux PR measures them on a real Mac before anything ships.

| Dimension | macOS computer (today) | Linux computer (planned) |
| --- | --- | --- |
| Download at Set up | about 20 GB (Apple restore image) | about 1 GB (Debian image + desktop packages) |
| Disk for the base | about 50 GB; Set up needs about 84 GB free | about 8 GB; Set up needs about 20 GB free |
| Memory per running computer | 8 GB | 4 GB (2 GB minimum) |
| Running at once | at most 2 (Apple's limit) | 2 by default, up to 4 if memory allows |
| Set up steps for you | wait, then grant Accessibility and Screen Recording in the live view (up to 30 min) | none: fully automatic |
| Apps a Bot can use | Mac apps: Safari, Notes, Keynote, Xcode | Linux apps: Chromium, Firefox, LibreOffice, a terminal, anything from Debian |
| Sign-in on the computer opens in | Safari | Chromium |
| Element control (click by number) | after the grants, if they worked | always on (no permission system to pass) |
| Host microphone and clipboard in the guest | shared by default | off: the guest gets no audio or clipboard device |
| Where it runs | Apple silicon Macs | Apple silicon Macs (Linux and Intel hosts: a later project) |

What stays the same: the Computer tab, live view, Take over and Give back, the `computer` and `computer_shell` tools, Bot rules, idle stop, Pause, and Settings → Computers & VMs → Bot computers.

## How the Linux computer works

The pieces Aiden already has (Lume, the VNC live view, SSH, the driver bridge) stay; only what runs inside the VM changes.

How Set up builds the base, all after you press Set up (no network before that):

1. Download Debian 13's official arm64 disk image from a pinned URL, checked against a pinned SHA-256 (same rule as today's Apple image). Debian ships a plain raw disk, so no conversion tool is needed.
2. `lume create aiden-base --os linux`, then put the downloaded disk in place and grow it to 24 GB (sparse, so it only uses what is written).
3. Start it once with a tiny setup disk Aiden writes itself (cloud-init): Aiden's SSH key, a random password kept in Aiden's credential store, and the package list.
4. Inside, install XFCE with auto-login, Chromium, Firefox, the accessibility bus (AT-SPI), and fonts, from a pinned Debian snapshot so every Mac gets the same versions. Turn off automatic updates, screen lock and sleep.
5. Copy Aiden's bundled `cua-driver` for Linux arm64 in over SSH, check its SHA-256, and run it as a user service.
6. Check the desktop shows in the live view and the driver answers, then shut down. Each Bot's computer is a copy-on-write clone of this base, as today.

Every start uses `--no-audio-device --no-clipboard-device`, so the guest never hears your microphone or reads your clipboard.

## The PRs, in order

| # | PR | Needs | Size | Check on your Mac |
| --- | --- | --- | --- | --- |
| 1 | B: clearer CI timing and failure report | nothing | Small | No |
| 2 | A1: Lume 0.6.1 to 0.8.0 | nothing | Small | Yes, start and stop a computer |
| 3 | A2: `cua-driver` 0.36.0 to one chosen version | 2 | Medium | Yes, Computer Use acceptance |
| 4 | F1: Linux image pin and a hidden Linux base | 2 | Medium | Yes, the desktop shows |
| 5 | F2: Linux Set up, Update base, Settings | 4 | Large | Yes, Set up end to end |
| 6 | F3: driver, tools and sign-in on Linux | 3, 5 | Large | Yes, a Bot uses its computer |
| 7 | F4: remove macOS computers, docs, release | 6 | Medium | Yes, old computers removed |
| 8 | E: real-desktop checks for Computer Use | 3 | Medium | Yes, you run it |

F1 to F3 sit behind a build switch (`AIDEN_BOT_COMPUTERS_LINUX`), so `main` never ships half a change. F4 turns it on and deletes the macOS path; all four go out in one release.

Every PR that changes what you see (F2, F3, F4: Settings, the Computer tab, the notice, the onboarding tile) comes with light and dark screenshots in the PR before approval.

### 1. B: clearer CI timing and failure report

- `scripts/ci-timings.mjs` already lists every job and step. Split each job's wait into queue (job created to started) and waiting on other jobs, which today are one number.
- Add a "First failure" block at the top of the CI summary: which job, which step, the first failed test, and a link, even when a rerun later passed.
- Add named phase timings to the chart test (browser launch, page ready, screenshot, close) and to the iOS job (simulator boot, build, test), so a stall says where it stalled.
- Tests: extend `scripts/ci-timings.test.mjs` with recorded job fixtures. Docs: `docs/ci.md`.

### 2. A1: Lume 0.6.1 to 0.8.0

- Re-pin in `scripts/bot-computers-lume-pins.mjs`, `resources/bot-computers/lume-artifact.json` and `lume-binary.ts` (URL, SHA-256, signing team).
- Use what's new: Lume's own low-disk and VM-limit refusals mapped to Aiden's messages; `--no-audio-device` and `--no-clipboard-device` on every start; post-hardening file transfers use Aiden's key-authenticated, host-key-pinned `/usr/bin/ssh` (`ssh.ts` stdin/command stream) or the shared folder rather than `lume cp` (omitted because it uses preset password auth and disables host-key checking).
- Update the fake Lume (`tests/e2e/lume-fake.mjs`) for the new flags and output. Docs: `docs/bot-computers.md`, `AGENTS.md` pin line.

### 3. A2: `cua-driver` 0.36.0 to one chosen version

- Pick the newest version with no new release for 7 days, so we don't land mid-burst. Pin both the macOS build (for Computer Use on your Mac) and the Linux arm64 build (for Bot computers), each by SHA-256.
- Update the exact tool list Aiden checks, the removed flags, and the new refusal codes in `docs/computer-use-integration.md` and the broker.
- Run `npm run test:computer-use` and the packaged Computer Use acceptance on your Mac.

### 4. F1: Linux image pin and a hidden Linux base

- `main/services/bot-computers/release.ts` pins the Debian 13 arm64 image (URL, size, SHA-256) and a Debian snapshot date for packages.
- A small writer makes the cloud-init setup disk (an ISO of a few KB). `lume-cli.ts` gains `create --os linux`, `--mount` and `--disk-path`.
- Behind the switch only. Proves on your Mac that the VM boots, the live view shows XFCE, and SSH works; records real Lume output as test fixtures.

### 5. F2: Linux Set up, Update base and Settings

- `provision.ts` gets Linux steps: install key, harden SSH, packages, auto-login, no updates or screen lock, shared folder (virtiofs), shut down. The macOS steps stay until F4.
- Settings: no permissions step; new sizes (download, disk, memory); "Running at once" up to 4, limited by free memory.
- Tests: provision and host tests against the fake Lume and fake SSH; Settings render tests; `bot-computer-tab.spec.ts`.

### 6. F3: driver, tools and sign-in on Linux

- Guest driver as a systemd user service instead of a LaunchAgent; SHA-256 check instead of codesign. Element roles from AT-SPI (a password field reads as a credential, as `AXSecureTextField` does today).
- `computer` and `computer_shell` tool text says Linux; key chords map Command to Ctrl; app names like "Chromium" instead of "Safari".
- Sign-in on the computer opens Chromium. The Bot's shell commands run as a separate Linux user, and during a sign-in Aiden ends every program that user started (decision 4a).
- Tests: `guest-driver*.test.ts`, `computer-tool.test.ts`, `bot-computer-handoff.test.ts`, `bot-sign-in-tool.test.ts`.

### 7. F4: remove macOS computers, docs and release

- Delete the Apple restore image pin and download, the macOS provisioning, the permissions screens and the Safari opener. Turn the switch on.
- One-time cleanup on first launch (see [Removing the macOS computers](#removing-the-macos-computers)). Give each Bot that had a computer a one-line note that its computer is now Linux and old Mac files are gone.
- Docs: rewrite `docs/bot-computers.md`; update `AGENTS.md` (the Bot computers rule names the Linux image instead of the Apple one), `PRODUCT.md`, `README.md`, the onboarding tile and its art, `docs/plans/README.md`, release notes. Rewrite the packaged acceptance for Linux.

### 8. E: real-desktop checks for Computer Use

- Extend the existing packaged Computer Use acceptance with checks that look at the result, not the tool's reply: TextEdit saves a marker file with the right text; with two windows, only the target window changes and your mouse doesn't move; Stop leaves no helper running; a denied permission changes nothing.
- Each check reports `pass`, `failed`, `environment problem` or `unsupported`, with the app version, driver version and macOS version. A missing row never counts as a pass.

## Removing the macOS computers

The release with F4 removes every macOS Bot computer the first time it starts. Anything a Bot saved inside its Mac computer (files, browser sign-ins) is lost, so the release notes say so in the first line.

What the first launch does:

1. Stop any macOS computer still running (`lume stop --force`).
2. Delete `aiden-base`, `aiden-base-next` and every Bot's macOS computer from Aiden's own Lume storage, plus any half-downloaded Apple restore image. This frees the 50+ GB.
3. Remove the old guest password from the credential store and reset Bot computer setup to "not set up".
4. Keep each Bot's "has a computer" setting. Its next computer call asks you to set up the Linux base, once, for all Bots.
5. Show one notice in Settings → Computers & VMs: "Bot computers now run Linux. Your Mac computers were removed and freed N GB. Set up to continue."

It touches only VMs inside Aiden's storage folder, never other Lume or Cua VMs on the Mac. For existing Macs, you can also run Remove everything in Settings before the update; nothing is lost that the update wouldn't remove anyway.

With decision 6a, E (real-desktop checks) runs on your real Mac, not in a Mac VM, so removing macOS computers doesn't affect it.

## Decisions (24 Nov)

Recommended option chosen on all six:

| # | Question | Decision |
| --- | --- | --- |
| 1 | Which Linux | Debian 13 with XFCE (Ubuntu only if F1 shows Debian can't work) |
| 2 | Old macOS computers | Removed automatically on first launch, with one notice and a release-note warning |
| 3 | Which computers | Apple silicon Macs first; Linux PCs are a later, separate project |
| 4 | Sign-in privacy | The Bot's shell runs as a separate Linux user, and all of its programs end while you sign in |
| 5 | Running at once | 2 by default, up to 4 when the Mac has the memory |
| 6 | Where E runs | On your real Mac, through the existing acceptance command |

## Risks

| Risk | Mitigation |
| --- | --- |
| Debian's image doesn't show a desktop under Apple's VM framework (graphics driver) | F1 proves this first; fallback is Debian's full-kernel image, then Ubuntu |
| Clicks in Chromium don't work in the background on Linux (the driver refuses "trusted" browser clicks on X11) | The Bot falls back to clicking through the screen (VNC), which always works; element control still lists and reads |
| Bots lose Mac-only apps | Called out in release notes; a Bot that needs a Mac app uses Computer Use on your Mac, with your approval |
| The driver changes daily | One pinned version, moved only in its own PR with a Mac check |
| Package mirrors change | Packages come from a fixed Debian snapshot date; Update base moves the date |
| Removing Mac computers loses files inside them | First line of the release notes; Remove everything is available before updating |
| Cua's Linux images are tempting shortcuts | Not used: they contain Cua Spaces parts under the FSL license, which bars products that compete with Spaces |

## Sources

- Aiden `main` at `b2b5c351`: `main/services/bot-computers/`, `docs/bot-computers.md`, `.memory/bot-computers.md`, `scripts/ci-timings.mjs`, `.github/workflows/ci.yml`
- [trycua/cua](https://github.com/trycua/cua) at `f7a7a2f`: Lume CLI reference and Linux guests guide, `cua-driver` platform support and release workflow (Linux arm64 builds), `libs/images/README.md`, `legal/LICENSING.md`
- Earlier research: [What Aiden could use from Cua](https://claude.ai/artifact/57ZQSSWopenMXxmzXdn8dv)
