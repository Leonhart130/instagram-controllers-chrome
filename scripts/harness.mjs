/**
 * Main-world checks against the dev harness.
 *
 * Companion to scripts/e2e.mjs, which drives the built extension. This one
 * loads the bundle as an ordinary page script on localhost, which is the only
 * environment where the page can observe the bar's internals at all — most
 * importantly `requestAnimationFrame`, which a content script calls on its own
 * isolated `window` (LESSONS §6.2).
 *
 * It exists because several of these claims were previously either unmeasured
 * or measured through an automation extension whose tab kept dropping to
 * hidden, which pauses rAF and makes every result meaningless. A browser this
 * script owns reports visibilityState "visible".
 *
 * Checks whose name ends "(so this test discriminates)" assert the FIXTURE is
 * in the state that would break a wrong implementation. They are not padding:
 * without them the check beside each one passes against a fixture that cannot
 * tell right from wrong, which is the most common defect this repo has had.
 *
 * Usage:  npm run harness   (add --headful to watch)
 * Needs:  npm run serve, and npm run fixture once.
 *
 * Exits 2 on any failure or if a check could not run.
 */

import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 8731;
const ORIGIN = `http://localhost:${PORT}/`;
const HEADFUL = process.argv.includes("--headful");

let browser = null;
const watchdog = setTimeout(() => {
  console.error("\nharness watchdog: timed out — killing the browser.");
  browser?.kill("SIGKILL");
  process.exit(2);
}, 90000);
watchdog.unref();

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  const tag = ok === true ? "PASS" : ok === null ? "INCONCLUSIVE" : "FAIL";
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
}

class CDP {
  #ws; #id = 0; #pending = new Map();
  static async connect(url) {
    const cdp = new CDP();
    cdp.#ws = new WebSocket(url);
    await new Promise((res, rej) => {
      cdp.#ws.addEventListener("open", res, { once: true });
      cdp.#ws.addEventListener("error", () => rej(new Error("cdp connect failed")), { once: true });
    });
    cdp.#ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      const p = cdp.#pending.get(msg.id);
      if (!p) return;
      cdp.#pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    });
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.#pending.delete(id)) reject(new Error(`${method} timed out`)); }, 20000);
    });
  }
  async eval(expression) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? "evaluate threw");
    return result.value;
  }
  mouseMove(x, y) { return this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 }); }
  close() { try { this.#ws.close(); } catch { /* gone */ } }
}

async function requireServer() {
  try {
    await new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port: PORT, path: "/", timeout: 3000 }, (res) => {
        res.resume();
        res.statusCode === 200 ? resolve() : reject(new Error(`status ${res.statusCode}`));
      });
      req.on("timeout", () => req.destroy(new Error("timed out")));
      req.on("error", reject);
    });
  } catch (err) {
    console.error(`\nThe dev server is not answering on ${ORIGIN} — ${err.message}`);
    console.error("Start it with:  npm run serve\n");
    process.exit(2);
  }
}

async function launch(profileDir) {
  const args = [
    ...(HEADFUL ? [] : ["--headless=new"]),
    "--window-size=1280,900",
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--no-first-run", "--no-default-browser-check", "--disable-sync",
    "about:blank",
  ];
  const proc = spawn("brave-browser", args, { stdio: ["ignore", "pipe", "pipe"] });
  proc.stderr.on("data", () => {});
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    try {
      const [port] = (await readFile(join(profileDir, "DevToolsActivePort"), "utf8")).split("\n");
      if (port) return { proc, port: Number(port) };
    } catch { /* not yet */ }
  }
  proc.kill("SIGKILL");
  throw new Error("browser never reported a debugging port");
}

async function main() {
  await requireServer();
  const profileDir = await mkdtemp(join(tmpdir(), "igvc-harness-"));
  console.log(`\nigvc harness checks — ${HEADFUL ? "headful" : "headless"}`);
  const { proc, port } = await launch(profileDir);
  browser = proc;

  let cdp;
  try {
    let target;
    for (let i = 0; i < 40; i++) {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => []);
      target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (target) break;
      await sleep(150);
    }
    cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.send("Page.navigate", { url: ORIGIN });
    await sleep(1500);
    await cdp.eval("return await window.__ready;");

    const vis = await cdp.eval("return document.visibilityState;");
    check("page is visible (rAF actually runs)", vis === "visible", vis);
    if (vis !== "visible") throw new Error("cannot measure rAF in a hidden tab");

    const rect = await cdp.eval(`
      const r = document.getElementById('v').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);

    // --- 1. the render loop parks when there is nothing to draw ------------
    // The whole point of the check is that "0 extension frames" is only
    // meaningful next to a non-zero native frame count. Without that, a hidden
    // tab or a dead browser reads exactly like a correctly parked loop.
    await cdp.mouseMove(rect.x, rect.y);
    await cdp.mouseMove(rect.x + 1, rect.y + 1);
    await sleep(400);
    const park = await cdp.eval(`
      const running = await window.__countOverFrames(20);
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 2, clientY: 2, bubbles: true }));
      await window.__countOverFrames(5);           // let it notice and park
      const parked = await window.__countOverFrames(20);
      return { running, parked, barVisible: (window.__probe().overlay || {}).visible };
    `);
    if (park.running.nativeFrames === 0) {
      check("render loop runs while the bar is shown", null, "no native frames — could not measure");
      check("render loop parks when the bar is hidden", null, "no native frames — could not measure");
    } else {
      check("render loop runs while the bar is shown",
        park.running.extensionFrames > 0,
        `${park.running.extensionFrames} frames over ${park.running.nativeFrames} native`);
      check("render loop parks when the bar is hidden",
        park.parked.extensionFrames === 0,
        `${park.parked.extensionFrames} frames over ${park.parked.nativeFrames} native`);
    }

    // --- 2. occlusion: the topmost video wins, not the smallest ------------
    // The modal video is deliberately LARGER in area than the feed one, so the
    // old "smallest containing rect" logic would pick the wrong one here.
    const modal = await cdp.eval(`
      window.__openModal();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const r = document.getElementById('v2').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    await cdp.mouseMove(modal.x, modal.y);
    await cdp.mouseMove(modal.x + 1, modal.y + 1);
    await sleep(400);
    const occl = await cdp.eval(`
      const p = window.__probe();
      return { bar: p.overlay && p.overlay.rect, feed: p.rects.feed, modal: p.rects.modal,
               feedArea: p.rects.feed[2] * p.rects.feed[3], modalArea: p.rects.modal[2] * p.rects.modal[3] };
    `);
    check("the modal video is the larger one (so this test discriminates)",
      occl.modalArea > occl.feedArea, `modal ${occl.modalArea} > feed ${occl.feedArea}`);
    check("bar binds to the video on top, not the one behind the modal",
      JSON.stringify(occl.bar) === JSON.stringify(occl.modal),
      `bar ${JSON.stringify(occl.bar)} vs modal ${JSON.stringify(occl.modal)}`);

    // --- 3. a video whose bottom is below the fold still gets a usable bar --
    const clamp = await cdp.eval(`
      window.__closeModal();
      window.__setSpacer(500);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const r = document.getElementById('v').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 60),
               bottom: Math.round(r.bottom), viewportH: innerHeight };
    `);
    check("the video really does overflow the fold (so this test discriminates)",
      clamp.bottom > clamp.viewportH, `video bottom ${clamp.bottom} > viewport ${clamp.viewportH}`);
    await cdp.mouseMove(clamp.x, clamp.y);
    await cdp.mouseMove(clamp.x + 1, clamp.y + 1);
    await sleep(400);
    const clamped = await cdp.eval(`
      const host = document.querySelector('igvc-overlay');
      const w = host.shadowRoot.querySelector('.wrap').getBoundingClientRect();
      const p = window.__probe();
      return { hostRect: p.overlay && p.overlay.rect, visible: p.overlay && p.overlay.visible,
               wrapBottom: Math.round(w.bottom), wrapTop: Math.round(w.top), viewportH: innerHeight };
    `);
    check("bar stays fully on screen when the video runs past the fold",
      clamped.visible === true && clamped.wrapBottom <= clamped.viewportH + 1 && clamped.wrapTop >= 0,
      `wrap ${clamped.wrapTop}-${clamped.wrapBottom} within ${clamped.viewportH}, host ${JSON.stringify(clamped.hostRect)}`);
    // --- 4. a video removed from hit testing is still found ---------------
    const hidden = await cdp.eval(`
      window.__setSpacer(0);
      window.__setVideoHitTesting(false);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const v = document.getElementById('v');
      const r = v.getBoundingClientRect();
      const mid = [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
      return { pe: getComputedStyle(v).pointerEvents,
               stackHasVideo: document.elementsFromPoint(mid[0], mid[1]).some((e) => e.tagName === 'VIDEO'),
               x: mid[0], y: mid[1] };
    `);
    check("the video really is out of hit testing (so this test discriminates)",
      hidden.pe === "none" && hidden.stackHasVideo === false,
      `pointer-events:${hidden.pe}, video in hit stack: ${hidden.stackHasVideo}`);
    await cdp.mouseMove(2, 2);
    await sleep(200);
    await cdp.mouseMove(hidden.x, hidden.y);
    await cdp.mouseMove(hidden.x + 1, hidden.y + 1);
    await sleep(400);
    const foundAnyway = await cdp.eval(`
      const p = window.__probe();
      window.__setVideoHitTesting(true);
      return { rect: p.overlay && p.overlay.rect, visible: p.overlay && p.overlay.visible, video: p.rects.feed };
    `);
    check("bar still finds a video that is not hit-testable",
      foundAnyway.visible === true && JSON.stringify(foundAnyway.rect) === JSON.stringify(foundAnyway.video),
      `bar ${JSON.stringify(foundAnyway.rect)} vs video ${JSON.stringify(foundAnyway.video)}`);
    // --- 5. playback speed ------------------------------------------------
    await cdp.mouseMove(rect.x, rect.y);
    await cdp.mouseMove(rect.x + 1, rect.y + 1);
    await sleep(400);
    const rateBtn = await cdp.eval(`
      const sr = document.querySelector('igvc-overlay').shadowRoot;
      const r = sr.querySelector('.rate').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
               label: sr.querySelector('.rate').textContent,
               rate: document.getElementById('v').playbackRate };
    `);
    check("speed starts at 1x", rateBtn.label === "1x" && rateBtn.rate === 1,
      `label ${rateBtn.label}, playbackRate ${rateBtn.rate}`);

    await cdp.mouseMove(rateBtn.x, rateBtn.y);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rateBtn.x, y: rateBtn.y, button: "left", buttons: 1, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rateBtn.x, y: rateBtn.y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(300);
    const item = await cdp.eval(`
      const sr = document.querySelector('igvc-overlay').shadowRoot;
      const menu = sr.querySelector('.ratemenu');
      if (menu.hidden) return { open: false };
      const el = [...menu.children].find((c) => c.dataset.rate === '1.5');
      const r = el.getBoundingClientRect();
      return { open: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
               onScreen: r.top >= 0 && r.bottom <= innerHeight && r.width > 0 };
    `);
    check("the speed menu opens and is on screen", item.open === true && item.onScreen === true, JSON.stringify(item));

    if (item.open) {
      await cdp.mouseMove(item.x, item.y);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: item.x, y: item.y, button: "left", buttons: 1, clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: item.x, y: item.y, button: "left", buttons: 0, clickCount: 1 });
      await sleep(400);
      const picked = await cdp.eval(`
        const sr = document.querySelector('igvc-overlay').shadowRoot;
        return { rate: document.getElementById('v').playbackRate,
                 label: sr.querySelector('.rate').textContent,
                 menuClosed: sr.querySelector('.ratemenu').hidden };
      `);
      check("picking 1.5x sets playbackRate and closes the menu",
        Math.abs(picked.rate - 1.5) < 0.001 && picked.label === "1.5x" && picked.menuClosed === true,
        JSON.stringify(picked));

      // The reason the feature exists: Instagram resets playbackRate on its own.
      const reasserted = await cdp.eval(`
        const v = document.getElementById('v');
        v.playbackRate = 1;                       // stand in for Instagram
        await new Promise((r) => setTimeout(r, 400));
        return v.playbackRate;
      `);
      check("speed is put back when the page resets it",
        Math.abs(reasserted - 1.5) < 0.001, `playbackRate ${reasserted}`);
    } else {
      check("picking 1.5x sets playbackRate and closes the menu", null, "menu never opened");
      check("speed is put back when the page resets it", null, "menu never opened");
    }

    // --- 5b. the menu must be reachable on a SHORT video --------------------
    // getBoundingClientRect reports the layout rect and knows nothing about an
    // ancestor's overflow:hidden, so "is the menu inside the viewport" cannot
    // see a menu clipped away by .root. Assert against the host's box instead,
    // on a video short enough for a menu that grows upward to have nowhere to go.
    const short = await cdp.eval(`
      window.__setMediaHeight(200);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const r = document.getElementById('v').getBoundingClientRect();
      return { h: Math.round(r.height), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    check("the post really is short (so this test discriminates)", short.h <= 220, `media height ${short.h}`);
    await cdp.mouseMove(2, 2);
    await sleep(200);
    await cdp.mouseMove(short.x, short.y);
    await cdp.mouseMove(short.x + 1, short.y + 1);
    await sleep(400);
    const clipped = await cdp.eval(`
      const host = document.querySelector('igvc-overlay');
      const sr = host.shadowRoot;
      const btn = sr.querySelector('.rate');
      const br = btn.getBoundingClientRect();
      btn.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const menu = sr.querySelector('.ratemenu');
      if (menu.hidden) return { open: false };
      const hostRect = host.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const inside = (r) => r.top >= hostRect.top - 1 && r.bottom <= hostRect.bottom + 1;
      // The menu scrolls (focusing the checked item scrolls it), so "is item 0
      // in the box right now" is the wrong question — it is legitimately
      // scrolled out. The right one is whether every item can be BROUGHT into
      // the box, which is what a clipped menu makes impossible.
      menu.scrollTop = 0;
      const first = menu.children[0].getBoundingClientRect();
      menu.scrollTop = menu.scrollHeight;
      const last = menu.children[menu.children.length - 1].getBoundingClientRect();
      return { open: true,
               hostTop: Math.round(hostRect.top), hostBottom: Math.round(hostRect.bottom),
               menuTop: Math.round(menuRect.top), menuBottom: Math.round(menuRect.bottom),
               menuInsideHost: inside(menuRect),
               firstReachable: inside(first), lastReachable: inside(last) };
    `);
    check("every speed option can be reached on a short video",
      clipped.open === true && clipped.menuInsideHost === true &&
        clipped.firstReachable === true && clipped.lastReachable === true,
      JSON.stringify(clipped));
    await cdp.eval("window.__setMediaHeight(600); document.querySelector('igvc-overlay').shadowRoot.querySelector('.ratemenu').hidden = true; return true;");

    // --- 5c. no flicker on a video scrolled down to a sliver ----------------
    // The hit test and the draw test must agree. When they did not, a video with
    // less on screen than the bar is tall was accepted as "under the pointer"
    // and rejected as "too short to draw on", so every pointermove flipped the
    // bar on and straight back off.
    const sliver = await cdp.eval(`
      window.__setMediaHeight(600);
      window.__setSpacer(0);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const top = document.getElementById('v').getBoundingClientRect().top;
      // Leave ~60px of the video on screen: less than the bar's 92px, more than nothing.
      window.__setSpacer(Math.round(innerHeight - 60 - top));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const r2 = document.getElementById('v').getBoundingClientRect();
      return { visible: Math.round(Math.min(innerHeight, r2.bottom) - Math.max(0, r2.top)),
               fullHeight: Math.round(r2.height),
               x: Math.round(r2.left + r2.width / 2), y: Math.round(innerHeight - 30) };
    `);
    check("only a sliver of the video is on screen, but the element is tall (so this discriminates)",
      sliver.visible > 0 && sliver.visible < 92 && sliver.fullHeight >= 90,
      `${sliver.visible}px visible of a ${sliver.fullHeight}px element`);

    await cdp.mouseMove(2, 2);
    await sleep(200);
    const flicker = await cdp.eval(`
      return await window.__countBarToggles(700, { x: ${sliver.x}, y: ${sliver.y} });
    `);
    check("the bar does not flicker over a video too short to draw on",
      flicker.toggles === 0 && flicker.shown === false,
      `${flicker.toggles} shown/hidden flips, ended ${flicker.shown ? "shown" : "hidden"}`);
    await cdp.eval("window.__setSpacer(0); return true;");

    // --- 6. the surface gate -----------------------------------------------
    // Both directions, or "it works on reels" is indistinguishable from
    // "it works everywhere and the gate does nothing".
    for (const [path, expected] of [["/reels/", true], ["/stories/someone/1/", false]]) {
      await cdp.send("Page.navigate", { url: `http://localhost:${PORT}${path}` });
      await sleep(1500);
      await cdp.eval("return await window.__ready;");
      const box = await cdp.eval(`
        const r = document.getElementById('v').getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      `);
      await cdp.mouseMove(box.x, box.y);
      await cdp.mouseMove(box.x + 1, box.y + 1);
      await sleep(500);
      const shown = await cdp.eval("const p = window.__probe(); return !!(p.overlay && p.overlay.visible);");
      check(
        expected ? `bar appears on ${path}` : `bar stays off on ${path}`,
        shown === expected,
        `visible=${shown}`,
      );
    }
  } finally {
    cdp?.close();
    proc.kill("SIGKILL");
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }

  clearTimeout(watchdog);
  const failed = results.filter((r) => r.ok === false);
  const inconclusive = results.filter((r) => r.ok === null);
  console.log(`\n${results.length - failed.length - inconclusive.length} passed, ${failed.length} failed, ${inconclusive.length} inconclusive`);
  if (failed.length || inconclusive.length) process.exit(2);
  console.log("HARNESS_OK");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nharness checks aborted:", err.message);
  browser?.kill("SIGKILL");
  process.exit(2);
});
