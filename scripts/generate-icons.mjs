import { mkdirSync, mkdtempSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { BRAND_CHECK, BRAND_FRAME, BRAND_LIME, BRAND_PURPLE } from "../ui/src/brand-geometry.ts";

const root = new URL("../", import.meta.url);
const require = createRequire(import.meta.url);
const source = new URL("ui/public/aphendo.svg", root);
mkdirSync(new URL("ui/public/", root), { recursive: true });
writeFileSync(source, `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 256 256" fill="none" stroke-linecap="round" stroke-linejoin="round">
  <path d="${BRAND_FRAME}" stroke="${BRAND_PURPLE}" stroke-width="40"/>
  <path d="${BRAND_CHECK}" stroke="${BRAND_PURPLE}" stroke-width="64"/>
  <path d="${BRAND_CHECK}" stroke="${BRAND_LIME}" stroke-width="36"/>
</svg>\n`);
const output = mkdtempSync(join(tmpdir(), "aphendo-icons-"));
try {
  execFileSync(process.execPath, [require.resolve("@tauri-apps/cli/tauri.js"), "icon", fileURLToPath(source), "--output", output], { cwd: root, stdio: "inherit" });
  for (const name of ["32x32.png", "128x128.png", "128x128@2x.png", "icon.png", "icon.ico", "icon.icns"]) {
    copyFileSync(join(output, name), new URL(`src-tauri/icons/${name}`, root));
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
