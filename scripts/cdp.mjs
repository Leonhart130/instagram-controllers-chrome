/**
 * Shared plumbing for the browser-driving check scripts.
 *
 * Three scripts drive a browser (harness, e2e, reels) and each had grown its
 * own copy of this. One copy, so a fix to the watchdog or the settle-on-timeout
 * behaviour lands everywhere.
 */

import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const HEADFUL = process.argv.includes("--headful");

export class CDP {
  #ws;
  #id = 0;
  #pending = new Map();

  /** Finds the page target on a debugging port and connects to it. */
  static async attach(port) {
    let target;
    for (let i = 0; i < 40; i++) {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => []);
      target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (target) break;
      await sleep(150);
    }
    if (!target) throw new Error("no page target");

    const cdp = new CDP();
    cdp.#ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      cdp.#ws.addEventListener("open", resolve, { once: true });
      cdp.#ws.addEventListener("error", () => reject(new Error("cdp connect failed")), { once: true });
    });
    cdp.#ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      const pending = cdp.#pending.get(msg.id);
      if (!pending) return;
      cdp.#pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    });
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    return cdp;
  }

  send(method, params = {}) {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} timed out`));
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

  sleep(ms) {
    return sleep(ms);
  }

  mouseMove(x, y) {
    return this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  }

  async click(x, y) {
    await this.mouseMove(x, y);
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  }

  close() {
    try { this.#ws.close(); } catch { /* already gone */ }
  }
}

export async function launchBrowser({ extension, hostResolverRules, ignoreCertErrors, width = 1280, height = 900 } = {}) {
  const profileDir = await mkdtemp(join(tmpdir(), "igvc-"));
  const args = [
    ...(HEADFUL ? [] : ["--headless=new"]),
    `--window-size=${width},${height}`,
    `--user-data-dir=${profileDir}`,
    ...(extension ? [`--load-extension=${extension}`, `--disable-extensions-except=${extension}`] : []),
    ...(hostResolverRules ? [`--host-resolver-rules=${hostResolverRules}`] : []),
    ...(ignoreCertErrors ? ["--ignore-certificate-errors"] : []),
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-brave-update",
    "--disable-sync",
    "about:blank",
  ];
  const proc = spawn("brave-browser", args, { stdio: ["ignore", "pipe", "pipe"] });
  proc.stderr.on("data", () => {});

  for (let i = 0; i < 100; i++) {
    await sleep(150);
    try {
      const [port] = (await readFile(join(profileDir, "DevToolsActivePort"), "utf8")).split("\n");
      if (port) {
        return { proc, port: Number(port), cleanup: () => rm(profileDir, { recursive: true, force: true }).catch(() => {}) };
      }
    } catch { /* not written yet */ }
  }
  proc.kill("SIGKILL");
  throw new Error("browser never reported a debugging port");
}

/** Fails loudly rather than letting every check report a mysterious timeout. */
export async function requireServer(port, { tls = false } = {}) {
  const mod = tls ? https : http;
  try {
    await new Promise((resolve, reject) => {
      const req = mod.get(
        { host: "127.0.0.1", port, path: "/", timeout: 3000, ...(tls ? { rejectUnauthorized: false } : {}) },
        (res) => {
          res.resume();
          res.statusCode === 200 ? resolve() : reject(new Error(`status ${res.statusCode}`));
        },
      );
      req.on("timeout", () => req.destroy(new Error("timed out")));
      req.on("error", reject);
    });
  } catch (err) {
    console.error(`\nThe dev server is not answering on port ${port} — ${err.message}`);
    console.error("Start it with:  npm run serve\n");
    process.exit(2);
  }
}

export class Checks {
  #results = [];

  constructor(watchdogMs = 120000) {
    const t = setTimeout(() => {
      console.error(`\nwatchdog: nothing finished within ${watchdogMs / 1000}s`);
      process.exit(2);
    }, watchdogMs);
    t.unref();
    this.watchdog = t;
  }

  /** ok === null means "could not run" — never reported as a pass. */
  add(name, ok, detail) {
    this.#results.push({ name, ok });
    const tag = ok === true ? "PASS" : ok === null ? "INCONCLUSIVE" : "FAIL";
    console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
  }

  finish(sentinel) {
    clearTimeout(this.watchdog);
    const failed = this.#results.filter((r) => r.ok === false).length;
    const inconclusive = this.#results.filter((r) => r.ok === null).length;
    console.log(`\n${this.#results.length - failed - inconclusive} passed, ${failed} failed, ${inconclusive} inconclusive`);
    if (failed || inconclusive) process.exit(2);
    // A sentinel, so a caller can tell "all passed" from "died before the end".
    console.log(sentinel);
    process.exit(0);
  }
}
