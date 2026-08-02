/**
 * Which part of Instagram we are looking at.
 *
 * Derived from the URL only — Instagram's class names are obfuscated and rotate,
 * so they are never a safe anchor. Add a surface to ENABLED to turn the bar on
 * there; each new surface has its own overlay stack and is worth testing before
 * being switched on.
 *
 * Stories stay off deliberately rather than by omission: they draw their own
 * segment progress bar and pause-on-hold, which a second scrubber sitting on top
 * of would fight with. Direct and explore are simply untested.
 */

export type Surface =
  | "feed"
  | "post"
  | "reels"
  | "reel"
  | "stories"
  | "direct"
  | "explore"
  | "profile"
  | "other";

const ENABLED = new Set<Surface>(["feed", "post", "reels", "reel"]);

export function surfaceOf(path: string = location.pathname): Surface {
  if (path === "/" || path === "") return "feed";
  if (/^\/p\/[^/]+/.test(path)) return "post";
  // The player feed only. /reels/audio/<id>/ is a thumbnail grid.
  if (/^\/reels\/?$/.test(path)) return "reels";
  if (/^\/reel\/[^/]+/.test(path)) return "reel";
  if (/^\/stories(\/|$)/.test(path)) return "stories";
  if (/^\/direct(\/|$)/.test(path)) return "direct";
  if (/^\/explore(\/|$)/.test(path)) return "explore";
  if (/^\/accounts(\/|$)/.test(path)) return "other";
  if (/^\/[^/]+\/?$/.test(path)) return "profile";
  return "other";
}

export function isEnabledHere(): boolean {
  return ENABLED.has(surfaceOf());
}

let lastHref = location.href;

/**
 * True exactly once per SPA navigation.
 *
 * Deliberately polled rather than hooked: a content script runs in an isolated
 * world, so assigning `history.pushState` there only shadows the isolated
 * world's own wrapper. Instagram's page script resolves the method through the
 * main world and would never touch the patched version, so a hook silently
 * observes nothing. Callers poll this from work they already do every frame.
 */
export function consumeLocationChange(): boolean {
  if (location.href === lastHref) return false;
  lastHref = location.href;
  return true;
}
