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

- **4.3 A measurement that cannot run must say "inconclusive", never "pass".** The check that the
  rAF loop parks when hidden counts extension frames against *native* frames. In a hidden tab both
  are zero — which reads as "the loop is parked" if you only look at the first number. Reporting
  `nativeFrames` alongside is what makes a zero legible as "this did not measure anything".

## §5 — What an adversarial review round found that execution did not

A read-only reviewer was pointed at the tree with the verified facts supplied up front, so it
would attack the unmeasured parts instead of re-deriving the measured ones. Seventeen findings;
these are the ones worth remembering as rules.

- **5.1 A rectangle hit test is not a hit test.** Choosing the video under the pointer by "smallest
  containing rect" is backwards: the *occluded* video is usually the smaller one. With the post
  modal open over a still-mounted feed, the bar bound itself to the feed video behind the modal —
  wrong duration, and play/seek driving something invisible. `document.elementsFromPoint` already
  knows about occlusion, ancestor clipping and the top layer. ⭐ Proven with a modal video
  deliberately made **larger** in area than the feed one, so the old logic picks wrong and the new
  one picks right: a fixture both versions pass proves nothing.

- **5.2 A content script cannot patch the page's `history`.** Assigning `history.pushState` from an
  isolated world only shadows the isolated world's own wrapper; Instagram resolves the method
  through the main world and never touches the patch. It silently observes **nothing** — no error,
  no warning. SPA navigation is polled from work already happening each frame instead.

- **5.3 `navigator.userActivation.isActive` does not mean "the user did this".** It stays true for
  ~5s after *any* gesture anywhere on the page. Using it to decide whether a `volumechange` was
  user-driven meant an automatic Instagram re-mute landing in that window got written to
  `chrome.storage.sync` as the user's preference. Intent must be signalled by the control that
  actually handled the click.

- **5.4 `Node.contains()` is reflexive.** `fsElement.contains(video)` is true when
  `fsElement === video`, so the fallback path that fullscreens the `<video>` itself passed an
  ownership check it should have failed, and appended the bar inside a `<video>` — where children
  are fallback content and never render, while the state machine believed the bar was up.

- **5.5 A `:fullscreen` rule that touches siblings inflates the page's own controls.** Laying the
  wrapper out as a centred flex container forced every non-video child to `position:absolute` to
  stop them stretching it — which also stretched Instagram's 30px round mute button into a
  full-screen dark ellipse that swallowed clicks. Size only the video; absolutely positioned
  overlays are already correct and want no help.

- **5.6 An event loop that never parks is a leak with no leak.** One hover left a
  `getBoundingClientRect()` plus five `!important` style writes running every frame for the life of
  the page, because leaving the video calls `hide()` and only `detach()` stopped the loop.
