# Bot computers

A Bot computer is a Linux virtual machine (Debian 13 with XFCE) that belongs to
one Bot, so the Bot can work in apps and a browser without touching the
person's own desktop. Bot computers are opt-in, run only on a Mac with Apple
silicon, and are built and managed with
[Lume](https://github.com/trycua/cua/tree/lume-v0.8.0/libs/lume) 0.8.0, which
ships inside Aiden.

This page covers setting up, sizing, limiting and removing Bot computers,
upgrading from earlier macOS Bot computers, seeing and taking over a Bot's
computer, and the tools a Bot uses inside it.

## Where they are available

- **Mac with Apple silicon, macOS 14 or later.** On an older macOS, Settings →
  Computers & VMs → Bot computers explains why and offers nothing to set up.
- **Not on Intel Macs or Linux hosts.** The `botComputers` platform capability
  (`main/services/host-platform-capabilities.ts`) is true only on darwin with
  arm64. Elsewhere the Settings page, its search entry and the Bot Advanced tab's
  Computer section do not appear, the `botComputers:*` IPC handlers are not
  registered, and no Lume code runs. Computer Use, which controls the person's
  own Mac, is separate and keeps its own availability.

## Upgrading from macOS Bot computers

Aiden no longer runs macOS virtual machines for Bots; Bot computers now run
Debian 13 with XFCE. The first time Aiden launches on a Mac that had macOS Bot
computers:

1. Any macOS Bot computer still running is stopped (`lume stop --force`).
2. `aiden-base`, `aiden-base-next`, every Bot's macOS computer in Aiden's own
   Lume storage, and any partial or downloaded Apple restore image (`*.ipsw`)
   are deleted, freeing 50+ GB. Other Lume or Cua VMs outside Aiden's storage
   folder are never touched.
3. The old guest password is removed from Aiden's credential store and Bot
   computer setup resets to **Not set up**.
4. Each Bot keeps its "has a computer" setting and receives a one-line note in
   its memory explaining that its computer is now Linux and old Mac files are
   gone. Files saved in each Bot's shared `Computer` folder stay intact.
5. Settings → Computers & VMs → Bot computers shows one dismissible notice:
   *"Bot computers now run Linux. Your Mac computers were removed and freed N GB. Set up to continue."*

Once you choose **Set up** in Settings, the next time any migrated Bot uses its
computer (or you open its Computer tab), Aiden clones a fresh Linux computer
from the new base automatically.

## Setup

1. Open **Settings → Computers & VMs → Bot computers** and choose **Set up**.
   Before that choice the page states what happens: Aiden downloads Debian 13
   (trixie) arm64 (~3 GB disk image plus desktop packages) and builds a base
   computer of about 8 GB. Nothing is downloaded until you choose Set up. Set up
   first checks the Lume bundled with Aiden, so a missing or damaged helper is
   reported before anything is downloaded.
2. **Download.** The Debian 13 arm64 raw disk image comes from its pinned
   `cloud.debian.org` URL (`main/services/bot-computers/release.ts`), following
   at most 5 HTTPS-only redirects. Progress shows in Settings with **Cancel**.
   Cancelling, quitting or losing the connection keeps the partial file, and
   the next Set up resumes it with an HTTP range request. The finished file must
   match the pinned size and SHA-256 or it is deleted.
3. **Base computer.** Lume creates a Linux VM named `aiden-base` (`--os linux`,
   4 CPUs, 4 GB memory, 24 GB sparse disk, 1280×800 display). Aiden clones and
   sparsely grows the verified Debian raw image into place, writes a tiny
   cloud-init `CIDATA` seed ISO (with Aiden's SSH public key and a random
   SHA-512-hashed password stored in Aiden's encrypted secret store), and boots
   it once. Over SSH (with the guest's `ssh-ed25519` host key scanned and pinned
   into `known_hosts`), Aiden:
   - Waits for `cloud-init`, turns off password and root SSH logins
     (`PasswordAuthentication no`, `PermitRootLogin no`, verified via `sshd -T`),
   - Removes default DEB822 APT sources and installs XFCE, LightDM, Chromium,
     Firefox ESR, AT-SPI (`at-spi2-core`, `libatk-adaptor`), and fonts from a
     pinned `snapshot.debian.org` timestamp so every Mac gets the same package
     versions,
   - Configures LightDM autologin into XFCE with AT-SPI enabled and disables
     automatic updates, screen lock and sleep,
   - Creates the unprivileged `aiden-bot` user (no sudo privileges) for
     `computer_shell` isolation, with narrowly scoped sudoers rules for
     `lume` to run commands as `aiden-bot` and stop its processes during sign-in,
   - Mounts `<botHome>/Computer` over `virtiofs` at `/mnt/aiden-shared` and
     links `~/Shared` for both `lume` and `aiden-bot`,
   - Starts LightDM, copies Aiden's pinned Linux arm64 `cua-driver` binary and
     MIT notice over SSH, verifies its SHA-256 against Aiden's compiled pin,
     starts it as a `systemd --user` service, and probes element control,
   - Shuts the base down cleanly, deletes the temporary seed ISO, and deletes
     the verified Debian download. No manual permission prompts are needed.
4. **Give a Bot a computer.** In the Bot's Advanced tab, **Computer → Give a
   computer** makes the Bot its own APFS copy-on-write clone of the base
   (`aiden-bot-<id>`). It stays off until it is needed, and stops again when
   idle.

When an Aiden release pins a newer Debian image or snapshot date, Settings shows
**Update base**. It downloads the new image and builds `aiden-base-next` beside
the current base, then swaps them. Existing Bot computers keep working and show
"Made from an older base" until you **Reset** them: Aiden keeps trusting the SSH
host key of every base it built, and every base gets the same guest password, so
an update (even a failed one) never cuts Aiden off from a computer made earlier.

If setup fails, Settings shows why and offers **Try again**; a download that
stopped part-way continues where it left off, and a verified Debian image stays
on disk for retry while the half-made VM and seed ISO are cleaned up. After a
failed **Update base**, Try again retries beside the current base, which keeps
working meanwhile. A base left half-built by a quit or crash is deleted at the
next launch or replaced when Set up runs again, and a Bot computer that was
interrupted while it was being made is marked for **Reset**.

## Disk and memory

- **Set up** checks for free space before it downloads: the remaining download
  plus 20 GiB for the base and headroom. Settings states that figure before you
  choose Set up.
- **Set up** checks for 2 GB of available memory before it downloads and again
  before building the base.
- **The base** takes about 8 GB once Debian 13 and XFCE packages are installed
  (on a 24 GB sparse disk).
- **Each Bot computer** starts as an APFS copy of the base and takes space only
  as it changes. Settings → Computers & VMs → Bot computers shows the disk used
  by the base, the Bot computers and any download in progress. Because APFS
  copies share blocks, that figure can count shared space more than once.
- **Starting a computer** needs 4 GB of available memory (2 GB minimum for the
  first running computer, from `vm_stat`) and 5 GB of free disk. If either is
  short, the start is refused with a message saying which. Lume 0.8.0 also
  refuses to start a writable disk when the host volume is low on free space;
  Aiden maps that refusal to a free-space message as well.

## Limits

- **Running at once:** 1 to 4 computers (default 2), bounded by the Mac's
  available memory (4 GB per running computer). At the limit, the computer used
  longest ago stops if it is idle. A computer is idle when nothing is using it,
  the person is not controlling it, and it has not been used for a minute. If
  none is idle, the next Bot waits, and its computer shows "Waiting for another
  Bot's computer".
- **Building the base** (Set up or Update base) runs it as a computer, so it
  takes one of those places while Debian installs and Aiden prepares it. An idle
  computer stops to make room. If every running computer is in use, Update base
  stops and says so; stop a Bot's computer and choose Try again. A Bot whose
  computer needs to start meanwhile waits for the place.
- **Stop when idle:** a running computer nobody has used for 5, 10 (default),
  15, 30 or 60 minutes stops. It never stops while the person is controlling it
  or a Bot action is running.
- **Pause, delete and quit:** pausing a Bot starts stopping its computer as
  soon as its run has stopped, and a start that was still waiting gives up.
  The pause answers without waiting for that stop, which shuts the guest down
  gracefully and can take up to about 30 seconds; the computer reads Stopping
  until it is off. Deleting a Bot stops and deletes its computer before its
  files are erased. Quitting Aiden turns every running computer off at once (a
  forced stop, like holding the power button) so quit stays within a few
  seconds. A computer that is still starting when you quit has Lume's launch
  ended at once, so a computer Lume hadn't launched yet never comes up after
  Aiden has quit. One Lume had already launched is turned off while Aiden quits,
  or at Aiden's next launch if it only comes up after Aiden has gone.
- **A stop that fails:** if Lume can't stop a computer, Aiden asks Lume for its
  state again. A computer that is still running stays shown as running (and
  keeps its idle timer), rather than being shown as off while it runs.
- **A start that fails:** Lume starts a computer in the background, and the
  computer can come up a few moments after Lume has reported back. So a start
  that is cancelled (Pause, Stop, or every caller giving up) or fails can leave
  it on. Aiden lets Lume finish launching it (unless you're quitting Aiden,
  which ends the launch at once), then turns it off; while Lume says it isn't
  running yet, or fails to turn it off without saying why, Aiden keeps checking
  for up to about ten seconds and turns it off once it comes up. Aiden stops
  checking as soon as Lume's log says the launch failed, and doesn't wait at all
  when Lume refused the start (no such computer, one still being made, low host
  disk space, or VM limit).
- **Startup** stops computers an earlier launch left running, cleans up legacy
  macOS Bot computers once if present, and marks interrupted Linux ones for
  Reset. It never stops a computer this launch is already starting or using, or
  the base while Set up builds it. A Mac that never chose Set up runs no Lume
  at startup.
- **Shared starts:** when a Bot's tool call, a routine and the Computer tab all
  need the same computer while it starts, they share one start. Closing the tab
  gives up only the tab's wait; the start stops only when nobody needs it.
- **Guests are Linux (Debian 13 + XFCE) only.** If a Bot needs a Mac-only app
  (Safari, Keynote, Xcode, Messages), use **Computer Use** on your Mac with
  your approval instead.

## Seeing and taking over

While a Bot has a computer, its chat's Bot panel has a **Computer** tab. The
tab never appears where Bot computers are unavailable (Intel Macs and Linux
hosts), and it goes away when the computer is removed.

- **Opening the tab.** Switching to Computer starts a stopped computer and
  shows "Starting Ada's computer…" until its screen appears. A Computer tab
  that was open when Aiden last quit shows **Start** instead, so launching
  Aiden never starts a computer. A computer that is waiting for a place,
  stopping, or was interrupted while it was being made says so in the tab.
- **The screen.** The tab shows the computer's screen live, with the Bot's
  avatar where it last pointed and a line saying what the Bot is doing. Frames
  are JPEG, at most about 10 a second and at most 2,560 pixels wide. A computer
  someone is watching counts as in use, so it is not stopped for being idle or
  to make a place, and its idle timer starts again when the last viewer closes.
- **Read-only while the Bot works.** While the Bot controls its computer, the
  screen only shows it. Your first click, key or scroll on the screen, or
  **Take over**, gives you control: Aiden interrupts the Bot's current computer
  action, and that first input is not sent to the computer. The Bot's computer
  actions are refused until you choose **Give back**, so it never works on a
  screen you are using.
- **Stopping gives it back.** When the computer stops while you control it
  (Pause, the idle stop, Stop, or a failure), control goes back to the Bot, so
  a call that was waiting goes on and its next call starts the computer again,
  instead of waiting for a Give back nobody can press on a stopped computer.
  The one exception is a sign-in card that holds the computer for you: that
  hold lasts until the card is answered or withdrawn. While Give, Reset,
  Remove, Delete Bot or Remove everything is making, replacing or deleting the
  computer, nothing starts it: a call that was waiting starts the fresh copy
  once Give or Reset is done, and finds no computer after the others.
- **What you leave on the screen.** While you control the computer, the Bot
  captures nothing. Once you give it back (or answer a sign-in card), the
  Bot's next capture shows whatever is on the screen. Password fields show
  only dots, but a one-time code, a recovery code or anything else left on
  the screen in plain text is in that capture, and captures use the screen
  even with element control on. Close or clear it before you give the
  computer back.
- **The screen never starts it.** In the tab, only Start or switching to
  Computer starts a stopped computer. The live screen connects only to a
  computer that is running at that moment, so a stop that lands just as the
  screen opens leaves the computer off.
- **Using it.** While you control it, clicks, drags, keys and scrolling on the
  focused screen go to the computer. Tab, Shift-Tab and Command shortcuts stay
  with Aiden, so the keyboard can always leave the screen. Giving it back, or
  closing the tab, lets go of any key or button still held down.
- **Float over chat** moves the screen into the floating player over the chat,
  with Take over or Give back in its header. Drag or resize it like the
  Simulator's player; **Dock** (or Escape anywhere but the screen) puts it back
  in the tab.
- **Only on this Mac.** The screen reaches the tab through a viewer that
  listens on `127.0.0.1` only, from the first time a Computer tab asks for it,
  behind short-lived grants like the Simulator viewer's. The screen-sharing
  password never leaves Aiden's main process, and the screen is not offered to
  Aiden Remote.

Launch Aiden with `AIDEN_BOT_COMPUTERS_RECORD_RFB=1` to record what the VNC
server sends (never the password) into `bot-computers/rfb-recordings/` in
Aiden's data folder for owner-Mac debugging. Delete recordings afterwards.

## Privacy and network

- **Manual downloads only.** The Debian 13 disk image and pinned snapshot
  packages are downloaded only after you choose **Set up** or **Update base**,
  with no credentials. Startup, listing, onboarding and background work never
  download, create or start a VM.
- **Pinned Lume.** Aiden runs only the Lume bundled inside its signed app
  (`Contents/Helpers/lume.app`). Before its first use in each launch it checks
  the bundle's location, size, SHA-256 and code signature (identifier
  `com.trycua.lume`, team `YCK386LBJ7`). It never looks Lume up on `PATH`, runs
  its installer, or runs `lume serve`, `lume update` or `lume pull`. Lume is
  updated only with an Aiden release.
- **Isolated Lume.** Every Lume process gets `LUME_TELEMETRY_ENABLED=false`,
  `LUME_UPDATE_CHECK=false`, a fixed `PATH` and its own `HOME` under Aiden's
  data folder, and every command names Aiden's own storage. Lume's own
  configuration in `~/.lume` is not used.
- **No host audio or clipboard.** Every VM start passes `--no-audio-device` and
  `--no-clipboard-device`, so the guest gets no virtio sound device (no host
  microphone or speaker) and no SPICE clipboard-sharing device.
- **Screen.** Each start sets a new random screen-sharing password. Aiden uses
  the computer's screen only if Lume reports it on `127.0.0.1`, and stops the
  computer if the screen-sharing port also answers on any of the Mac's network
  addresses.
- **SSH.** Aiden reaches the guest with its own key, kept in Aiden's data
  folder, and the guest's pinned host key (one per base Aiden built; a Bot
  computer presents the key of the base it was copied from). Password login and
  root login are turned off in the guest, agent and X11 forwarding are off, and
  nothing from the person's `~/.ssh` is used. The guest's account password is
  random and kept in Aiden's encrypted secret store.
- **Shared folder.** Only the Bot's `Computer` folder (inside its Aiden home)
  is shared into its computer, read-write over `virtiofs` at
  `/mnt/aiden-shared`, where it appears as `~/Shared` for both `lume` and
  `aiden-bot`.
- **Guest network.** Bot computers use Lume's default shared (NAT) network, so
  a guest can reach the internet and, like any NAT guest, services that listen
  on this Mac.

## Removal

- **Remove** in a Bot's Advanced tab stops and deletes that Bot's computer.
  Files in the Bot's `Computer` folder stay, and you can give the Bot a new
  computer later.
- **Reset** deletes the Bot's computer and makes a fresh copy of the current
  base. Files in the `Computer` folder stay.
- **Delete Bot** stops and deletes its computer, then erases the Bot's files,
  including its `Computer` folder.
- **Remove everything** in Settings → Computers & VMs → Bot computers asks
  first, then stops and deletes every Bot computer (including one an earlier
  launch left running), the base, the Linux download and any partial download,
  Aiden's SSH key and pinned host key, the guest password, and the Bot-computer
  settings. Files in each Bot's `Computer` folder stay. To use Bot computers
  again, choose Set up, which downloads Debian Linux again.
- **One at a time, in order:** Give, Reset, Remove and Delete Bot for the same
  Bot wait for each other and run in the order you chose them. Remove
  everything waits for any already chosen, and anything chosen after it waits
  for it.

Everything lives under `bot-computers/` in Aiden's data folder
(`~/Library/Application Support/Aiden Agent/` on a standard install).

## How the Bot uses its computer

- **Offered when.** A Bot gets its computer's tools when its access includes
  **Bot computer** (Full access includes it once Bot computers are set up) and
  it has been given a computer in its Advanced tab. Neither is offered on Linux
  or Intel Macs, or to a Bot without a computer of its own. The `computer` tool
  is separate from `computer_use`: Computer Use drives the person's Mac, while
  `computer` drives only the Bot's own Linux virtual machine.
- **`computer`** sees and acts through the computer's screen (VNC) and, via
  element control, lists an app's numbered AT-SPI elements and clicks them by
  number (see "Guest driver lane"). Its actions are `capture`, `click`,
  `double_click`, `right_click`, `drag`, `scroll`, `type`, `key`, `wait` and
  `verify`. Screenshots are JPEG, at most 1280 pixels on the long side, at
  quality 70, and coordinates are pixels of the newest screenshot. Requests to
  the model trim screenshots in batches, shared with workspace chats and the
  browser. A Bot whose model has no image input gets only `computer_shell`.
- **Linux key chords.** On the Linux guest, `Command` chords (such as
  `Command+C` or `Command+L`) are mapped to `Control` (`Control_L`) so models
  trained on macOS shortcuts work cleanly in Chromium, Firefox, LibreOffice and
  XFCE apps. Destructive shortcuts blocked by Computer Use remain blocked here
  too.
- **A stated intent on every change.** Each `click`, `double_click`,
  `right_click`, `drag`, `scroll`, `type` and `key` needs a short intent, such
  as "Click Place order". The status line ("Ada is using the computer: Click
  Place order"), the chat's step detail, rule cards and the rules read it. The
  text the Bot types is never shown back to the model, on a card or in the
  chat.
- **`computer_shell`** runs one command with `/bin/sh` inside the Linux
  computer over SSH as the separate unprivileged `aiden-bot` user (never
  `lume`, and without sudo privileges), for up to 120 seconds and 64 KiB of
  output, shown like `run_command`'s output. `~/Shared` links to the Bot's
  `Computer` folder. The model never sees the guest password or the
  screen-sharing password.
- **Starting and idle.** Either tool starts the computer when it isn't running,
  with "Starting Ada's computer…" as the step's progress, and each call
  restarts the idle timer. A routine's call starts it for the routine.
- **Take over.** While the person has the computer, nothing the Bot asks for
  runs and nothing is captured: a `computer` call waits until they give it
  back, then tells the Bot "The person used the computer; take a fresh capture
  first.", and a `computer_shell` command waits and then runs. On routine runs
  and Telegram turns, where nobody may be there to give it back, the run waits
  at most 5 minutes in all, across both tools. Take over stops a `computer`
  action in progress and releases any key or button it held; for a running
  `computer_shell` command it ends the SSH connection.
- **Rules.** Inside its own computer the Bot's baseline is allowed: nothing asks
  per click, because the virtual machine is the boundary. Rules still apply:
  purchase, communicate, publish and delete ask, credentials and money hand
  off, and the person's own rules match too. The rules read the stated intent
  and, under element control, the AT-SPI element acted on (its app, window, role
  and label; password roles such as `password-text` read as credentials). Shell
  commands aren't classified by rules. See [Bot rules](bot-rules.md).
- **Routines and Telegram.** Unlike the Bot's browser, which those turns never
  get, the Bot may use its own computer on routine runs and Telegram turns. A
  rule that would ask or hand off on those turns never waits: the call is
  blocked with what the person needs to do, and the Bot tells them in its reply.
- **Activity.** The Bot's status line reads "Using its computer" for
  `computer` and "Running a command" for `computer_shell`, on the Mac and on
  phones, through the existing activity phases.

## Guest driver lane (AT-SPI element control)

On Linux, element control requires no macOS TCC permission prompts and is set up
automatically during **Set up** and **Update base**.

- **Installed during Set up and Update base.** Aiden copies its pinned Linux
  arm64 `cua-driver` 0.38.0 executable
  (`resources/computer-use/cua-driver-linux-arm64-artifact.json`) into the base
  at `~/.local/share/aiden/cua-driver/cua-driver` along with its MIT notice
  (`LICENSE.cua-driver.md`). The guest verifies the copy with `/usr/bin/sha256sum`
  against Aiden's compiled pin (`CUA_DRIVER_LINUX_ARM64_UPSTREAM_PIN`) before
  moving it into place. Nothing is downloaded in the guest, no driver is ever
  found on `PATH`, and the driver is updated only with an Aiden release.
- **Runs as a `systemd --user` service.** `cua-driver.service` runs
  `cua-driver serve --socket … --pid-file … --no-overlay --no-permissions-gate`
  in the logged-in `lume` XFCE session (`DISPLAY=:0`), with telemetry, update
  checks and `run_script` off, guarded by `ConditionPathExists` on
  `~/.local/share/aiden/cua-driver.enabled`.
- **Graceful VNC fallback.** If the Linux arm64 driver is missing or fails its
  probe during Set up, the base still finishes on the VNC screen lane. If a
  browser rejects background X11 clicks on a specific control, the Bot can click
  through the screen (VNC) while still using element control to list and read.
- **What the Bot gets.** `capture` with `app` (such as "Chromium" or
  "Firefox") adds that app's numbered elements after the screenshot: role and
  label only, at most 100, never a field's value. `click`, `double_click` and
  `right_click` take `element` in place of `coordinate`; screenshots, `type`,
  `key`, `drag` and `scroll` stay on the VNC screen lane. The driver is reached
  over Aiden's own SSH, one `cua-driver mcp --embedded` bridge per session, and
  the exact 0.38.0 tool catalog is checked before any call.

## Signing in on a Bot's computer

A Bot with a computer can ask the person to sign in to a site there: the
`sign_in` tool takes `where: "computer"` (a Bot with only a computer gets it
by default; one with the Browser too gets the Browser by default). It needs
Bot computers on this Mac, a computer given to the Bot, and an attended turn.

- **The card.** The sign-in card reads **Open Ada's computer** and says the
  page opens on Ada's own computer with you in control, that Ada waits until
  you answer, and never sees your password.
- **Open.** Aiden starts the computer if it is stopped, takes it over for you
  before anything shows on its screen, ends every process owned by the Bot's
  separate shell user (`sudo -n /usr/bin/pkill -KILL -u aiden-bot`), stops the
  guest driver (`systemctl --user stop cua-driver.service`, removes
  `cua-driver.enabled` and the socket), opens the site in Chromium inside the
  XFCE session (`DISPLAY=:0 chromium <origin>`), and brings the Computer tab
  forward. If any of that fails, nothing opens and the Bot gets its computer
  back.
- **Isolation during sign-in.** Because `computer_shell` runs as the separate
  unprivileged `aiden-bot` user (not the desktop user `lume`), terminating all
  `aiden-bot` processes at Open ensures no background shell process left behind
  by the Bot can restart the guest driver or observe the screen while you sign
  in.
- **Answering.** I'm done (I'm signed in on a phone), Skip, or the card being
  withdrawn (the Bot was stopped or paused) gives the computer back, unless you
  already gave it back or took it again from the viewer, which keeps it with
  you. The Bot then takes a fresh capture. The guest driver starts again on the
  Bot's next element step.
- **From a phone.** Aiden Remote keeps the card's **Finish on your Mac**: Open
  from the phone brings the Bot's chat forward on the Mac and opens the page
  on the Bot's computer there, with the person in control.

## Confirming on a Mac

Some Lume and Linux guest behaviour can't be checked in Linux CI. The fake Lume
CLI (`tests/e2e/lume-fake.mjs`) and the fixtures in
`main/services/bot-computers/fixtures/` follow Lume 0.8.0's source and should be
confirmed on an Apple-silicon Mac before release:

- `npm run bot-computers:vendor`, `npm run package` and
  `node scripts/verify-macos-package.mjs` (pinned hashes, signature,
  `com.apple.security.virtualization`, `embedded.provisionprofile`).
- First-launch upgrade on a Mac with existing macOS Bot computers: stops and
  deletes Aiden's macOS VMs and any `.ipsw` files, leaves other Lume/Cua VMs
  untouched, adds the one-line note to each migrated Bot's `MEMORY.md`, and
  displays the Settings notice with freed space.
- Full Linux Set up: downloads Debian 13 arm64 image, creates `aiden-base` with
  `lume create --os linux`, runs cloud-init and SSH provisioning from the pinned
  `snapshot.debian.org` timestamp, installs Linux arm64 `cua-driver` as a
  `systemd --user` service, and verifies XFCE + AT-SPI + `--no-audio-device` +
  `--no-clipboard-device`.
- Chromium sign-in handoff: Open stops `aiden-bot` processes and `cua-driver`,
  opens Chromium on `:0`, and restores control on completion.
- `AIDEN_BOT_COMPUTERS_ACCEPTANCE=1 npm run test:bot-computers:packaged` walks
  the packaged app from Set up through Take over, Pause, Delete Bot and Remove
  everything, and writes `build/bot-computers-acceptance-receipt.json`.
