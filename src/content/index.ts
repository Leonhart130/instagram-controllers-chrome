/** Entry point: keeps the registry fresh and points the bar at whatever the
 *  pointer is hovering. */

import { bar } from "./bar";
import { fullscreenVideo } from "./fullscreen";
import { prefs } from "./prefs";
import { scan, setActiveVideo } from "./registry";
import { consumeLocationChange, isEnabledHere } from "./surface";

/** Ignore thumbnails and tiny inline previews — a bar would be unusable there. */
const MIN_WIDTH = 120;
const MIN_HEIGHT = 90;

let scanQueued = false;
function scheduleScan(): void {
  if (scanQueued) return;
  scanQueued = true;
  requestAnimationFrame(() => {
    scanQueued = false;
    checkNavigation();
    scan();
  });
}

function checkNavigation(): void {
  if (!consumeLocationChange()) return;
  bar.detach();
  setActiveVideo(null);
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

/**
 * The video under the pointer, honouring what is actually on top.
 *
 * elementsFromPoint rather than a loop over every registered video's rect: rects
 * know nothing about occlusion or clipping, so a feed video sitting behind the
 * post modal — or one parked off-screen inside a carousel's overflow:hidden
 * track — would win on area and steal the bar.
 */
function videoAtPoint(x: number, y: number): HTMLVideoElement | null {
  if (x < 0 || y < 0) return null;
  for (const el of document.elementsFromPoint(x, y)) {
    // Our own bar, which sits above the video it belongs to.
    if (el === bar.host) return bar.video;
    if (el instanceof HTMLVideoElement) {
      const r = el.getBoundingClientRect();
      if (r.width < MIN_WIDTH || r.height < MIN_HEIGHT) return null;
      return el;
    }
  }
  return null;
}

function evaluateHover(): void {
  evalQueued = false;
  checkNavigation();

  // In fullscreen every other video still has a real rect in the new viewport,
  // so hit-testing would happily re-target the bar to something behind it.
  const fsVideo = fullscreenVideo();
  if (fsVideo) {
    bar.attachTo(fsVideo);
    setActiveVideo(fsVideo);
    bar.show();
    return;
  }

  if (!isEnabledHere()) {
    bar.detach();
    setActiveVideo(null);
    return;
  }
  if (bar.isInteracting) return;

  const video = videoAtPoint(pointerX, pointerY);
  if (video) {
    bar.attachTo(video);
    setActiveVideo(video);
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
  window.addEventListener("popstate", scheduleScan);
}

void main();
