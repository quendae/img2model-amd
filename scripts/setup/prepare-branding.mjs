import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const desktopDir = path.join(repoRoot, "apps", "desktop");
const iconsDir = path.join(desktopDir, "src-tauri", "icons");
const sourceB64Path = path.join(iconsDir, "icon-source.png.b64");
const sourcePngPath = path.join(iconsDir, "icon-source.png");
const iconIcoPath = path.join(iconsDir, "icon.ico");

const encoded = (await readFile(sourceB64Path, "utf8")).trim();
const sourcePng = Buffer.from(encoded, "base64");
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (sourcePng.length < 8_000 || !sourcePng.subarray(0, 8).equals(pngSignature)) {
  throw new Error("Img2Model AMD icon source is not a valid approved PNG asset.");
}
await writeFile(sourcePngPath, sourcePng);

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const generated = spawnSync(
  npmCommand,
  ["run", "tauri", "--", "icon", "src-tauri/icons/icon-source.png"],
  { cwd: desktopDir, stdio: "inherit" },
);
if (generated.error) {
  throw generated.error;
}
if (generated.status !== 0) {
  throw new Error(`Tauri icon generation failed with exit code ${generated.status}.`);
}

const ico = await readFile(iconIcoPath);
if (ico.length <= 10_000 || ico[0] !== 0 || ico[1] !== 0 || ico[2] !== 1 || ico[3] !== 0) {
  throw new Error("Generated icon.ico is missing or is not a valid Windows ICO.");
}
const imageCount = ico.readUInt16LE(4);
if (imageCount < 6) {
  throw new Error(`Generated icon.ico contains only ${imageCount} sizes; expected at least 6.`);
}

console.log(`Prepared Img2Model AMD branding: icon.ico (${ico.length} bytes, ${imageCount} sizes).`);
