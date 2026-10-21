# Bot computers

A Bot computer is a macOS virtual machine that belongs to one Bot, so the Bot
can work in apps without touching the person's own desktop. Bot computers are
opt-in, run only on a Mac with Apple silicon, and are built and managed with
[Lume](https://github.com/trycua/cua/tree/lume-v0.6.1/libs/lume) 0.6.1, which
ships inside Aiden.

This page covers setting up, sizing, limiting and removing Bot computers,
seeing and taking over a Bot's computer, and the tools a Bot uses inside it.

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

## Seeing and taking over

While a Bot has a computer, its chat's Bot panel has a **Computer** tab. The
tab never appears where Bot computers are unavailable (Intel Macs and Linux),
and it goes away when the computer is removed.

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

Confirming on a Mac: whether Apple's screen sharing accepts Aiden's sign-in,
pixel format, key codes and scroll buttons. Launch Aiden with
`AIDEN_BOT_COMPUTERS_RECORD_RFB=1` to record what the screen server sends
(never the password) into `bot-computers/rfb-recordings/` in Aiden's data
folder. The recordings show the guest's screen, so delete them afterwards.

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
- `AIDEN_BOT_COMPUTERS_ACCEPTANCE=1 npm run test:bot-computers:packaged` walks the packaged app from Set up through Take over, Pause, Delete Bot and Remove everything, and writes `build/bot-computers-acceptance-receipt.json`.

## How the Bot uses its computer

- **Offered when.** A Bot gets its computer's tools when its access includes
  **Bot computer** (Full access includes it once Bot computers are set up) and
  it has been given a computer in its profile. Neither is offered on Linux or
  Intel Macs, or to a Bot without a computer of its own. The `computer` tool is
  separate from `computer_use`: Computer Use drives the person's Mac, while
  `computer` drives only the Bot's own virtual machine.
- **`computer`** sees and acts through the computer's screen (the VNC lane):
  vision only, with no accessibility tree. Its actions are `capture`, `click`,
  `double_click`, `right_click`, `drag`, `scroll`, `type`, `key`, `wait` and
  `verify`. Screenshots are JPEG, at most 1280 pixels on the long side, at
  quality 70, and coordinates are pixels of the newest screenshot. Each request
  to the model carries only the newest three screenshots; older ones become a
  short note there, and the transcript keeps them all. A Bot whose model has no
  image input gets only `computer_shell`.
- **A stated intent on every change.** Each `click`, `double_click`,
  `right_click`, `drag`, `scroll`, `type` and `key` needs a short intent, such
  as "Click Place order". The status line ("Ada is using the computer: Click
  Place order"), the chat's step detail, rule cards and the rules read it. The
  text the Bot types is never shown back to the model, on a card or in the
  chat. Typed text can't contain line breaks or tabs, and the destructive
  shortcuts Computer Use blocks (such as Command-Q) are blocked here too.
- **`computer_shell`** runs one command with `/bin/sh` inside the computer, over
  SSH as the computer's user, for up to 120 seconds and 64 KiB of output, shown
  like `run_command`'s output. That user is the computer's administrator, but
  `sudo` and system changes need the guest password, which only Aiden holds.
  The model never sees the guest password or the screen-sharing password.
- **Starting and idle.** Either tool starts the computer when it isn't running,
  with "Starting Ada's computer…" as the step's progress, and each call
  restarts the idle timer. A routine's call starts it for the routine.
- **Take over.** While the person has the computer, nothing the Bot asks for
  runs and nothing is captured: a `computer` call waits until they give it
  back, then tells the Bot "The person used the computer; take a fresh capture
  first.", and a `computer_shell` command waits and then runs. Take over stops
  a `computer` action in progress and releases any key or button it held. For
  a running `computer_shell` command it ends the SSH connection and tells the
  Bot the command may have partly run or still be running: without a terminal
  the command itself isn't signalled, so it can go on in the computer until it
  ends or its time limit stops it.
  A screenshot from before Take over, or from an earlier run of the computer,
  no longer places a click.
- **Shared folder.** `<botHome>/Computer` is shared read-write into the
  computer at `/Volumes/My Shared Files`, which `~/Shared` links to. It is the
  one way files move between the computer and the Bot's Files panel.
- **Rules.** Inside its own computer the Bot's baseline is allowed: nothing asks
  per click, because the virtual machine is the boundary. Rules still apply:
  purchase, communicate, publish and delete ask, credentials and money hand
  off, and the person's own rules match too. The rules read the stated intent;
  a key chord that does more than type a character (Return, Command-S) counts
  as pressing a button. "Install software" covers the person's Mac, not the
  Bot's own computer, though a rule of the person's own can still cover an
  install there. Shell commands aren't classified by rules.
- **The VNC-lane gap.** Clicks are only coordinates, so the rules depend on the
  Bot's own description of each step. The tool's guidance tells the Bot to
  call `hand_off` for passwords, codes and payments and let the person do those
  steps, and the rules editor says so. A rule's hand-off card has no Open
  button in this lane.
- **Routines and Telegram.** Unlike the Bot's browser, which those turns never
  get, the Bot may use its own computer on routine runs and Telegram turns,
  where nobody is watching, and without asking per step as Computer Use on the
  person's Mac does. A rule that would ask or hand off on those turns never
  waits: the call is blocked with what the person needs to do, and the Bot tells them in
  its reply. Those turns have no `hand_off`, so there the tool's guidance tells
  the Bot never to enter passwords, codes or payment details and to say in its
  reply what the person needs to do instead.
- **Network.** The computer uses Lume's default shared (NAT) network, so what
  the Bot does there can reach the open internet and services listening on the
  Mac's network interfaces. Aiden Remote on those interfaces still needs a
  paired device.
- **Activity.** The Bot's status line reads "Using its computer" for
  `computer` and "Running a command" for `computer_shell`, on the Mac and on
  phones, through the existing activity phases.
- **Confirming on a Mac.** With a set-up base and a Bot given a computer: a
  `computer` capture shows the guest's screen at most 1280 pixels wide, a click
  at a screenshot's coordinate lands there, `type` enters text with the right
  shifted characters, Command shortcuts work, Take over during a long `type`
  stops it and leaves no key held, and a `computer_shell` `ls ~/Shared` lists
  the Bot's `Computer` folder.
