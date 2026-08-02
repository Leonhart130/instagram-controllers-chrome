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
npm run serve      # dev server for the harness (http :8731, https :8732)
npm run fixture    # one-off: put a real .webm at .fixtures/clip.webm
npm run e2e        # drive the built extension in a throwaway browser
npm run icons      # regenerate public/icons/*.png
```

### The dev harness

`dev/index.html` reproduces Instagram's structure — a wrapper holding the video plus click-catcher
and control siblings stacked on top — without needing to be logged in. It also renders a post
modal over a still-mounted feed, whose video is deliberately **larger** in area than the feed one,
so a hit test that picks the smallest match chooses wrong.

It carries a **leak log**: the wrapper has its own click handlers, and any event escaping our
control bar into them shows up as `LEAK:`. Clicking the video body (not the bar) must produce leak
entries — that is the negative control proving the detector works. Clicking the bar must produce
none.

```sh
npm run build && npm run fixture
npm run serve
```

Open <http://localhost:8731/>. It must be served from the path `/` — the extension resolves the
surface from `location.pathname`, and `/` is what makes it read as the feed. The server reads
`dist/` on every request, so a rebuild needs no copy step.

`window.__probe()` returns the bar's state (rect, visibility, parent, displayed time, leaks) for
scripted checks.

### The end-to-end check

The harness runs the bundle as an ordinary page script. That is **not** the environment the
extension ships into: no isolated world, no `chrome.storage`, no manifest-injected CSS, no match
patterns. `npm run e2e` closes that gap — it launches a throwaway Brave with `dist/` loaded
unpacked, points `*.instagram.com` at the local server with `--host-resolver-rules`, and drives it
over CDP. Add `--headful` to watch it happen.

It covers what only the real artifact can show: injection via the match pattern,
`adoptedStyleSheets` under the extension's CSP, the manifest CSS, fullscreen end to end, event
isolation, and a `chrome.storage.sync` round trip across a reload.

It deliberately does **not** test the render loop's frame-parking: that is measured by patching
`requestAnimationFrame`, which the isolated world does not share, so it would always read zero and
look like a pass. That check lives in the localhost harness. See `LESSONS.md` §6.

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
