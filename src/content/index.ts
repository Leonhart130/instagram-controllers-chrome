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
    // A video appearing or disappearing changes the answer to "what is under
    // the pointer" without the pointer moving. Instagram virtualises the feed
    // and reels, so this is the ordinary case, not an edge one.
    if (scan()) scheduleHover();
  });
}

function checkNavigation(): void {
  if (!consumeLocationChange()) return;
  bar.detach();
  setActiveVideo(null);
  // Detaching without re-evaluating is how the bar disappeared on reels:
  // scrolling settles, Instagram commits the reel's URL, we detach — and with
  // the pointer motionless nothing was left to bring the bar back.
  scheduleHover();
}

let pointerX = -1;
let pointerY = -1;
let evalQueued = false;

function onPointerMove(e: PointerEvent): void {
  pointerX = e.clientX;
  pointerY = e.clientY;
  scheduleHover();
}

function scheduleHover(): void {
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
function bigEnough(video: HTMLVideoElement, x: number, y: number): boolean {
  const r = video.getBoundingClientRect();
  return (
    r.width >= MIN_WIDTH &&
    r.height >= MIN_HEIGHT &&
    x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
  );
}

function videoAtPoint(x: number, y: number): HTMLVideoElement | null {
  if (x < 0 || y < 0) return null;
  const stack = document.elementsFromPoint(x, y);

  for (const el of stack) {
    // Our own bar, which sits above the video it belongs to.
    if (el === bar.host) return bar.video;
    // `continue`, not `return null`: elementsFromPoint is a penetrating list, so
    // a small decorative video in the stack must not abort the search for the
    // real one underneath it.
    if (el instanceof HTMLVideoElement && bigEnough(el, x, y)) return el;
  }

  // Nothing in the hit stack was a video. A video carrying pointer-events:none
  // is invisible to hit testing, and putting a click-catcher over the media and
  // taking the media out of hit testing is a very ordinary thing for a site to
  // do. Fall back to looking for one in the subtree we did hit.
  for (let el: Element | null = stack[0] ?? null; el && el !== document.body; el = el.parentElement) {
    for (const video of el.querySelectorAll("video")) {
      if (bigEnough(video, x, y)) return video;
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

  // The render loop parks itself when the bar is hidden, and only a re-evaluation
  // wakes it. Every way the answer can change without the pointer moving needs
  // to trigger one, or the bar simply never comes back.
  window.addEventListener("focus", scheduleHover);
  window.addEventListener("resize", scheduleHover);
  document.addEventListener("scroll", scheduleHover, { capture: true, passive: true });

  window.addEventListener("blur", () => bar.hide());
  // Pointer into the tab strip or the URL bar fires no blur, so without this the
  // bar stays up and the loop runs for the life of the tab.
  document.documentElement.addEventListener("pointerleave", () => bar.hide());
  window.addEventListener("popstate", scheduleScan);
}

void main();
