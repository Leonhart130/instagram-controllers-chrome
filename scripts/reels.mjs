/**
 * Reels-specific checks.
 *
 * Reels differ from the feed in one way that matters to a hover-driven control
 * bar: the video under a *motionless* pointer changes, because the column
 * snap-scrolls a new full-viewport item into place. Everything else in the
 * suite moves the pointer to change which video is current, so nothing else
 * exercises this.
 *
 * Usage:  npm run reels   (add --headful to watch)
 * Needs:  npm run serve, and npm run fixture once.
 */

import { launchBrowser, CDP, requireServer, Checks } from "./cdp.mjs";

const PORT = 8731;
const URL_REELS = `http://localhost:${PORT}/reels/`;

const checks = new Checks();

async function main() {
  await requireServer(PORT);
  const { proc, port, cleanup } = await launchBrowser();
  let cdp;
  try {
    cdp = await CDP.attach(port);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 900, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.send("Page.navigate", { url: URL_REELS });
    await cdp.sleep(1600);
    await cdp.eval("return await window.__ready;");

    const vis = await cdp.eval("return document.visibilityState;");
    checks.add("page is visible", vis === "visible", vis);

    const layout = await cdp.eval(`
      const p = window.__probe();
      return { reel0: p.rects.reel0, reel1: p.rects.reel1, scrollTop: p.scrollTop, viewportH: innerHeight };
    `);
    checks.add("two reels, the second below the fold (so scrolling changes the answer)",
      layout.reel1[1] >= layout.viewportH, JSON.stringify(layout));

    // Park the pointer in the middle of the first reel and leave it there.
    const centre = { x: 450, y: 450 };
    await cdp.mouseMove(centre.x, centre.y);
    await cdp.mouseMove(centre.x + 1, centre.y + 1);
    await cdp.sleep(500);
    const onFirst = await cdp.eval(`
      const p = window.__probe();
      return { rect: p.overlay && p.overlay.rect, visible: p.overlay && p.overlay.visible, reel0: p.rects.reel0 };
    `);
    checks.add("bar attaches to the first reel",
      onFirst.visible === true && JSON.stringify(onFirst.rect) === JSON.stringify(onFirst.reel0),
      `bar ${JSON.stringify(onFirst.rect)} vs reel0 ${JSON.stringify(onFirst.reel0)}`);

    // --- the actual reels behaviour: scroll, do not move the pointer --------
    const scrolled = await cdp.eval(`
      window.__scrollToReel(1);
      await new Promise((r) => setTimeout(r, 700));
      const p = window.__probe();
      return { scrollTop: p.scrollTop, reel1: p.rects.reel1, reel0: p.rects.reel0 };
    `);
    checks.add("the second reel really is under the pointer now (so this discriminates)",
      scrolled.reel1[1] <= 450 && scrolled.reel1[1] + scrolled.reel1[3] >= 450,
      `reel1 spans ${scrolled.reel1[1]}..${scrolled.reel1[1] + scrolled.reel1[3]}, pointer at 450`);

    await cdp.sleep(600);
    const retargeted = await cdp.eval(`
      const p = window.__probe();
      return { rect: p.overlay && p.overlay.rect, visible: p.overlay && p.overlay.visible,
               reel0: p.rects.reel0, reel1: p.rects.reel1 };
    `);
    checks.add("bar follows the scroll to the next reel without the pointer moving",
      retargeted.visible === true &&
        JSON.stringify(retargeted.rect) === JSON.stringify(retargeted.reel1),
      `bar ${JSON.stringify(retargeted.rect)} | reel1 ${JSON.stringify(retargeted.reel1)} | reel0 ${JSON.stringify(retargeted.reel0)}`);

    // --- only the reel you are on may make sound ---------------------------
    // Both reels start muted, which is the default, so asserting "not both
    // unmuted" against that would pass without testing anything. Unmute through
    // our own control first, then play both: the preference is now "unmuted",
    // and the whole question is whether it is applied to one video or to every
    // video that happens to be mounted.
    const muteHit = await cdp.eval(`
      const sr = document.querySelector('igvc-overlay').shadowRoot;
      const r = sr.querySelector('.mute').getBoundingClientRect();
      return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
    `);
    await cdp.click(...muteHit);
    await cdp.sleep(400);
    const sound = await cdp.eval(`
      await window.__playBoth();
      await new Promise((r) => setTimeout(r, 700));
      const p = window.__probe();
      return { muted: p.muted, prefUnmuted: !document.getElementById('v2').muted };
    `);
    checks.add("the preference really is unmuted now (so this discriminates)",
      sound.prefUnmuted === true, `reel1 muted=${sound.muted.reel1}`);
    checks.add("only the reel under the pointer is unmuted, not every mounted reel",
      sound.muted.reel1 === false && sound.muted.reel0 === true,
      `reel0 muted=${sound.muted.reel0}, reel1 muted=${sound.muted.reel1}`);

    const leaks = await cdp.eval("return window.__probe().leaks;");
    checks.add("scrolling and retargeting leaked no clicks", leaks.length === 0, JSON.stringify(leaks));
  } finally {
    cdp?.close();
    proc.kill("SIGKILL");
    await cleanup();
  }
  checks.finish("REELS_OK");
}

main().catch((err) => {
  console.error("\nreels checks aborted:", err.message);
  process.exit(2);
});
