/**
 * Which part of Instagram we are looking at.
 *
 * Derived from the URL only — Instagram's class names are obfuscated and rotate,
 * so they are never a safe anchor. Add a surface to ENABLED to turn the bar on
 * there; each new surface has its own overlay stack and is worth testing before
 * being switched on.
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

const ENABLED = new Set<Surface>(["feed", "post"]);

export function surfaceOf(path: string = location.pathname): Surface {
  if (path === "/" || path === "") return "feed";
  if (/^\/p\/[^/]+/.test(path)) return "post";
  if (/^\/reels(\/|$)/.test(path)) return "reels";
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

/** Fires on SPA navigation, which never triggers a page load on Instagram. */
export function onLocationChange(cb: () => void): void {
  let last = location.href;
  const check = () => {
    if (location.href === last) return;
    last = location.href;
    cb();
  };

  for (const name of ["pushState", "replaceState"] as const) {
    const original = history[name];
    history[name] = function (this: History, ...args: never[]) {
      const result = (original as (...a: never[]) => unknown).apply(this, args);
      queueMicrotask(check);
      return result;
    } as History[typeof name];
  }
  window.addEventListener("popstate", check);
}
