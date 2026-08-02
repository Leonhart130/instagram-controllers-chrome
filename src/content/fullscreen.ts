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

export function fullscreenVideo(): HTMLVideoElement | null {
  return marked && document.fullscreenElement ? marked.video : null;
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
