# Instagram Video Controls

A Chrome/Brave extension that puts a real player bar on Instagram videos: play/pause, a seek bar
you can scrub, volume with a remembered mute state, and fullscreen.

Instagram ships videos with no controls and covers each one with click-catcher layers that own
play/pause and mute. This replaces that with an actual player.

**Scope today:** the feed (`/`) and the post modal (`/p/<code>/`). Reels, stories, DMs and explore
are deliberately off — each has its own overlay stack and deserves to be tested before being
switched on. See "Enabling more surfaces" below.

## Install

```sh
npm install
npm run build
```

Then in Brave or Chrome:

1. Open `brave://extensions` (or `chrome://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `dist/` folder in this repo.
4. Open Instagram and hover a video.

After changing the code, run `npm run build` (or leave `npm run dev` running) and press the reload
icon on the extension card.

## Development

```sh
npm run dev        # esbuild watch, unminified with inline sourcemaps
npm run build      # minified production build into dist/
npm run typecheck  # tsc --noEmit
npm run icons      # regenerate public/icons/*.png
```

### The dev harness

`dev/index.html` reproduces Instagram's structure — a wrapper holding the video plus click-catcher
and control siblings stacked on top — without needing to be logged in. It stubs the media clock
(`duration`, `currentTime`, `paused`, `buffered`, `play()`, `pause()`) so behaviour is
deterministic and no video codec is involved, and leaves `volume`/`muted` native.

It carries a **leak log**: the wrapper has its own click handlers, and any event escaping our
control bar into them shows up as `LEAK:`. Clicking the video body (not the bar) must produce leak
entries — that is the negative control proving the detector works. Clicking the bar must produce
none.

```sh
npm run build
mkdir -p .serve && cp dev/index.html .serve/ && cp dist/content.js dist/content.css .serve/
cd .serve && python3 -m http.server 8731
```

Open <http://localhost:8731/>. It must be served from the path `/` — the extension resolves the
surface from `location.pathname`, and `/` is what makes it read as the feed.

`window.__probe()` returns the bar's state (rect, visibility, parent, displayed time, leaks) for
scripted checks.

## How it works

```
index.ts        MutationObserver keeps the registry fresh; a document-level pointermove
                hit-tests against every registered video and points one shared bar at it
  bar.ts        <igvc-overlay> host at document.body level, Shadow DOM, repositioned
                every frame from video.getBoundingClientRect()
  registry.ts   tracks videos, re-applies the volume/mute preference when Instagram resets it
  fullscreen.ts fullscreens the video's wrapper, not the video
  surface.ts    resolves feed / post / reels / stories / … from the URL
```

Three constraints shaped this:

- **Nothing anchors on Instagram's class names.** They are obfuscated and rotate. The only anchors
  are `video` elements and their geometry.
- **The bar lives outside React.** Its host is appended to `document.body`, so React re-renders
  cannot remove it, and events starting in our subtree never reach React's root container — which
  is why clicking the bar cannot trigger Instagram's play/pause or mute.
- **Fullscreen targets the wrapper, not the video.** A fullscreened `<video>` cannot render child
  elements, so the bar would disappear. The wrapper is tagged with `data-igvc-fs-root` and the
  video with `data-igvc-fs`; `public/content.css` keys off those to stretch the video back to
  fill, and both attributes are removed on exit.

The bar is driven by `requestAnimationFrame`, so it does no work at all while the tab is hidden.

## Enabling more surfaces

`src/content/surface.ts`:

```ts
const ENABLED = new Set<Surface>(["feed", "post"]);
```

Add `"reels"`, `"reel"`, `"stories"`, `"direct"` or `"explore"` and rebuild. Expect each to need
work: reels autoplay on scroll and have a different overlay stack, and stories draw their own
segment progress bar and pause-on-hold that the bar can fight with.

## Not built yet

Playback speed, keyboard shortcuts, picture-in-picture, and an options page. The bar is laid out
so speed and PiP drop into the control row without restructuring anything.
