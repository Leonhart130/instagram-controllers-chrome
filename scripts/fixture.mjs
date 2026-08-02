/**
 * Populates .fixtures/clip.webm — a real, decodable video for the harness.
 *
 * It has to be genuine media rather than a scripted stand-in: duration,
 * currentTime and paused are DOM state, shared with the extension's isolated
 * world, while JavaScript properties defined on the element are not
 * (LESSONS §6.1).
 *
 * The file is not committed — it is a few hundred KB and not ours to
 * redistribute — so point this at one you already have:
 *
 *     npm run fixture -- /path/to/any-short-clip.webm
 *
 * With no argument it looks in a couple of places a Linux desktop usually has
 * one. Any short .webm works; nothing depends on its content or duration.
 */

import { access, copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

const DEST_DIR = new URL("../.fixtures", import.meta.url).pathname;
const DEST = join(DEST_DIR, "clip.webm");

/** Only used when no path is given on the command line. */
const FALLBACKS = [
  "/usr/share/help/C/gnome-help/figures/display-dual-monitors.webm",
  "/usr/share/doc/libwebp-dev/examples/test.webm",
];

const explicit = process.argv[2];

async function install(src, why) {
  await mkdir(DEST_DIR, { recursive: true });
  await copyFile(src, DEST);
  const { size } = await stat(DEST);
  console.log(`[igvc] fixture: ${why} ${src} -> .fixtures/clip.webm (${size} bytes)`);
}

if (explicit) {
  try {
    await access(explicit);
  } catch {
    console.error(`\n[igvc] no such file: ${explicit}\n`);
    process.exit(2);
  }
  await install(explicit, "copied");
  process.exit(0);
}

try {
  await access(DEST);
  const { size } = await stat(DEST);
  console.log(`[igvc] fixture already present: .fixtures/clip.webm (${size} bytes)`);
  process.exit(0);
} catch {
  /* need to create it */
}

for (const src of FALLBACKS) {
  try {
    await access(src);
    await install(src, "found");
    process.exit(0);
  } catch {
    /* try the next one */
  }
}

console.error(
  "\n[igvc] no clip found. Point this at any short .webm you have:\n" +
    "    npm run fixture -- /path/to/clip.webm\n" +
    "or drop one at .fixtures/clip.webm yourself.\n",
);
process.exit(2);
