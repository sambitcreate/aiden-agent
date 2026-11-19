# Linux .deb/.rpm in-app updates — 2026-11-19

Owner report: "linux app cant autoupdate". Cause: `install.sh` picks the `.deb` on
Ubuntu/Debian and the `.rpm` on Fedora, but the app only self-updated as a mounted
AppImage (`canUpdateLinuxAppImage`), and `latest-linux*.yml` listed only the
AppImage. The 0.66.0 `.deb` already shipped `resources/app-update.yml` and
`resources/package-type` (`deb`), so only Aiden's own gate and the feed blocked it.

Owner chose option A (update button in Aiden, password prompt) over an apt/dnf
repository or switching to the AppImage.

## What changed

- `scripts/prepare-linux-update-feed.mjs` lists AppImage, DEB and RPM (AppImage
  first and still in the legacy `path`/`sha512` fields for old AppImage builds).
  electron-updater's `findFile` picks by extension.
- `main/services/app-updater-linux-package.ts`: eligibility (package-type deb/rpm,
  no APPIMAGE, root-owned and not group/world-writable install, dpkg `.list` owns
  the running executable, fixed tools incl. `/usr/bin/pkexec` unless root) and the
  installer (stage into private mkdtemp while re-hashing, `dpkg-deb --show` /
  `rpm -qp` name+version check, `pkexec apt-get install --yes` / `pkexec dnf install
  --assumeyes`, no shell, read back installed version). pkexec exit 126 = cancelled.
- `app-updater.ts` uses Deb/RpmUpdater for check+download only (`doInstall` false,
  `autoInstallOnAppQuit` false). `app:restartToUpdate` awaits
  `prepareDownloadedUpdateInstall()` BEFORE the quit, so a closed prompt leaves
  Aiden open; new restart reasons `install-cancelled` / `install-failed`.
- Capability `appUpdateNeedsPassword` drives the About "ready" text.

## Found on the way: world-writable package files

Electron's Linux zip stores most files as 0666/0777 and electron-builder carried
that into the 0.66.0 DEB/RPM (`/opt/Aiden Agent/aiden-agent` was 0777). The
`afterPack` hook (`removeSharedWriteAccess`) now strips go-w, and
`verify-linux-package.mjs` fails such a package. The eligibility check requires
go-w off, so it depends on this fix.

## Evidence

Container (Ubuntu 24.04, root, dbus + polkitd started by hand): installed the real
0.66.0 amd64 `.deb`; eligibility = deb; a repacked 0.67.0 `.deb` installed through
the real `/usr/bin/pkexec /usr/bin/apt-get`, dpkg-query read 0.67.0, staging
folder removed; a wrong expected version was refused before pkexec ran. Not tested:
the GNOME password dialog itself, RPM on a real Fedora, the full electron-updater
download from a published release (needs the first release with this change).
Existing 0.66.0 .deb users must install the next release once by hand.
