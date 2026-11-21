#!/bin/sh
# Aiden's Linux DEB/RPM update installer. Shipped root-owned at
# "/opt/Aiden Agent/Helpers/aiden-package-install" and run as root, either by
# pkexec after the person approves the desktop password prompt or directly when
# Aiden itself runs as root.
#
# The download it is given lives in the person's own cache, which any process
# of theirs can change at any time. So root first copies it into a fresh
# root-only folder and checks THAT copy: its SHA-512 against the release feed,
# then that it is the aiden-agent package at the announced version. Only the
# checked copy reaches apt-get or dnf.
#
# Usage: aiden-package-install deb|rpm <download> <sha512-hex> <version>
# Exit 0 installed, 2 bad arguments, 3 the package failed verification, other
# codes come from the package manager.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

[ "$#" -eq 4 ] || exit 2
kind=$1
source=$2
expected_sha512=$3
expected_version=$4

case "$kind" in deb | rpm) ;; *) exit 2 ;; esac
case "$source" in /*) ;; *) exit 2 ;; esac
case "$expected_sha512" in "" | *[!0-9a-f]*) exit 2 ;; esac
[ "${#expected_sha512}" -eq 128 ] || exit 2
case "$expected_version" in "" | *[!0-9.]* | .* | *.) exit 2 ;; esac

work=$(mktemp -d /var/tmp/aiden-update.XXXXXX)
trap 'rm -rf -- "$work"' EXIT
staged="$work/aiden-agent.$kind"
cp -- "$source" "$staged" || exit 3

actual_sha512=$(sha512sum -- "$staged" | cut -d ' ' -f 1)
[ "$actual_sha512" = "$expected_sha512" ] || exit 3

if [ "$kind" = deb ]; then
  identity=$(dpkg-deb --showformat='${Package} ${Version}' --show "$staged") || exit 3
  [ "$identity" = "aiden-agent $expected_version" ] || exit 3
  DEBIAN_FRONTEND=noninteractive apt-get install --yes "$staged"
else
  identity=$(rpm -qp --nosignature --nodigest --queryformat '%{NAME} %{VERSION}' "$staged") || exit 3
  [ "$identity" = "aiden-agent $expected_version" ] || exit 3
  dnf install --assumeyes "$staged"
fi
