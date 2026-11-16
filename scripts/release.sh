#!/usr/bin/env bash
# Usage: scripts/release.sh 0.2.1 "바뀐 점 한 줄"
# Builds the signed Windows installer on this Mac, then publishes it with latest.json as a GitHub
# release. Installed apps read releases/latest/download/latest.json and offer the update.
set -euo pipefail
cd "$(dirname "$0")/.."
v=${1:?version, e.g. 0.2.1}
notes=${2:-}
repo=team-poem/aphendo
key=${APHENDO_SIGNING_KEY:-$HOME/.tauri/aphendo.key}

[[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]] || { echo "잘못된 버전입니다" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "커밋 안 된 변경이 있습니다" >&2; exit 1; }
[ -f "$key" ] || { echo "기존 서명 키가 없습니다. 새 키를 만들지 말고 백업에서 복구하세요: $key" >&2; exit 1; }
TAURI_SIGNING_PRIVATE_KEY="$key" node scripts/release-signing.mjs preflight
pnpm test
pnpm test:release

node -e '
  const fs = require("fs"), p = "src-tauri/tauri.conf.json", c = JSON.parse(fs.readFileSync(p));
  c.version = process.argv[1];
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");' "$v"

dir=target/x86_64-pc-windows-msvc/release/bundle/nsis
exe="Aphendo_${v}_x64-setup.exe"
rm -f "$dir/$exe" "$dir/$exe.sig" "$dir/latest.json"

TAURI_SIGNING_PRIVATE_KEY="$key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
  pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis -- --locked

node scripts/release-signing.mjs prepare "$dir/$exe" "$notes"

git diff --quiet || git commit -qam "release: v$v"
git tag "v$v"
git push -q origin HEAD "v$v"
gh release create "v$v" "$dir/$exe" "$dir/$exe.sig" "$dir/latest.json" --repo "$repo" --title "v$v" --notes "${notes:-v$v}" --verify-tag
