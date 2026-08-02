import { cp, mkdir, rm } from "node:fs/promises";
import { watch as watchDir } from "node:fs";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

async function copyStatic() {
  await cp("public", "dist", { recursive: true });
}

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await copyStatic();

const ctx = await esbuild.context({
  entryPoints: ["src/content/index.ts"],
  bundle: true,
  outfile: "dist/content.js",
  format: "iife",
  platform: "browser",
  target: "chrome120",
  legalComments: "none",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
  watchDir("public", { recursive: true }, () => {
    copyStatic().catch((err) => console.error("[igvc] copy failed:", err));
  });
  console.log("[igvc] watching — reload the extension in the browser after each rebuild");
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("[igvc] built to dist/");
}
