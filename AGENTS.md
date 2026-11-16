# Update signing

- Preserve the updater key used by v0.2.17 and later. Routine releases must not generate, replace, or rotate it, or change `plugins.updater.pubkey`, `scripts/updater-public-key.pub`, or the GitHub variable `TAURI_SIGNING_PUBLIC_KEY`.
- If the signing key is unavailable or mismatched, stop release work and recover the existing key from its backup. A new key is not a substitute: installed apps would reject it.
- Use `scripts/release.sh` or `.github/workflows/release.yml`. Both must check the private key before building and verify the final installer signature before uploading.
- Keep private keys out of Git, logs, issues, and release assets. GitHub Actions uses the existing `TAURI_SIGNING_PRIVATE_KEY` secret; local builds use `~/.tauri/aphendo.key` or `APHENDO_SIGNING_KEY`.
- A deliberate key rotation requires an explicit migration plan that works for installed versions and separate user authorization. Do not bypass signature checks to fix an update failure.
