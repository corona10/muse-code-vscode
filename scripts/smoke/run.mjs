// Bundles scripts/smoke/smoke.ts with a stubbed `vscode` module and runs it against the real `muse serve`.
// Usage: npm run smoke   (requires `muse` on PATH and a completed `muse login`; makes one real model call)
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(dir, ".smoke.bundle.cjs");
await build({ entryPoints: [path.join(dir, "smoke.ts")], bundle: true, platform: "node", format: "cjs", outfile: out, alias: { vscode: path.join(dir, "vscode-stub.cjs") }, logLevel: "warning" });
const r = spawnSync(process.execPath, [out], { stdio: "inherit", cwd: path.resolve(dir, "../..") });
process.exit(r.status ?? 1);
