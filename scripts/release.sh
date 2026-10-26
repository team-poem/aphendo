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

[ -z "$(git status --porcelain)" ] || { echo "커밋 안 된 변경이 있습니다" >&2; exit 1; }
[ -f "$key" ] || { echo "업데이트 서명 키가 없습니다: $key" >&2; exit 1; }

node -e '
  const fs = require("fs"), p = "src-tauri/tauri.conf.json", c = JSON.parse(fs.readFileSync(p));
  c.version = process.argv[1];
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");' "$v"

TAURI_SIGNING_PRIVATE_KEY="$key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
  pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis

dir=target/x86_64-pc-windows-msvc/release/bundle/nsis
exe="Aphendo_${v}_x64-setup.exe"
node -e '
  const fs = require("fs"), [dir, exe, v, notes, repo] = process.argv.slice(1);
  fs.writeFileSync(`${dir}/latest.json`, JSON.stringify({
    version: v,
    notes,
    pub_date: new Date().toISOString(),
    platforms: { "windows-x86_64": {
      signature: fs.readFileSync(`${dir}/${exe}.sig`, "utf8"),
      url: `https://github.com/${repo}/releases/download/v${v}/${exe}`,
    } },
  }, null, 2));' "$dir" "$exe" "$v" "$notes" "$repo"

git diff --quiet || git commit -qam "release: v$v"
git tag "v$v"
git push -q origin HEAD "v$v"
gh release create "v$v" "$dir/$exe" "$dir/latest.json" --repo "$repo" --title "v$v" --notes "${notes:-v$v}"
