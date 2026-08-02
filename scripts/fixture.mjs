/**
 * Populates .fixtures/clip.webm — a real, decodable video for the harness.
 *
 * It has to be genuine media rather than a scripted stand-in: duration,
 * currentTime and paused are DOM state, shared with the extension's isolated
 * world, while JavaScript properties defined on the element are not.
 *
 * The file is not committed (licensing, and it is 600 KB), so this copies one
 * from the system. Any short webm will do; swap in your own if you prefer.
 */

import { access, copyFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEST_DIR = new URL("../.fixtures", import.meta.url).pathname;
const DEST = join(DEST_DIR, "clip.webm");

const CANDIDATES = [
  "/usr/share/help/C/gnome-help/figures/display-dual-monitors.webm",
  join(homedir(), ".local/share/Steam/steamui/movies/steam_os_startup.webm"),
  join(homedir(), ".local/share/Steam/steamui/movies/deck_startup.webm"),
];

try {
  await access(DEST);
  const { size } = await stat(DEST);
  console.log(`[igvc] fixture already present: .fixtures/clip.webm (${size} bytes)`);
  process.exit(0);
} catch {
  /* need to create it */
}

await mkdir(DEST_DIR, { recursive: true });

for (const src of CANDIDATES) {
  try {
    await access(src);
    await copyFile(src, DEST);
    const { size } = await stat(DEST);
    console.log(`[igvc] fixture: copied ${src} -> .fixtures/clip.webm (${size} bytes)`);
    process.exit(0);
  } catch {
    /* try the next one */
  }
}

console.error(
  "\n[igvc] no source clip found. Drop any short .webm at .fixtures/clip.webm and re-run.\n" +
    "Tried:\n" + CANDIDATES.map((c) => `  ${c}`).join("\n") + "\n",
);
process.exit(2);
