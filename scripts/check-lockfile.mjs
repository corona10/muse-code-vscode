// Fails when package-lock.json resolves packages from anything but the public npm registry,
// so a private mirror configured in ~/.npmrc can never leak into the committed lockfile.
// Run: npm run check:lockfile (also part of `npm run package`).
import { readFileSync } from "node:fs";

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const bad = new Set();
const walk = (pkgs) => {
  for (const [name, p] of Object.entries(pkgs ?? {})) {
    if (p.resolved && !p.resolved.startsWith("https://registry.npmjs.org/")) bad.add(`${name}: ${p.resolved}`);
    walk(p.dependencies);
  }
};
walk(lock.packages);
walk(lock.dependencies);

if (bad.size) {
  console.error(`package-lock.json has ${bad.size} package(s) not resolved from registry.npmjs.org:`);
  for (const b of [...bad].slice(0, 10)) console.error("  " + b);
  console.error("Fix: rm -rf node_modules package-lock.json && npm install   (the project .npmrc pins the public registry)");
  process.exit(1);
}
console.log("ok: every resolved URL in package-lock.json points at registry.npmjs.org");
