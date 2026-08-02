/**
 * End-to-end check of the built extension, as an extension.
 *
 * Everything the dev harness proves, it proves about the bundle running as an
 * ordinary page script. That is a different environment from the real thing:
 * no isolated world, no chrome.storage, no manifest-injected CSS, and no match
 * patterns. This launches a throwaway Brave with dist/ loaded unpacked, points
 * *.instagram.com at the local harness server with --host-resolver-rules so the
 * content script's match pattern actually fires, and drives it over CDP.
 *
 * Usage:  npm run e2e   (or: node scripts/e2e.mjs --headful to watch it)
 * Needs:  npm run serve   in another terminal, and npm run fixture once.
 *
 * Exits 2 if any check fails or could not run. A check that could not run is
 * never reported as a pass.
 */

import { spawn } from "node:child_process";
import https from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// HTTPS, not HTTP: instagram.com is on Chromium's HSTS preload list, so
// http://www.instagram.com is upgraded to https before any command-line flag
// gets a say, and a plain-HTTP server answers with ERR_SSL_PROTOCOL_ERROR.
const HARNESS_PORT = 8732;
const ORIGIN = "https://www.instagram.com/";
const DIST = new URL("../dist", import.meta.url).pathname;
const HEADFUL = process.argv.includes("--headful");

let browser = null;
const WATCHDOG_MS = 120000;
const watchdog = setTimeout(() => {
  console.error(`\ne2e watchdog: nothing finished within ${WATCHDOG_MS / 1000}s — killing the browser.`);
  browser?.kill("SIGKILL");
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref();

const t0 = Date.now();
const step = (msg) => console.log(`  · [${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok === true ? "PASS" : ok === null ? "INCONCLUSIVE" : "FAIL";
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------- CDP client

class CDP {
  #ws;
  #id = 0;
  #pending = new Map();

  static async connect(url) {
    const cdp = new CDP();
    cdp.#ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      cdp.#ws.addEventListener("open", resolve, { once: true });
      cdp.#ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    cdp.#ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      const pending = cdp.#pending.get(msg.id);
      if (!pending) return;
      cdp.#pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? "")})`));
      else pending.resolve(msg.result);
    });
    return cdp;
  }

  send(method, params = {}) {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        reject(new Error(`${method} timed out`));
      }, 20000);
    });
  }

  /** Evaluate in the page's main world and return the JSON value. */
  async eval(expression) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? "evaluate threw");
    return result.value;
  }

  async mouseMove(x, y) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  }

  async click(x, y) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  }

  close() {
    try { this.#ws.close(); } catch { /* already gone */ }
  }
}

// ------------------------------------------------------------------- harness

async function requireHarness() {
  try {
    const html = await new Promise((resolve, reject) => {
      // Self-signed on purpose; the browser gets --ignore-certificate-errors.
      const req = https.get(
        { host: "127.0.0.1", port: HARNESS_PORT, path: "/", rejectUnauthorized: false, timeout: 3000 },
        (res) => {
          if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}`));
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve(body));
        },
      );
      req.on("timeout", () => req.destroy(new Error("timed out")));
      req.on("error", reject);
    });
    if (!html.includes("__probe")) throw new Error("served page is not the harness");
  } catch (err) {
    console.error(`\nThe dev server is not answering on https://127.0.0.1:${HARNESS_PORT} — ${err.message}`);
    console.error("Start it with:  npm run serve\n");
    process.exit(2);
  }
}

async function launch(profileDir) {
  const args = [
    HEADFUL ? "--window-size=1280,900" : "--headless=new",
    "--window-size=1280,900",
    `--user-data-dir=${profileDir}`,
    `--load-extension=${DIST}`,
    `--disable-extensions-except=${DIST}`,
    // Makes the content script's *://*.instagram.com/* match pattern fire
    // against the local harness. No hosts file, no certificates, no network.
    `--host-resolver-rules=MAP *.instagram.com 127.0.0.1:${HARNESS_PORT}, MAP instagram.com 127.0.0.1:${HARNESS_PORT}`,
    "--ignore-certificate-errors",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-brave-update",
    "--disable-sync",
    "about:blank",
  ];
  const proc = spawn("brave-browser", args, { stdio: ["ignore", "pipe", "pipe"] });
  proc.stderr.on("data", () => {});

  const portFile = join(profileDir, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    try {
      const [port] = (await readFile(portFile, "utf8")).split("\n");
      if (port) return { proc, port: Number(port) };
    } catch { /* not written yet */ }
  }
  proc.kill("SIGKILL");
  throw new Error("browser never reported a debugging port");
}

async function pageTarget(port) {
  for (let i = 0; i < 40; i++) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => []);
    const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (page) return page;
    await sleep(150);
  }
  throw new Error("no page target");
}

// --------------------------------------------------------------------- main

async function main() {
  await requireHarness();

  const profileDir = await mkdtemp(join(tmpdir(), "igvc-e2e-"));
  console.log(`\nigvc e2e — ${HEADFUL ? "headful" : "headless"}, profile ${profileDir}`);
  const { proc, port } = await launch(profileDir);
  browser = proc;
  step("browser up");

  let cdp;
  try {
    const target = await pageTarget(port);
    cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    // A deterministic viewport, so the window manager cannot decide whether the
    // video fits on screen and silently change which code path is under test.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
    });

    await cdp.send("Page.navigate", { url: ORIGIN });
    // Content scripts run at document_idle; give the page and the injection time.
    await sleep(2500);
    step("navigated");

    const origin = await cdp.eval("return location.origin + location.pathname;");
    check("harness served as instagram.com", origin === new URL(ORIGIN).origin + "/", origin);

    const clipOk = await cdp.eval("return await window.__ready;");
    if (!clipOk) {
      console.error("\nThe fixture clip did not load. Run: npm run fixture\n");
      process.exit(2);
    }
    const duration = await cdp.eval("return document.getElementById('v').duration;");
    step(`clip ready, duration ${duration.toFixed(2)}s`);

    const vis = await cdp.eval("return document.visibilityState;");
    check("page is visible (rAF runs)", vis === "visible", vis);

    // --- the content script injected at all -----------------------------
    // muted:true is the default preference, applied by registry.ts on adopt.
    // Nothing else in the harness sets it, so this is the injection signal.
    const injected = await cdp.eval("return document.getElementById('v').muted === true;");
    check("content script injected (default mute preference applied)", injected);

    // --- geometry -------------------------------------------------------
    const rect = await cdp.eval(`
      const r = document.getElementById('v').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
               bottom: Math.round(r.bottom), left: Math.round(r.left), width: Math.round(r.width) };
    `);

    await cdp.mouseMove(rect.x, rect.y);
    await cdp.mouseMove(rect.x + 1, rect.y + 1);
    await sleep(400);

    const overlay = await cdp.eval("const p = window.__probe(); return p.overlay;");
    check("bar attaches on hover in the isolated world", !!overlay && overlay.visible === true, JSON.stringify(overlay?.rect));

    // Shadow DOM styling goes through adoptedStyleSheets, which is the part
    // that could plausibly behave differently under the extension's CSP.
    const styled = await cdp.eval(`
      const sr = document.querySelector('igvc-overlay').shadowRoot;
      return { sheets: sr.adoptedStyleSheets.length,
               barHeight: Math.round(sr.querySelector('.wrap').getBoundingClientRect().height) };
    `);
    check("shadow styles applied (adoptedStyleSheets)", styled.sheets === 1 && styled.barHeight > 40, JSON.stringify(styled));

    // --- controls + isolation ------------------------------------------
    await cdp.eval("window.__resetLog(); return true;");
    await cdp.click(rect.x, rect.y - 150);
    await sleep(250);
    const control = await cdp.eval("return window.__probe().leaks;");
    check("negative control: leak detector fires on a page click", control.length > 0, `${control.length} entries`);
    // The other half of the fullscreen navigation fix: outside fullscreen,
    // clicking a post must still open it. Blocking that everywhere would make
    // the fullscreen checks pass for the wrong reason.
    check("outside fullscreen the post link still works",
      control.some((l) => l.includes("navigated to")), JSON.stringify(control));

    // The negative control really navigates now, which detaches the bar, so
    // re-hover and take the control positions afterwards.
    await cdp.mouseMove(rect.x, rect.y);
    await cdp.mouseMove(rect.x + 1, rect.y + 1);
    await sleep(400);
    const coords = await cdp.eval(`
      const sr = document.querySelector('igvc-overlay').shadowRoot;
      const c = (sel, fx = 0.5) => { const r = sr.querySelector(sel).getBoundingClientRect();
        return [Math.round(r.left + r.width * fx), Math.round(r.top + r.height / 2)]; };
      window.__resetLog();
      return { play: c('.play'), mute: c('.mute'), seek60: c('.seek .track', 0.6), fs: c('.fs') };
    `);

    // A click that lands on nothing leaks nothing and does nothing, which is
    // indistinguishable from working isolation. Prove the target is really there.
    const aim = await cdp.eval(`
      const [x, y] = ${JSON.stringify(coords.play)};
      const host = document.querySelector('igvc-overlay');
      const top = document.elementFromPoint(x, y);
      return { viewport: [innerWidth, innerHeight], inViewport: x >= 0 && y >= 0 && x < innerWidth && y < innerHeight,
               topElement: top ? top.tagName : null, isOurHost: top === host,
               hostRect: [...['left','top','width','height'].map(k => Math.round(host.getBoundingClientRect()[k]))],
               videoBottom: Math.round(document.getElementById('v').getBoundingClientRect().bottom) };
    `);
    check("play button is actually under the click point", aim.isOurHost === true, JSON.stringify(aim));

    await cdp.eval(`
      const sr = document.querySelector('igvc-overlay').shadowRoot;
      window.__hits = [];
      for (const type of ['click', 'pointerdown', 'mousedown']) {
        sr.addEventListener(type, (e) => {
          const t = e.composedPath()[0];
          window.__hits.push(type + ' -> ' + (t.tagName || '?') + '.' + (t.getAttribute && t.getAttribute('class') || ''));
        }, true);
      }
      return true;
    `);

    await cdp.click(...coords.play);
    await sleep(150);
    const hits = await cdp.eval("return { hits: window.__hits, paused: document.getElementById('v').paused };");
    console.log(`     · click on .play delivered to: ${JSON.stringify(hits.hits)} paused=${hits.paused}`);
    // Seeks are clamped to the seekable range, so a click that lands correctly
    // still does nothing until the browser knows it can seek there.
    const seekable = await cdp.eval(`
      const v = document.getElementById('v');
      for (let i = 0; i < 60; i++) {
        if (v.seekable.length && v.seekable.end(v.seekable.length - 1) >= v.duration * 0.95) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return v.seekable.length ? Number(v.seekable.end(v.seekable.length - 1).toFixed(2)) : 0;
    `);
    step("seekable polled");
    check("clip is fully seekable before scrubbing", seekable >= duration * 0.95, `seekable to ${seekable}s of ${duration.toFixed(2)}s`);

    await cdp.eval("window.__hits = []; return true;");
    await cdp.click(...coords.seek60);
    await sleep(250);
    const seekHits = await cdp.eval("return { hits: window.__hits, t: document.getElementById('v').currentTime };");
    console.log(`     · click on .seek delivered: ${JSON.stringify(seekHits.hits)} t=${seekHits.t.toFixed(2)}`);
    const afterControls = await cdp.eval("const p = window.__probe(); return { feed: p.feed, leaks: p.leaks.length };");
    const seekTarget = duration * 0.6;
    check("play toggles playback", afterControls.feed.paused === false, `paused=${afterControls.feed.paused}`);
    check(
      `seek to 60% of ${duration.toFixed(2)}s lands near ${seekTarget.toFixed(1)}s`,
      Math.abs(afterControls.feed.t - seekTarget) < 1.5,
      `t=${afterControls.feed.t}`,
    );
    // The log was reset after the negative control, so anything at all here is
    // an event that escaped the bar.
    check("bar clicks leak nothing", afterControls.leaks === 0, `${afterControls.leaks} entries since reset`);

    // The rAF-parking measurement lives in the localhost harness only: it works
    // by patching window.requestAnimationFrame, and a content script has its own
    // isolated `window` that the page cannot reach. Measuring it here would
    // always read zero and look like a pass.

    // --- fullscreen ------------------------------------------------------
    await cdp.mouseMove(rect.x, rect.y);
    await cdp.mouseMove(rect.x + 1, rect.y + 1);
    await sleep(300);
    const fsCoords = await cdp.eval(`
      const sr = document.querySelector('igvc-overlay').shadowRoot;
      const r = sr.querySelector('.fs').getBoundingClientRect();
      return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
    `);
    step("entering fullscreen");
    await cdp.click(...fsCoords);
    await sleep(1200);

    const fs = await cdp.eval(`
      const host = document.querySelector('igvc-overlay');
      const v = document.getElementById('v');
      const el = document.fullscreenElement;
      if (!el) return { entered: false, reason: 'no fullscreenElement' };
      const vr = v.getBoundingClientRect();
      const wrap = host.shadowRoot.querySelector('.wrap').getBoundingClientRect();
      const mute = document.getElementById('igmute').getBoundingClientRect();
      return { entered: true, fsTag: el.tagName + '#' + el.id,
               hostInsideFs: el.contains(host),
               videoFills: Math.round(vr.width) >= innerWidth - 2 && Math.round(vr.height) >= innerHeight - 2,
               videoRect: [Math.round(vr.width), Math.round(vr.height)], viewport: [innerWidth, innerHeight],
               barOnScreen: wrap.bottom <= innerHeight + 1 && wrap.width > 100,
               igMuteSize: [Math.round(mute.width), Math.round(mute.height)] };
    `);

    if (!fs.entered) {
      check("fullscreen enters", null, fs.reason);
    } else {
      check("fullscreen enters on the wrapper, not the video", fs.fsTag !== "VIDEO#v", fs.fsTag);
      check("bar is inside the fullscreen element", fs.hostInsideFs === true);
      check("bar renders on screen in fullscreen", fs.barOnScreen === true);
      check("manifest CSS stretches the video to fill", fs.videoFills === true, `${fs.videoRect} vs viewport ${fs.viewport}`);
      // The rule that used to inflate Instagram's own sibling controls.
      check(
        "page's own 30px control is not inflated",
        fs.igMuteSize[0] <= 40 && fs.igMuteSize[1] <= 40,
        `${fs.igMuteSize[0]}x${fs.igMuteSize[1]}`,
      );

      // In fullscreen the bar sits inside Instagram's own post link, so a click
      // that is merely stopped from propagating still follows the anchor.
      await cdp.eval("window.__resetLog(); return true;");
      const beforeBody = await cdp.eval("return document.getElementById('v').paused;");
      await cdp.click(640, 300); // middle of the picture, well clear of the bar
      await sleep(300);
      const bodyClick = await cdp.eval(`
        return { leaks: window.__probe().leaks, paused: document.getElementById('v').paused };
      `);
      check("fullscreen: clicking the picture does not navigate",
        bodyClick.leaks.length === 0, JSON.stringify(bodyClick.leaks));
      check("fullscreen: clicking the picture toggles playback",
        bodyClick.paused !== beforeBody, `${beforeBody} -> ${bodyClick.paused}`);

      const seekFs = await cdp.eval(`
        const sr = document.querySelector('igvc-overlay').shadowRoot;
        const r = sr.querySelector('.seek .track').getBoundingClientRect();
        return [Math.round(r.left + r.width * 0.3), Math.round(r.top + r.height / 2)];
      `);
      await cdp.eval("window.__resetLog(); return true;");
      await cdp.click(...seekFs);
      await sleep(300);
      const seekLeaks = await cdp.eval("return window.__probe().leaks;");
      check("fullscreen: scrubbing does not navigate", seekLeaks.length === 0, JSON.stringify(seekLeaks));

      // Exit through our own button rather than Escape: it is the path the user
      // takes, and it exercises the exit branch of onFullscreenChange.
      const exitCoords = await cdp.eval(`
        const sr = document.querySelector('igvc-overlay').shadowRoot;
        const r = sr.querySelector('.fs').getBoundingClientRect();
        return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
      `);
      await cdp.mouseMove(exitCoords[0], exitCoords[1] - 40);
      await sleep(200);
      await cdp.click(...exitCoords);
      await sleep(1000);
      const afterExit = await cdp.eval(`
        const host = document.querySelector('igvc-overlay');
        return { fsEl: !!document.fullscreenElement,
                 hostParent: host.parentElement.tagName,
                 staleAttrs: document.querySelectorAll('[data-igvc-fs-root],[data-igvc-fs]').length };
      `);
      check("exit restores the bar to body and clears attributes",
        afterExit.fsEl === false && afterExit.hostParent === "BODY" && afterExit.staleAttrs === 0,
        JSON.stringify(afterExit));
    }

    // --- preferences survive a reload (chrome.storage.sync round trip) ----
    await cdp.mouseMove(rect.x, rect.y);
    await cdp.mouseMove(rect.x + 1, rect.y + 1);
    await sleep(300);
    await cdp.click(...coords.mute); // unmute -> should persist
    await sleep(600);
    const before = await cdp.eval("return { muted: document.getElementById('v').muted };");
    check("mute button unmutes", before.muted === false, `muted=${before.muted}`);

    step("reloading for storage check");
    await cdp.send("Page.navigate", { url: ORIGIN });
    await sleep(2500);
    await cdp.eval("return await window.__ready;");
    step("reloaded");

    // Muted until hovered, on purpose: only the video the bar is on may make
    // sound, otherwise a feed autoplaying four posts plays four soundtracks.
    const beforeHover = await cdp.eval("return document.getElementById('v').muted;");
    check("videos start muted before the bar picks one", beforeHover === true, `muted=${beforeHover}`);

    // A gesture is required before restoring an unmuted state — unmuting
    // without one makes Chrome's autoplay policy stop the video. Hovering is
    // not a gesture, so click something inert first.
    await cdp.click(20, 20);
    await sleep(100);
    await cdp.mouseMove(rect.x, rect.y);
    await cdp.mouseMove(rect.x + 1, rect.y + 1);
    await sleep(800);
    const afterHover = await cdp.eval(`
      return { muted: document.getElementById('v').muted,
               hasBeenActive: navigator.userActivation.hasBeenActive };
    `);
    check("unmute preference survives a reload (chrome.storage.sync)",
      afterHover.muted === false,
      `after reload + gesture + hover muted=${afterHover.muted} (hasBeenActive=${afterHover.hasBeenActive})`);
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
  // A sentinel, so a caller can tell "all checks passed" from "the script died
  // before reaching the end" — both of which otherwise print nothing alarming.
  console.log("E2E_OK");
  // The killed child's pipes keep the loop alive; leaving would hang the run.
  process.exit(0);
}

main().catch((err) => {
  console.error("\ne2e aborted:", err.message);
  browser?.kill("SIGKILL");
  process.exit(2);
});
