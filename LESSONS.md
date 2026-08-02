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

## §6 — The harness is not the extension

Everything above was proven with the bundle running as an ordinary page script. Loading `dist/` as
a real unpacked extension (`npm run e2e`) broke four checks that had been green, and none of the
breakages were in the extension.

- **6.1 An isolated world does not see properties shadowed onto DOM elements from the page.** The
  harness faked a media clock with `Object.defineProperty(video, 'duration', …)`. Content scripts
  get their own JS wrappers for the same DOM nodes, so the extension saw a real source-less
  `<video>`: `duration` NaN, `play()` rejecting, `paused` stuck true. Every playback check failed
  while the code was correct. **Only genuine DOM state crosses the boundary** — `muted` and
  `volume` did work, which is exactly why the failure looked selective and confusing. The harness
  now serves a real `.webm`.

- **6.2 You cannot measure an extension's `requestAnimationFrame` from the page.** Each world has
  its own `window`, so patching the page's `requestAnimationFrame` counts nothing the content
  script does — and reads **zero**, which is indistinguishable from "the loop is correctly parked".
  ⭐ A cross-world measurement that can only ever return the passing value is worse than no
  measurement. That check lives in `npm run harness`, against the bundle as a page script.

  ⭐ **Two readings of one probe under opposite conditions beat a break-and-restore.** The parking
  check reports 20 frames over 20 native while the bar is shown and 0 over 20 while it is hidden.
  The zero is trustworthy *because the same probe just read twenty* — no perturbing the source, no
  restoring it afterwards, and the control can never be forgotten because it is the check.

- **6.3 `instagram.com` is on Chromium's HSTS preload list.** `http://www.instagram.com` is
  upgraded to HTTPS before any command-line flag is consulted — `--disable-features=…` does not
  help — so a plain-HTTP test server answers `ERR_SSL_PROTOCOL_ERROR`. The dev server speaks TLS
  with a self-signed cert and the browser is launched with `--ignore-certificate-errors`.

- **6.4 Without HTTP Range support, `currentTime` assignments are silently clamped.** The seek
  click landed, the handler ran, `video.currentTime = 22.3` executed — and the video stayed at
  0.2s, because the browser will not seek outside `seekable`, and a server that ignores `Range`
  never makes the clip seekable. No error anywhere. ⭐ The check now asserts the clip is seekable
  *before* scrubbing, so this can never again present as "seeking is broken".

- **6.5 Hovering is not a user gesture.** After a reload the stored unmute preference is correctly
  not applied until the tab has been activated, because unmuting without activation makes Chrome's
  autoplay policy stop the video. The first version of the test hovered and expected sound; the
  test was wrong, not the code. Assert the *designed* behaviour, which here is two-stage: muted
  until a gesture, unmuted after one.

- **6.6 `--headless=new` reports `visibilityState: "visible"`.** Every rAF-dependent check that was
  unmeasurable through the automation extension (§3.1) simply works in a browser the test owns.

## §7 — Reported from real Instagram

- **7.1 `stopPropagation()` does not stop an ancestor anchor. Only `preventDefault()` does.**
  In fullscreen, clicking anywhere — the picture, the scrubber — navigated to the reel page.
  Instagram wraps posts in `<a href="/reel/...">`, and fullscreen is the one situation where our
  host is *inside* Instagram's DOM rather than hanging off `document.body`, so it is inside that
  anchor. Propagation was being stopped, but an anchor's default action is decided after
  propagation and does not care. ⭐ The two calls solve different problems: `stopPropagation`
  keeps *listeners* from seeing the event, `preventDefault` keeps the *browser* from acting on it.
  Isolation needs both.

  It presented as inconsistent — the play, mute and fullscreen buttons were fine because their
  handlers happened to call `preventDefault()` for unrelated reasons, while the scrubber (which
  only prevented on `pointerdown`, not `click`) and the bare picture were not. Per-handler
  `preventDefault` is not isolation; the isolation layer has to own it.

- **7.3 A test whose fixture cannot exhibit the defect is not a test.** The harness models the post
  link, the modal, the below-the-fold case and a video taken out of hit testing — each with a
  companion check asserting the *fixture* is in the state that would break a wrong implementation
  (the modal video really is the larger one; the video really does overflow; it really is
  `pointer-events: none`). Without those, all four pass against a fixture that cannot tell right
  from wrong.

- **7.2 An overlay with `pointer-events: none` is a hole, not a shield.** Clicks in the middle of
  the fullscreen picture passed straight through the host to Instagram's click-catcher. In
  fullscreen the bar now carries a full-screen `.surface` that takes those clicks and turns them
  into play/pause. It stays inert everywhere else, because clicking a feed post to open it is
  behaviour we have no business breaking — asserted in both directions, since a fix that blocked
  navigation everywhere would make the fullscreen checks pass for the wrong reason.

## §8 — ROUND 2 adversarial review

Seventeen findings in round 1, fourteen more here. The one that mattered most was not in the
extension at all — it was in the check that certified the previous fix.

- **8.1 An anchor's navigation is not a listener, so do not probe it with one.** The harness
  detected "would navigate" with a bubble-phase click listener on the `<a>` that logged when
  `!defaultPrevented`. But activation behaviour runs after dispatch unless the event was
  *canceled*, so `stopPropagation()` silenced the probe while the browser navigated anyway.
  Deleting the `preventDefault()` that fixed §7.1 did not fail the suite — it **crashed** it four
  steps later with `window.__probe is not a function`, because the page had genuinely navigated.
  Had that check been last in the run, it would have reported green on a broken build.
  ⭐ **Probe an effect, not an intention.** The probe now uses `href="#reel-FAKE"` and a
  `hashchange` listener: a real default action that only `preventDefault` suppresses.

- **8.2 A window bounded only by time is still global.** §5.3 replaced a 5s global user-activation
  window with a 500ms one — same shape, same bug, smaller. Click unmute on one post and any *other*
  video muted inside those 500 ms — including by our own `applyPrefs`, which mutes every non-active
  video — was recorded as the user's preference and written to `chrome.storage.sync`. Intent is now
  scoped to the element the control acted on.

- **8.3 An overlay pinned to the bottom of a box must not be taller than the box.** The bar is 92px
  and the "is there room" gate was 56px, so a post scrolled to ~70px visible drew the bar *above*
  the video, over the previous post, at z-index 2147483000 — swallowing clicks there and keeping
  the bar glued to the wrong post. The gate now measures the bar, and `.root` is `overflow:hidden`
  so it can never paint or hit-test outside the video whatever the arithmetic decides.

- **8.4 A loop that parks itself needs a restart for every way the answer can change.** Parking was
  added for §5.6, but the only thing that restarted it was a pointer event. Alt-tab away and back
  without moving the mouse, or resize the window, and the bar was simply gone. `focus`, `resize`
  and `scroll` now re-evaluate. The mirror image was also missing: nothing hid the bar when the
  pointer left the viewport for the tab strip, so that one exit path kept the loop running forever.

- **8.5 `elementsFromPoint` is a penetrating list, and a video can be absent from it.** Two holes in
  one function: bailing on the first too-small video aborted the search instead of continuing past a
  decoration to the real post underneath; and a video with `pointer-events: none` — an ordinary
  thing to do when you stack a click-catcher over your media — never appears in the hit stack at
  all, which would have left the extension inert on the feed with no error anywhere.

- **8.6 Assert the transition, not the state you happen to find later.** "play toggles playback"
  read `paused === false` after the click, a 6s polling loop and a second click. It would have
  passed for a control that could only ever start playback. The flip is now asserted at the click.

- **8.7 A test command that does not build tests the previous build.** `npm run e2e` loaded `dist/`
  as-is, so editing `src/` and running it reported passes for the old bundle.
