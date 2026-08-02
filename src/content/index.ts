/** Entry point: keeps the registry fresh and points the bar at whatever the
 *  pointer is hovering. */

import { bar } from "./bar";
import { prefs } from "./prefs";
import { getVideos, scan } from "./registry";
import { isEnabledHere, onLocationChange } from "./surface";

/** Ignore thumbnails and tiny inline previews — a bar would be unusable there. */
const MIN_WIDTH = 120;
const MIN_HEIGHT = 90;

let scanQueued = false;
function scheduleScan(): void {
  if (scanQueued) return;
  scanQueued = true;
  requestAnimationFrame(() => {
    scanQueued = false;
    scan();
  });
}

let pointerX = -1;
let pointerY = -1;
let evalQueued = false;

function onPointerMove(e: PointerEvent): void {
  pointerX = e.clientX;
  pointerY = e.clientY;
  if (evalQueued) return;
  evalQueued = true;
  requestAnimationFrame(evaluateHover);
}

function evaluateHover(): void {
  evalQueued = false;

  if (!isEnabledHere()) {
    bar.detach();
    return;
  }
  if (bar.isInteracting) return;

  let best: HTMLVideoElement | null = null;
  let bestArea = Infinity;

  for (const video of getVideos()) {
    const r = video.getBoundingClientRect();
    if (r.width < MIN_WIDTH || r.height < MIN_HEIGHT) continue;
    if (pointerX < r.left || pointerX > r.right || pointerY < r.top || pointerY > r.bottom) continue;
    const area = r.width * r.height;
    // Innermost match wins when videos are nested inside one another.
    if (area < bestArea) {
      bestArea = area;
      best = video;
    }
  }

  if (best) {
    bar.attachTo(best);
    bar.show();
  } else {
    bar.hide();
  }
}

async function main(): Promise<void> {
  await prefs.load();
  scan();

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  document.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
  document.addEventListener("pointerdown", onPointerMove, { capture: true, passive: true });

  window.addEventListener("blur", () => bar.hide());
  onLocationChange(() => {
    bar.detach();
    scheduleScan();
  });
}

void main();
