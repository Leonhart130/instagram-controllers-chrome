/**
 * Fullscreen without touching Instagram's DOM structure.
 *
 * A fullscreened <video> cannot render child elements, so our bar would vanish.
 * Instead we fullscreen the video's wrapper and tag it with attributes that the
 * manifest-injected content.css keys off to stretch the video back to fill.
 * Only attributes are added, and only while fullscreen is active.
 */

const ATTR_ROOT = "data-igvc-fs-root";
const ATTR_VIDEO = "data-igvc-fs";

let marked: { root: HTMLElement; video: HTMLVideoElement } | null = null;

/**
 * The video we put into fullscreen, or null.
 *
 * Checks that our wrapper is *still* the fullscreen element, rather than that
 * something is: fullscreen can pass directly from our wrapper to another
 * element with no intervening null, and answering "yes" then would leave the
 * bar chasing a video nobody is looking at.
 */
export function fullscreenVideo(): HTMLVideoElement | null {
  if (!marked || document.fullscreenElement !== marked.root) return null;
  return marked.video;
}

/** Drop our marks unless our wrapper is still the fullscreen element. */
export function releaseIfInactive(): void {
  if (marked && document.fullscreenElement !== marked.root) unmark();
}

export async function toggleFullscreen(video: HTMLVideoElement): Promise<void> {
  if (document.fullscreenElement) {
    await document.exitFullscreen().catch(() => {});
    return;
  }

  const root = video.parentElement ?? video;
  root.setAttribute(ATTR_ROOT, "");
  video.setAttribute(ATTR_VIDEO, "");
  marked = { root, video };

  try {
    await root.requestFullscreen({ navigationUI: "hide" });
  } catch (err) {
    unmark();
    // Last resort: the video alone goes fullscreen, without our bar.
    await video.requestFullscreen().catch((fallbackErr) => {
      console.warn("[igvc] fullscreen refused:", err, fallbackErr);
    });
  }
}

export function unmark(): void {
  if (!marked) return;
  marked.root.removeAttribute(ATTR_ROOT);
  marked.video.removeAttribute(ATTR_VIDEO);
  marked = null;
}
