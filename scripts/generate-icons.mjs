/**
 * Converts app-icon.svg → all PNG sizes required by Tauri + tray.svg → tray.png
 *
 * Usage: node scripts/generate-icons.mjs
 * Requires: npm install --save-dev sharp
 */

import sharp from "sharp";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

const __dir = dirname(fileURLToPath(import.meta.url));
const icons = resolve(__dir, "../src-tauri/icons");

mkdirSync(icons, { recursive: true });

const appIcon = resolve(icons, "app-icon.svg");
const trayIcon = resolve(icons, "tray.svg");

// ── Tauri required sizes ─────────────────────────────────────────────────────
const appSizes = [
  { size: 32,   file: "32x32.png" },
  { size: 128,  file: "128x128.png" },
  { size: 256,  file: "128x128@2x.png" },  // retina 128
  { size: 1024, file: "icon.png" },         // source for .icns / .ico
];

// ── Tray icon sizes ──────────────────────────────────────────────────────────
const traySizes = [
  { size: 32,  file: "tray.png" },           // standard
  { size: 64,  file: "tray@2x.png" },        // HiDPI
];

async function convert(src, { size, file }) {
  const dest = resolve(icons, file);
  await sharp(src)
    .resize(size, size)
    .png()
    .toFile(dest);
  console.log(`  ✓ ${file} (${size}×${size})`);
}

async function main() {
  console.log("Generating app icons from app-icon.svg…");
  for (const spec of appSizes) await convert(appIcon, spec);

  console.log("Generating tray icons from tray.svg…");
  for (const spec of traySizes) await convert(trayIcon, spec);

  // macOS .icns hint
  console.log("\nDone. On macOS, run `tauri icon src-tauri/icons/icon.png`");
  console.log("to generate the .icns and .ico bundles automatically.");
}

main().catch((e) => { console.error(e); process.exit(1); });
