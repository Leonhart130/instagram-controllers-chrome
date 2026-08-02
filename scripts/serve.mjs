/**
 * Dev server for the harness.
 *
 * Serves dev/index.html and the built bundle straight from dist/, so there is
 * no copy step to forget — a rebuild is picked up on the next request.
 *
 * Two listeners:
 *   http://localhost:8731   the everyday harness
 *   https://localhost:8732  used by scripts/e2e.mjs, which maps *.instagram.com
 *                           here. TLS is not optional there: instagram.com is on
 *                           Chromium's HSTS preload list, so http:// is upgraded
 *                           before any flag can stop it.
 *
 * The certificate is self-signed and regenerated into .certs/ when missing; the
 * browser is launched with --ignore-certificate-errors.
 */

import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = new URL("..", import.meta.url).pathname;
const HTTP_PORT = 8731;
const HTTPS_PORT = 8732;

const ROUTES = {
  "/": ["dev/index.html", "text/html; charset=utf-8"],
  "/index.html": ["dev/index.html", "text/html; charset=utf-8"],
  "/content.js": ["dist/content.js", "text/javascript; charset=utf-8"],
  "/content.css": ["dist/content.css", "text/css; charset=utf-8"],
  // A real, decodable clip. It matters that this is genuine media: duration,
  // currentTime and paused are DOM state shared with the extension's isolated
  // world, whereas a JS-shadowed fake clock is invisible there (LESSONS §6.1).
  // Gitignored — populate with `npm run fixture`.
  "/clip.webm": [".fixtures/clip.webm", "video/webm"],
};

async function ensureCert() {
  const dir = `${ROOT}.certs`;
  const key = `${dir}/key.pem`;
  const cert = `${dir}/cert.pem`;
  try {
    await access(key);
    await access(cert);
    return { key: await readFile(key), cert: await readFile(cert) };
  } catch {
    /* generate below */
  }
  await mkdir(dir, { recursive: true });
  const conf = `${dir}/openssl.cnf`;
  await writeFile(
    conf,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = ext",
      "prompt = no",
      "[dn]",
      "CN = localhost",
      "[ext]",
      "subjectAltName = DNS:localhost, DNS:instagram.com, DNS:*.instagram.com, IP:127.0.0.1",
      "basicConstraints = CA:FALSE",
    ].join("\n"),
  );
  await run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "825", "-config", conf,
  ]);
  console.log(`[igvc] generated self-signed cert in ${dir}`);
  return { key: await readFile(key), cert: await readFile(cert) };
}

async function handle(req, res) {
  const path = new URL(req.url, "http://x").pathname;
  const route = ROUTES[path];
  if (!route) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  try {
    const body = await readFile(ROOT + route[0]);

    // Range support matters for the video: without it Chrome cannot seek past
    // what it has already buffered, and currentTime assignments are silently
    // clamped to the seekable range. Instagram serves video by range too.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : body.length - 1;
      if (start >= body.length || end >= body.length || start > end) {
        res.writeHead(416, { "content-range": `bytes */${body.length}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "content-type": route[1],
        "content-range": `bytes ${start}-${end}/${body.length}`,
        "content-length": end - start + 1,
        "accept-ranges": "bytes",
        "cache-control": "no-store",
      });
      res.end(body.subarray(start, end + 1));
      return;
    }

    res.writeHead(200, {
      "content-type": route[1],
      "content-length": body.length,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`cannot read ${route[0]}: ${err.message}\nRun: npm run build`);
  }
}

const { key, cert } = await ensureCert();
createHttp(handle).listen(HTTP_PORT, "127.0.0.1", () =>
  console.log(`[igvc] harness  http://localhost:${HTTP_PORT}/`),
);
createHttps({ key, cert }, handle).listen(HTTPS_PORT, "127.0.0.1", () =>
  console.log(`[igvc] e2e      https://localhost:${HTTPS_PORT}/`),
);
