# Bot computers

A Bot computer is a macOS virtual machine that belongs to one Bot, so the Bot
can work in apps without touching the person's own desktop. Bot computers are
opt-in, run only on a Mac with Apple silicon, and are built and managed with
[Lume](https://github.com/trycua/cua/tree/lume-v0.6.1/libs/lume) 0.6.1, which
ships inside Aiden.

This page covers setting up, sizing, limiting and removing Bot computers. The
tools a Bot uses inside its computer and the live view are documented here as
they ship.

## Where they are available

- **Mac with Apple silicon, macOS 26 or later.** The pinned guest is macOS 26,
  and a guest is never newer than its host. On an older macOS, Settings →
  Bot computers explains why and offers nothing to set up.
- **Not on Intel Macs or Linux.** The `botComputers` platform capability
  (`main/services/host-platform-capabilities.ts`) is true only on darwin with
  arm64. Elsewhere the Settings page, its search entry and the Bot profile's
  Computer section do not appear, the `botComputers:*` IPC handlers are not
  registered, and no Lume code runs. Computer Use, which controls the person's
  own Mac, is separate and keeps its own availability.

## Setup

1. Open **Settings → Bot computers** and choose **Set up**. Before that choice
   the page states what happens: Aiden downloads macOS 26.6.2 (build 25G83)
   from Apple, about 20 GB (19,772,231,540 bytes), and builds a base computer
   of about 50 GB. Nothing is downloaded until you choose Set up. Set up first
   checks the Lume bundled with Aiden, so a missing or damaged helper is
   reported before anything is downloaded.
2. **Download.** The restore image comes from its pinned
   `updates.cdn-apple.com` URL (`main/services/bot-computers/release.ts`) with
   redirects refused. Progress shows in Settings with **Cancel**. Cancelling,
   quitting or losing the connection keeps the partial file, and the next Set
   up resumes it with an HTTP range request. The finished file must match the
   pinned size and SHA-256 or it is deleted.
3. **Base computer.** Lume installs macOS into a VM named `aiden-base` with
   its unattended `tahoe` preset (Lume's defaults: 4 CPUs, 8 GB of memory and
   a 100 GB sparse disk). Aiden then prepares it over SSH: it installs its own
   key, pins the guest's host key, replaces the preset's password with a random
   one, turns off password login for SSH, turns off automatic software updates
   and first-run prompts, links `~/Shared` to the shared folder, and shuts the
   base down. The restore image is deleted once the base is ready.
4. **Give a Bot a computer.** In the Bot's profile, **Computer → Give a
   computer** makes the Bot its own copy of the base (`aiden-bot-<id>`). It
   stays off until it is needed, and stops again when idle.

When an Aiden release pins a newer macOS image, Settings shows **Update base**.
It downloads the new image and builds the new base beside the current one, then
swaps them. Existing Bot computers keep working and show "Made from an older
base" until you **Reset** them: Aiden keeps trusting the SSH host key of every
base it built, and every base gets the same guest password, so an update (even
a failed one) never cuts Aiden off from a computer made earlier.

If setup fails, Settings shows why and offers **Try again**; a download that
stopped part-way continues where it left off. After a failed **Update base**,
Try again retries the update beside the current base, which keeps working (and
Bots can still be given computers from it) meanwhile. A base left half-built by a quit
or crash is deleted at the next launch or replaced when Set up runs again, and a
Bot computer that was interrupted while it was being made is marked for
**Reset**.

## Disk and memory

- **Set up** checks for free space before it downloads: the remaining download
  plus 60 GiB for the base and headroom (about 84 GB on an empty start).
  Settings states that figure before you choose Set up.
- **Set up** also checks for 8 GB of available memory before it downloads, and
  again before it installs macOS into the base, which runs as a computer while
  it is built. Update base, with Bot computers running, checks once, after it
  has made a place for the base (see Limits).
- **The base** takes about 50 GB once macOS is installed.
- **Each Bot computer** starts as an APFS copy of the base and takes space only
  as it changes. Settings → Bot computers shows the disk used by the base, the
  Bot computers and any download in progress. Because APFS copies share blocks,
  that figure can count shared space more than once.
- **Starting a computer** needs 8 GB of available memory (free, inactive and
  purgeable pages from `vm_stat`) and 5 GB of free disk. If either is short,
  the start is refused with a message saying which.

## Limits

- **Running at once:** 1 or 2 computers (default 2; macOS allows at most two
  macOS guests at a time). At the limit, the computer used longest ago stops if
  it is idle. A computer is idle when nothing is using it, the person is not
  controlling it, and it has not been used for a minute. If none is idle, the
  next Bot waits, and its computer shows "Waiting for another Bot's computer".
- **Building the base** (Set up or Update base) runs it as a computer, so it
  takes one of those places while macOS installs and Aiden prepares it. An idle
  computer stops to make room. If every running computer is in use, Update base
  stops and says so; stop a Bot's computer and choose Try again. A Bot whose
  computer needs to start meanwhile waits for the place. If another app's macOS
  virtual machine holds the last place, the install fails with a message saying
  so.
- **Stop when idle:** a running computer nobody has used for 5, 10 (default),
  15, 30 or 60 minutes stops. It never stops while the person is controlling it
  or a Bot action is running.
- **Pause, delete and quit:** pausing a Bot stops its computer at once, and a
  start that was still waiting gives up. Deleting a Bot stops and deletes its
  computer before its files are erased. Quitting Aiden turns every running
  computer off at once (a forced stop, like holding the power button) so quit
  stays within a few seconds.
- **Startup** stops computers an earlier launch left running and marks
  interrupted ones for Reset. It never stops a computer this launch is already
  starting or using, or the base while Set up builds it. A Mac that never chose
  Set up runs no Lume at startup.
- **Shared starts:** when a Bot's tool call, a routine and the Computer tab all
  need the same computer while it starts, they share one start. Closing the tab
  gives up only the tab's wait; the start stops only when nobody needs it.
- **Guests are macOS only.**

## Privacy and network

- **Manual downloads only.** The restore image is downloaded only after you
  choose **Set up** or **Update base**, from its one pinned URL, with no
  redirects and no credentials. Startup, listing, onboarding and background
  work never download, create or start a VM.
- **Pinned Lume.** Aiden runs only the Lume bundled inside its signed app
  (`Contents/Helpers/lume.app`). Before its first use in each launch it checks
  the bundle's location, size, SHA-256 and code signature (identifier `com.trycua.lume`,
  team `YCK386LBJ7`). It never looks Lume up on `PATH`, runs its installer, or
  runs `lume serve`, `lume update` or `lume pull`. Lume is updated only with an
  Aiden release.
- **Isolated Lume.** Every Lume process gets `LUME_TELEMETRY_ENABLED=false`,
  `LUME_UPDATE_CHECK=false`, a fixed `PATH` and its own `HOME` under Aiden's
  data folder, and every command names Aiden's own storage. Lume's own
  configuration in `~/.lume` is not used.
- **Screen.** Each start sets a new random screen-sharing password. Aiden uses
  the computer's screen only if Lume reports it on `127.0.0.1`, and stops the
  computer if the screen-sharing port also answers on any of the Mac's network
  addresses.
- **SSH.** Aiden reaches the guest with its own key, kept in Aiden's data
  folder, and the guest's pinned host key (one per base Aiden built; a Bot
  computer presents the key of the base it was copied from). Password login is turned off in the
  guest, agent and X11 forwarding are off, and nothing from the person's
  `~/.ssh` is used. The guest's account password is random and kept in Aiden's
  encrypted secret store.
- **Shared folder.** Only the Bot's `Computer` folder (inside its Aiden home)
  is shared into its computer, read-write, where it appears as `~/Shared`.
- **Guest network.** Bot computers use Lume's default shared (NAT) network, so
  a guest can reach the internet and, like any NAT guest, services that listen
  on this Mac.

## Removal

- **Remove** in a Bot's profile stops and deletes that Bot's computer. Files in
  the Bot's `Computer` folder stay, and you can give the Bot a new computer
  later.
- **Reset** deletes the Bot's computer and makes a fresh copy of the current
  base. Files in the `Computer` folder stay.
- **Delete Bot** stops and deletes its computer, then erases the Bot's files,
  including its `Computer` folder.
- **Remove everything** in Settings → Bot computers asks first, then stops and
  deletes every Bot computer (including one an earlier launch left running),
  the base, the macOS download and any partial download, Aiden's SSH key and pinned host key, the guest password, and the
  Bot-computer settings. Files in each Bot's `Computer` folder stay. To use Bot
  computers again, choose Set up, which downloads macOS again.

Everything lives under `bot-computers/` in Aiden's data folder
(`~/Library/Application Support/Aiden Agent/` on a standard install).

## Confirming on a Mac

Some Lume and macOS behaviour can't be checked in Linux CI. The fake Lume CLI
(`tests/e2e/lume-fake.mjs`) and the fixtures in
`main/services/bot-computers/fixtures/` follow Lume 0.6.1's source and are
marked assumed until they are recorded on an Apple-silicon Mac:

- `npm run bot-computers:vendor`, `npm run package` and
  `node scripts/verify-macos-package.mjs` (pinned hashes, signature,
  `com.apple.security.virtualization`, `embedded.provisionprofile`).
- Record `lume get --format json`, `lume ls --format json` and the error for a
  third running macOS guest into the fixtures, then run
  `npm run test:bot-computers`.
- The unattended `tahoe` preset, provisioning over SSH, password SSH refused
  afterwards, `~/Shared` reaching the shared folder, a loopback-only screen
  listener (`lsof -nP -iTCP -sTCP:LISTEN`), whether `--vnc-password` is visible
  in `ps`, and that `~/.lume` is untouched.
- A Set up interrupted mid-download resumes with a range request and ends with
  the pinned SHA-256; whether Apple's URL redirects.
