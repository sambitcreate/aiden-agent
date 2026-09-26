#!/bin/sh

set -eu

repository="sambitcreate/aiden-agent"
release_base="https://github.com/${repository}/releases"
requested_version="${AIDEN_VERSION:-}"
requested_format="auto"
expected_commit="${AIDEN_EXPECTED_COMMIT:-}"
user_install=false
download_only=""
print_plan=false
temporary=""
mounted=false
mountpoint=""
elevate=""
mac_stage_parent=""
mac_backup=""
mac_destination=""
mac_transaction=false
mac_had_existing=false
mac_promoted=false
linux_stage_parent=""

usage() {
  cat <<'EOF'
Aiden Agent installer

Usage: sh install.sh [options]

Options:
  --version VERSION          Install a specific released version.
  --format FORMAT            auto, dmg, deb, rpm, or appimage.
  --expected-commit SHA      Require this reviewed release commit on Linux.
  --user                     Use ~/Applications on macOS or AppImage on Linux.
  --download-only DIRECTORY  Verify and copy the installer without installing it.
  --plan                     Print the selected artifact without downloading it.
  -h, --help                 Show this help.

Examples:
  curl -fsSL https://raw.githubusercontent.com/sambitcreate/aiden-agent/main/install.sh | sh
  curl -fsSL https://raw.githubusercontent.com/sambitcreate/aiden-agent/main/install.sh | sh -s -- --version 0.41.0
EOF
}

fail() {
  printf 'Aiden installer: %s\n' "$*" >&2
  exit 1
}

has() {
  command -v "$1" >/dev/null 2>&1
}

cleanup() {
  preserve_mac_stage=false
  if [ "$mac_transaction" = true ] && [ -n "$mac_destination" ]; then
    if [ "$mac_promoted" = true ] && { [ -e "$mac_destination" ] || [ -L "$mac_destination" ]; }; then
      if ! privilege /bin/rm -rf "$mac_destination"; then
        preserve_mac_stage=true
      fi
    fi
    if [ "$mac_had_existing" = true ] && { [ -e "$mac_backup" ] || [ -L "$mac_backup" ]; }; then
      if [ -e "$mac_destination" ] || [ -L "$mac_destination" ]; then
        preserve_mac_stage=true
      elif ! privilege /bin/mv "$mac_backup" "$mac_destination"; then
        preserve_mac_stage=true
      fi
    fi
  fi
  if [ -n "$mac_stage_parent" ] && [ -d "$mac_stage_parent" ]; then
    if [ "$preserve_mac_stage" = true ]; then
      printf 'Aiden installer: rollback failed; preserved recovery files at %s\n' "$mac_stage_parent" >&2
    else
      privilege /bin/rm -rf "$mac_stage_parent" || true
    fi
  fi
  if [ -n "$linux_stage_parent" ] && [ -d "$linux_stage_parent" ]; then
    rm -rf -- "$linux_stage_parent"
  fi
  if [ "$mounted" = true ] && [ -n "$mountpoint" ]; then
    /usr/bin/hdiutil detach "$mountpoint" >/dev/null 2>&1 ||
      /usr/bin/hdiutil detach -force "$mountpoint" >/dev/null 2>&1 || true
  fi
  if [ -n "$temporary" ] && [ -d "$temporary" ]; then
    rm -rf -- "$temporary"
  fi
}

privilege() {
  if [ "$elevate" = "sudo" ]; then
    sudo "$@"
  else
    "$@"
  fi
}

backup_existing_macos_app() {
  # Arm recovery before the external move so a signal cannot hide the backup.
  mac_had_existing=true
  privilege /bin/mv "$mac_destination" "$mac_backup"
}

promote_macos_app() {
  # Arm rollback before the external move so a signal cannot leave a partial promotion.
  mac_promoted=true
  privilege /bin/mv "$staged_app" "$mac_destination"
}

trap cleanup EXIT
trap 'exit 1' HUP INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || fail "--version requires a value."
      requested_version=$2
      shift 2
      ;;
    --format)
      [ "$#" -ge 2 ] || fail "--format requires a value."
      requested_format=$2
      shift 2
      ;;
    --expected-commit)
      [ "$#" -ge 2 ] || fail "--expected-commit requires a value."
      expected_commit=$2
      shift 2
      ;;
    --user)
      user_install=true
      shift
      ;;
    --download-only)
      [ "$#" -ge 2 ] || fail "--download-only requires a directory."
      download_only=$2
      shift 2
      ;;
    --plan)
      print_plan=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

case "$(uname -s)" in
  Darwin) os="macos" ;;
  Linux) os="linux" ;;
  *) fail "unsupported operating system: $(uname -s)" ;;
esac

case "$(uname -m)" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64) arch="x64" ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

if [ "$os" = "macos" ] && [ "$arch" = "x64" ]; then
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || printf '0')" = "1" ]; then
    arch="arm64"
  fi
fi

if [ -z "$requested_version" ]; then
  has curl || fail "curl is required."
  latest_url=$(curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
    --location --retry 3 --output /dev/null --write-out '%{url_effective}' \
    "${release_base}/latest") || fail "could not resolve the latest release."
  requested_version=${latest_url##*/v}
fi

if ! printf '%s\n' "$requested_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z]+)*$'; then
  fail "invalid release version: $requested_version"
fi

case "$requested_format" in
  auto|dmg|deb|rpm|appimage) ;;
  *) fail "unsupported format: $requested_format" ;;
esac

format=$requested_format
if [ "$os" = "macos" ]; then
  [ "$format" = "auto" ] && format="dmg"
  [ "$format" = "dmg" ] || fail "macOS requires the dmg format."
  asset="Aiden-Agent-Beta-${requested_version}-${arch}.dmg"
else
  if [ "$format" = "auto" ]; then
    os_release=""
    [ -r /etc/os-release ] && os_release=$(cat /etc/os-release)
    if printf '%s\n' "$os_release" | grep -Eiq '(^|[=[:space:]\"])(debian|ubuntu|mint)([[:space:]\"]|$)' && has apt-get; then
      format="deb"
    elif printf '%s\n' "$os_release" | grep -Eiq '(^|[=[:space:]\"])(fedora|rhel|centos|rocky|almalinux)([[:space:]\"]|$)' && has dnf; then
      format="rpm"
    else
      format="appimage"
    fi
  fi
  case "$format:$arch" in
    deb:x64) asset="Aiden-Agent-${requested_version}-amd64-linux.deb" ;;
    deb:arm64) asset="Aiden-Agent-${requested_version}-arm64-linux.deb" ;;
    rpm:x64) asset="Aiden-Agent-${requested_version}-x86_64-linux.rpm" ;;
    rpm:arm64) asset="Aiden-Agent-${requested_version}-aarch64-linux.rpm" ;;
    appimage:x64) asset="Aiden-Agent-${requested_version}-x86_64-linux.AppImage" ;;
    appimage:arm64) asset="Aiden-Agent-${requested_version}-arm64-linux.AppImage" ;;
    *) fail "Linux supports deb, rpm, or appimage." ;;
  esac
  if [ "$user_install" = true ] && [ "$format" != "appimage" ]; then
    format="appimage"
    case "$arch" in
      x64) asset="Aiden-Agent-${requested_version}-x86_64-linux.AppImage" ;;
      arm64) asset="Aiden-Agent-${requested_version}-arm64-linux.AppImage" ;;
    esac
  fi
fi

if [ "$print_plan" = true ]; then
  printf 'os=%s\narch=%s\nformat=%s\nversion=%s\nasset=%s\n' \
    "$os" "$arch" "$format" "$requested_version" "$asset"
  exit 0
fi

has curl || fail "curl is required."
temporary=$(mktemp -d "${TMPDIR:-/tmp}/aiden-install.XXXXXX") ||
  fail "could not create a private temporary directory."
chmod 700 "$temporary"
asset_path="$temporary/$asset"
checksums="$temporary/SHA256SUMS"
asset_url="${release_base}/download/v${requested_version}/${asset}"
checksum_url="${release_base}/download/v${requested_version}/SHA256SUMS"

printf 'Downloading %s\n' "$asset"
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 \
  --output "$asset_path" "$asset_url" ||
  fail "the selected installer is not published for $os/$arch ($asset)."
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 \
  --output "$checksums" "$checksum_url" || fail "could not download SHA256SUMS."

checksum_lines=$(awk -v name="$asset" '$2 == name { count += 1; digest = $1 } END { if (count == 1) print digest }' "$checksums")
if ! printf '%s\n' "$checksum_lines" | grep -Eq '^[0-9a-f]{64}$'; then
  fail "SHA256SUMS does not contain one exact checksum for $asset."
fi
if has sha256sum; then
  actual_checksum=$(sha256sum "$asset_path" | awk '{print $1}')
elif has shasum; then
  actual_checksum=$(shasum -a 256 "$asset_path" | awk '{print $1}')
else
  fail "sha256sum or shasum is required."
fi
[ "$actual_checksum" = "$checksum_lines" ] || fail "installer checksum verification failed."

if [ "$os" = "linux" ]; then
  has gh || fail "GitHub CLI is required to authenticate Linux release provenance. Install gh and retry."
  if [ -z "$expected_commit" ]; then
    expected_commit=$(gh api "repos/${repository}/releases/tags/v${requested_version}" --jq .target_commitish) ||
      fail "could not resolve the release source commit."
    printf 'Using release-record commit %s; pass --expected-commit for an independently reviewed pin.\n' "$expected_commit"
  fi
  if ! printf '%s\n' "$expected_commit" | grep -Eq '^[0-9a-f]{40}$'; then
    fail "the expected release commit must be 40 lowercase hexadecimal characters."
  fi
  gh attestation verify "$asset_path" \
    --hostname github.com \
    --repo "$repository" \
    --signer-repo "$repository" \
    --signer-workflow "${repository}/.github/workflows/release.yml" \
    --cert-identity "https://github.com/${repository}/.github/workflows/release.yml@refs/heads/main" \
    --cert-oidc-issuer https://token.actions.githubusercontent.com \
    --source-ref refs/heads/main \
    --source-digest "$expected_commit" \
    --signer-digest "$expected_commit" \
    --deny-self-hosted-runners \
    --predicate-type https://slsa.dev/provenance/v1 \
    --format json >/dev/null || fail "Linux release provenance verification failed."
fi

verify_macos_app() {
  candidate=$1
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || fail "DMG does not contain a regular Aiden Agent.app."
  /usr/bin/codesign --verify --strict --verbose=2 "$candidate" >/dev/null 2>&1 ||
    fail "Aiden Agent signature verification failed."
  /usr/sbin/spctl --assess --type execute --verbose=2 "$candidate" >/dev/null 2>&1 ||
    fail "Gatekeeper rejected Aiden Agent."
  candidate_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$candidate/Contents/Info.plist")
  candidate_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$candidate/Contents/Info.plist")
  candidate_team=$(/usr/bin/codesign -dv --verbose=4 "$candidate" 2>&1 | sed -n 's/^TeamIdentifier=//p')
  [ "$candidate_id" = "com.sambitcreate.aiden-agent" ] || fail "unexpected macOS bundle identifier."
  [ "$candidate_version" = "$requested_version" ] || fail "unexpected macOS bundle version."
  [ "$candidate_team" = "5WP229CBB8" ] || fail "unexpected macOS signing team."
  candidate_arches=$(/usr/bin/lipo -archs "$candidate/Contents/MacOS/Aiden Agent")
  expected_arch=$( [ "$arch" = x64 ] && printf x86_64 || printf arm64 )
  case " $candidate_arches " in
    *" $expected_arch "*) ;;
    *) fail "the DMG executable does not support this Mac architecture." ;;
  esac
}

if [ "$os" = "macos" ]; then
  has codesign || fail "codesign is required."
  has spctl || fail "spctl is required."
  has diskutil || fail "diskutil is required."
  has hdiutil || fail "hdiutil is required."
  mountpoint="$temporary/mount"
  mkdir "$mountpoint"
  /usr/sbin/diskutil image attach --readOnly --nobrowse --mountPoint "$mountpoint" "$asset_path" >/dev/null
  mounted=true
  source_app="$mountpoint/Aiden Agent.app"
  verify_macos_app "$source_app"
fi

if [ -n "$download_only" ]; then
  mkdir -p "$download_only"
  cp "$asset_path" "$download_only/$asset"
  printf 'Verified installer copied to %s\n' "$download_only/$asset"
  exit 0
fi

if [ "$os" = "linux" ]; then
  case "$format" in
    deb)
      has apt-get || fail "apt-get is required to install the selected DEB."
      sudo apt-get install -y "$asset_path"
      ;;
    rpm)
      has dnf || fail "dnf is required to install the selected RPM."
      sudo dnf install -y "$asset_path"
      ;;
    appimage)
      app_dir="$HOME/.local/share/aiden-agent"
      bin_dir="$HOME/.local/bin"
      mkdir -p "$app_dir" "$bin_dir"
      app_destination="$app_dir/Aiden-Agent.AppImage"
      launcher="$bin_dir/aiden-agent"
      if [ -L "$app_destination" ] || [ -d "$app_destination" ]; then
        fail "existing AppImage destination is not a regular file."
      fi
      if [ -d "$launcher" ] && [ ! -L "$launcher" ]; then
        fail "existing aiden-agent launcher is a directory."
      fi
      linux_stage_parent=$(mktemp -d "$app_dir/.install.XXXXXX") ||
        fail "could not create private AppImage staging."
      chmod 700 "$linux_stage_parent"
      staged="$linux_stage_parent/Aiden-Agent.AppImage"
      cp "$asset_path" "$staged"
      chmod 755 "$staged"
      mv -fT "$staged" "$app_destination"
      rmdir "$linux_stage_parent"
      linux_stage_parent=""
      ln -sfnT "$app_destination" "$launcher"
      printf 'Installed Aiden Agent at %s\n' "$app_destination"
      printf 'Run %s/aiden-agent or add that directory to PATH.\n' "$bin_dir"
      ;;
  esac
  exit 0
fi

if has pgrep && pgrep -x 'Aiden Agent' >/dev/null 2>&1; then
  fail "quit Aiden Agent before installing an update."
fi

if [ "$user_install" = true ]; then
  install_parent="$HOME/Applications"
  mkdir -p "$install_parent"
else
  install_parent="/Applications"
  elevate="sudo"
fi
mac_destination="$install_parent/Aiden Agent.app"
if [ -e "$mac_destination" ] || [ -L "$mac_destination" ]; then
  [ ! -L "$mac_destination" ] && [ -d "$mac_destination" ] || fail "existing destination is not an application directory."
  existing_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$mac_destination/Contents/Info.plist" 2>/dev/null || true)
  [ "$existing_id" = "com.sambitcreate.aiden-agent" ] || fail "existing destination is not Aiden Agent."
fi

mac_stage_parent=$(privilege /usr/bin/mktemp -d "$install_parent/.aiden-install.XXXXXX")
mac_transaction=true
privilege /bin/chmod 0711 "$mac_stage_parent"
staged_app="$mac_stage_parent/new.app"
mac_backup="$mac_stage_parent/previous.app"
privilege /usr/bin/ditto "$source_app" "$staged_app"
verify_macos_app "$staged_app"
if [ -e "$mac_destination" ]; then
  backup_existing_macos_app
fi
if ! promote_macos_app; then
  fail "could not promote the staged application."
fi
verify_macos_app "$mac_destination"
mac_transaction=false
if [ -e "$mac_backup" ]; then
  privilege /bin/rm -rf "$mac_backup"
fi
privilege /bin/rmdir "$mac_stage_parent"
mac_stage_parent=""
printf 'Installed Aiden Agent %s at %s\n' "$requested_version" "$mac_destination"
