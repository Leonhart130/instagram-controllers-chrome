# Instagram Video Controls

A Chrome/Brave extension that puts a real player bar on Instagram videos: play/pause, a seek bar
you can scrub, volume with a remembered mute state, playback speed, and fullscreen.

> Unofficial, and not affiliated with, endorsed by, or connected to Instagram or Meta. It reads
> nothing and sends nothing anywhere — the only data it stores is your volume and mute preference,
> in `chrome.storage.sync`. It runs on `*.instagram.com` and nowhere else.

Instagram ships videos with no controls and covers each one with click-catcher layers that own
play/pause and mute. This replaces that with an actual player.

**Scope today:** the feed (`/`), the post modal (`/p/<code>/`), and reels (`/reels/`,
`/reel/<code>/`). Stories are deliberately off — they draw their own segment progress bar and
pause-on-hold, which a second scrubber on top of would fight with. DMs and explore are simply
untested. See "Enabling more surfaces" below.

Your volume, mute and speed are remembered and re-applied every time Instagram resets them, which
it does constantly. Only the video you are pointing at is allowed to make sound, so a feed
autoplaying four posts does not play four soundtracks.

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
                   #   npm run fixture -- /path/to/any-short-clip.webm
npm run check      # build, then all three suites below (52 checks)
npm run harness    # main-world checks against the harness
npm run reels      # reels-specific checks (snap-scroll retargeting)
npm run e2e        # drive the built extension in a throwaway browser
npm run icons      # regenerate public/icons/*.png
```

With `npm run serve` running in another terminal, `npm run check` is the one
command that says whether anything is broken. Each suite exits 2 on failure and
prints a sentinel (`HARNESS_OK`, `REELS_OK`, `E2E_OK`) on success, so a run that
dies early cannot be mistaken for a clean one.

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
look like a pass. That check lives in `npm run harness`. See `LESSONS.md` §6.

### The harness checks

`npm run harness` drives the *localhost* harness — the bundle as a page script — in a browser the
script owns. That last part is the point: through a browser automation extension the tab kept
dropping to `visibilityState: "hidden"`, which pauses `requestAnimationFrame` and makes every
timing result meaningless. A browser this script launches reports `visible`.

It covers the three claims the extension suite structurally cannot reach: that the render loop
runs while the bar is shown and **parks** when it is hidden, that the bar binds to the topmost
video rather than one behind a modal, and that a video running past the fold still gets a bar on
screen. Two of its checks exist only to prove the other two can fail — that the modal video really
is the larger one, and that the video really does overflow the fold. Without those, both tests
would pass against a fixture that could not tell right from wrong.

### The reels checks

`npm run reels` drives `dev/reels.html`, a snap-scrolling column of full-viewport
items. Reels differ from the feed in one way that matters to a hover-driven bar:
**the video under a motionless pointer changes**, because the column scrolls a new
item into place. Nothing else in the suite exercises that — everywhere else, the
pointer moves to change which video is current.

It also checks that unmuting on reels unmutes *one* video and not every mounted
one, after first unmuting through the bar so the preference is actually
"unmuted" — asserting against the default muted state would pass without testing
anything.

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
const ENABLED = new Set<Surface>(["feed", "post", "reels", "reel"]);
```

Add `"stories"`, `"direct"` or `"explore"` and rebuild. Expect each to need work — stories in
particular draw their own segment progress bar and pause-on-hold. The suite checks the gate in
both directions (a bar on `/reels/`, no bar on `/stories/`), so a surface you switch on is at
least exercised.

## Not built yet

Global keyboard shortcuts, picture-in-picture, and an options page. The sliders and the speed menu
are keyboard-operable where they sit, but there are no page-wide hotkeys.

## Licence

MIT — see [LICENSE](LICENSE).
