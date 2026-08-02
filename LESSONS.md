# LESSONS — what has already gone wrong here, and what it cost

Incidents, not theories. Every line is something that actually happened in this repo and the rule
it produced. Read before changing the event handling, the harness, or the fullscreen path.

---

## §1 — Event isolation is a two-edged tool

- **1.1 A capture-phase `stopPropagation()` on your own container kills your own controls.**
  The bar's isolation listeners were registered on `.wrap` with `{capture: true}` to stop clicks
  reaching Instagram. Capture runs top-down, so the event was killed at `.wrap` **before it ever
  reached the play button inside it**. Every control was dead: the button took focus, nothing
  happened, and no error was logged anywhere. Isolation belongs on the **bubble** phase — the
  target's own handlers run first, and propagation still stops before the event leaves our
  subtree. ⭐ The symptom of this bug is *silence*, so a test that only checks "no leak" passes
  happily while the whole UI is inert. Assert the state changed **and** that nothing leaked.

- **1.2 Document-level capture listeners always see your events; that is not a leak.**
  A probe registered with `{capture: true}` on `document` reports every click on the bar. It has
  to — capture runs before the target. React attaches on its root container in the bubble phase,
  and our host is outside that container, which is what actually protects Instagram's handlers.
  Measure leaks with **bubble-phase listeners on the page's own elements**, the way the page
  itself listens, or the probe answers a question nobody asked.

## §2 — A probe that cannot go red is not a probe

- **2.1 The leak detector was believed before it was proven.** Three clicks on the bar produced an
  empty leak log. That is equally consistent with "isolation works" and "the detector is broken".
  Clicking the video *body* first, and seeing `LEAK: catcher click` + `LEAK: media click` appear,
  is what made the empty log mean anything. **Run the negative control before quoting the result.**

## §3 — The harness is where the time goes, not the feature

- **3.1 `requestAnimationFrame` does not run in a hidden tab, and the whole bar is rAF-driven.**
  Every automated check returned "no overlay" while the code was correct — the tab was
  `visibilityState: "hidden"` because it was not the foreground tab. Worse, a driver script that
  `await`s a rAF in a hidden tab **never resolves**, and the CDP call times out after 45s looking
  exactly like a renderer freeze. Batch browser actions so a screenshot keeps the tab foregrounded,
  and never `await` rAF from a driver.

- **3.2 Brave will not decode a MediaRecorder blob.** Generating a test clip from
  `canvas.captureStream()` + `MediaRecorder` produced a valid non-empty webm (9 KB) that the
  `<video>` element then refused to load — stuck at `readyState=0`, `networkState=2`, no
  `loadedmetadata`, no `error` event, forever. Two hours of codec chasing avoided by asking what
  was actually under test: the extension only touches `duration`, `currentTime`, `paused`,
  `buffered`, `play()`, `pause()` and the matching events. **Stub the media clock and test the
  control logic.** No codec is involved and the harness became deterministic.

- **3.3 `AudioContext.resume()` never settles without a user gesture.** Not "rejects" — the promise
  stays pending forever, so `await`ing it hangs the harness silently with no error. The first
  version of the harness died here and merely printed "generating test clip…" indefinitely.

## §4 — What automation cannot tell you

- **4.1 Fullscreen cannot be entered under CDP.** `requestFullscreen()` fails with
  `TypeError: not granted` for **any** element — proven by adding a plain `<button>` to the page
  that fullscreens a div and clicking it the same way. So the fullscreen path is unverifiable by
  automation and has to be either read carefully or clicked by hand. ⭐ When a check fails, first
  establish whether *anything* could have passed it: a one-line control separated "our code is
  broken" from "this environment forbids it".

- **4.2 Swallowed rejections make the above indistinguishable from a bug.** `toggleFullscreen()`
  originally ended in `.catch(() => {})`, so a refusal looked identical to a silent no-op. It now
  logs the reason.
