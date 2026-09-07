import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

const extensionCtx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
});

const webviewCtx = await esbuild.context({
  entryPoints: ["src/webview-ui/main.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  outfile: "dist/webview.js",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
});

if (watch) {
  await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
} else {
  await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
  await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
}
