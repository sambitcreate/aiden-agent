#!/usr/bin/env bash

set -euo pipefail

distribution_dir="${1:-release/distribution}"
retry_attempts="${AIDEN_RELEASE_RETRY_ATTEMPTS:-4}"
retry_base_seconds="${AIDEN_RELEASE_RETRY_BASE_SECONDS:-2}"

if [[ ! "$retry_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "Release retry attempts must be a positive integer." >&2
  exit 1
fi
if [[ ! "$retry_base_seconds" =~ ^[0-9]+$ ]]; then
  echo "Release retry delay must be a non-negative integer." >&2
  exit 1
fi

for required_name in GH_TOKEN GITHUB_REPOSITORY GITHUB_SHA RELEASE_TAG RELEASE_VERSION RUNNER_TEMP; do
  if [[ -z "${!required_name:-}" ]]; then
    echo "Missing required release environment: $required_name" >&2
    exit 1
  fi
done

sleep_before_retry() {
  local attempt="$1"
  local delay=$((retry_base_seconds * attempt))
  if (( delay > 0 )); then
    sleep "$delay"
  fi
}

LOOKUP_OUTPUT=""

lookup_release() {
  local status
  set +e
  LOOKUP_OUTPUT="$(
    gh release view "$RELEASE_TAG" \
      --repo "$GITHUB_REPOSITORY" \
      --json tagName,targetCommitish,isDraft,assets \
      2>&1
  )"
  status=$?
  set -e

  if (( status == 0 )); then
    return 0
  fi
  if grep -Eq 'HTTP (404|[0-9.]+ 404)|404 Not Found|^release not found$' <<<"$LOOKUP_OUTPUT"; then
    return 1
  fi
  return 2
}

lookup_release_with_retry() {
  local attempt status
  for ((attempt = 1; attempt <= retry_attempts; attempt += 1)); do
    if lookup_release; then
      return 0
    else
      status=$?
    fi
    if (( status == 1 )); then
      return 1
    fi
    if (( attempt == retry_attempts )); then
      echo "GitHub release lookup did not settle after $retry_attempts attempts." >&2
      return 2
    fi
    sleep_before_retry "$attempt"
  done
}

release_matches_identity() {
  local expected_draft="$1"
  RELEASE_JSON="$LOOKUP_OUTPUT" node - "$GITHUB_SHA" "$expected_draft" <<'NODE'
const release = JSON.parse(process.env.RELEASE_JSON ?? "null");
const expectedSha = process.argv[2];
const expectedDraft = process.argv[3] === "true";
if (
  !release ||
  release.tagName !== process.env.RELEASE_TAG ||
  release.targetCommitish !== expectedSha ||
  release.isDraft !== expectedDraft
) {
  process.exit(1);
}
NODE
}

release_has_expected_assets() {
  RELEASE_JSON="$LOOKUP_OUTPUT" EXPECTED_ASSETS="$EXPECTED_ASSETS" node <<'NODE'
const release = JSON.parse(process.env.RELEASE_JSON ?? "null");
const expected = (process.env.EXPECTED_ASSETS ?? "").split("\n").filter(Boolean);
const assets = new Map(
  Array.isArray(release?.assets) ? release.assets.map((asset) => [asset.name, asset]) : [],
);
if (
  expected.length === 0 ||
  expected.some((name) => !assets.has(name) || !(assets.get(name)?.size > 0))
) {
  process.exit(1);
}
NODE
}

if lookup_release_with_retry; then
  echo "Release or draft $RELEASE_TAG already exists; refusing to replace update assets." >&2
  exit 1
else
  lookup_status=$?
  if (( lookup_status != 1 )); then
    exit 1
  fi
fi

cd "$distribution_dir"
shopt -s nullglob
dmg_assets=( *.dmg )
zip_assets=( *.zip )
if [[ "${#dmg_assets[@]}" -ne 1 || ! -f "${dmg_assets[0]}" ]]; then
  echo "Expected exactly one verified versioned DMG before publishing." >&2
  exit 1
fi
if [[ "${#zip_assets[@]}" -ne 1 || ! -f "${zip_assets[0]}" ]]; then
  echo "Expected exactly one verified versioned ZIP before publishing." >&2
  exit 1
fi
if [[ ! -f latest-mac.yml ]]; then
  echo "Expected verified latest-mac.yml before publishing." >&2
  exit 1
fi

website_dmg="$RUNNER_TEMP/Aiden-Agent-Beta-arm64.dmg"
cp -- "${dmg_assets[0]}" "$website_dmg"
shasum -a 256 -- "${dmg_assets[@]}" "${zip_assets[@]}" latest-mac.yml > SHA256SUMS
website_sha256="$(shasum -a 256 -- "$website_dmg" | awk '{ print $1 }')"
printf '%s  %s\n' "$website_sha256" "$(basename "$website_dmg")" >> SHA256SUMS

release_assets=(
  "${dmg_assets[@]}"
  "${zip_assets[@]}"
  latest-mac.yml
  SHA256SUMS
  "$website_dmg"
)
expected_asset_names=(
  "${dmg_assets[@]}"
  "${zip_assets[@]}"
  latest-mac.yml
  SHA256SUMS
  "$(basename "$website_dmg")"
)
EXPECTED_ASSETS="$(printf '%s\n' "${expected_asset_names[@]}")"
export EXPECTED_ASSETS RELEASE_TAG

draft_ready=false
for ((attempt = 1; attempt <= retry_attempts; attempt += 1)); do
  if gh release create "$RELEASE_TAG" \
    --repo "$GITHUB_REPOSITORY" \
    --target "$GITHUB_SHA" \
    --title "Aiden Agent $RELEASE_VERSION" \
    --notes "Aiden Agent beta release. Changes since the previous release:" \
    --generate-notes \
    --draft \
    -- "${release_assets[@]}"; then
    draft_ready=true
    break
  fi

  if lookup_release_with_retry; then
    if ! release_matches_identity true; then
      echo "Release creation collided with a release not owned by this workflow." >&2
      exit 1
    fi
    if gh release upload "$RELEASE_TAG" \
      --repo "$GITHUB_REPOSITORY" \
      --clobber \
      -- "${release_assets[@]}"; then
      draft_ready=true
      break
    fi
  else
    lookup_status=$?
    if (( lookup_status != 1 )); then
      exit 1
    fi
  fi

  if (( attempt == retry_attempts )); then
    echo "GitHub draft release could not be created after $retry_attempts attempts." >&2
    exit 1
  fi
  sleep_before_retry "$attempt"
done

if [[ "$draft_ready" != true ]] || ! lookup_release_with_retry; then
  echo "GitHub draft release could not be verified." >&2
  exit 1
fi
if ! release_matches_identity true || ! release_has_expected_assets; then
  echo "GitHub draft release identity or assets do not match the verified build." >&2
  exit 1
fi

published=false
for ((attempt = 1; attempt <= retry_attempts; attempt += 1)); do
  if gh release edit "$RELEASE_TAG" \
    --repo "$GITHUB_REPOSITORY" \
    --draft=false \
    --latest; then
    published=true
    break
  fi

  if lookup_release_with_retry && release_matches_identity false; then
    published=true
    break
  fi

  if (( attempt == retry_attempts )); then
    echo "GitHub draft release could not be published after $retry_attempts attempts." >&2
    exit 1
  fi
  sleep_before_retry "$attempt"
done

if [[ "$published" != true ]] || ! lookup_release_with_retry; then
  echo "Published GitHub release could not be verified." >&2
  exit 1
fi
if ! release_matches_identity false || ! release_has_expected_assets; then
  echo "Published GitHub release identity or assets do not match the verified build." >&2
  exit 1
fi
