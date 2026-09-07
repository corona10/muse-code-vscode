import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * VS Code launched from the Dock/Spotlight inherits a minimal PATH that usually lacks
 * user-local bin dirs (~/.local/bin, /opt/homebrew/bin, ...), so a bare `muse` fails to spawn.
 * This resolves a bare command name to an absolute path by checking, in order:
 * the current PATH, well-known install locations, and finally the user's login shell.
 * Values that already contain a path separator (or `~`) are used as-is.
 */
export async function resolveExecutable(configured: string, log: (l: string) => void): Promise<string> {
  const name = expandHome(configured.trim() || "muse");
  if (name.includes("/") || name.includes("\\")) return name;

  const cached = cache.get(name);
  if (cached) return cached;

  const hits: (string | null)[] = [await findOnPath(name, process.env.PATH ?? ""), await findInDirs(name, wellKnownDirs())];
  let found = hits.find(Boolean) ?? null;
  if (!found && process.platform !== "win32") found = await findViaLoginShell(name, log);

  if (!found) return name; // let spawn fail with ENOENT and report it
  log(`resolved '${name}' -> ${found}`);
  cache.set(name, found);
  return found;
}

/** Forget resolved paths (e.g. when configuration changes or a launch fails). */
export function resetExecutableCache() {
  cache.clear();
}

const cache = new Map<string, string>();

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

function wellKnownDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".muse", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
  ];
}

function findOnPath(name: string, PATH: string): Promise<string | null> {
  return findInDirs(name, PATH.split(path.delimiter).filter(Boolean));
}

async function findInDirs(name: string, dirs: string[]): Promise<string | null> {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) return false;
    if (process.platform !== "win32") await fs.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Asks the user's login shell where the command lives, so PATH set in .zprofile/.zshrc etc. is honored. */
function findViaLoginShell(name: string, log: (l: string) => void): Promise<string | null> {
  const shell = process.env.SHELL || "/bin/sh";
  return new Promise((resolve) => {
    execFile(shell, ["-ilc", `command -v ${name}`], { timeout: 5000, env: { ...process.env, TERM: "dumb" } }, (err, stdout) => {
      if (err) {
        log(`login shell lookup for '${name}' failed: ${err.message}`);
        return resolve(null);
      }
      const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
      resolve(path.isAbsolute(line) ? line : null);
    });
  });
}
