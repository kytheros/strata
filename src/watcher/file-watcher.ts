/**
 * Multi-directory file watcher for session files.
 * Watches all detected parser directories simultaneously.
 */

import { watch, existsSync, type FSWatcher } from "fs";
import { join } from "path";
import { homedir } from "os";
import { CONFIG } from "../config.js";
import { hasFeature } from "../extensions/feature-gate.js";

/** A directory to watch with its file-matching criteria. */
export interface WatchTarget {
  /** Absolute path to watch, e.g. ~/.gemini/tmp/ */
  dir: string;
  /** Glob-style pattern for matching filenames, e.g. "checkpoint-*.json" */
  glob: string;
  /** File extensions to match, e.g. [".json"] */
  extensions: string[];
  /** Parser identifier, e.g. "gemini-cli" */
  parserId: string;
}

export type FileChangeCallback = (filePath: string, parserId: string) => void;

/**
 * Build the default watch targets for all known parsers.
 * Only returns targets whose directories actually exist on disk.
 */
export function getWatchTargets(): WatchTarget[] {
  // Free tier: Claude Code, Codex, Cline
  const targets: WatchTarget[] = [
    {
      dir: CONFIG.projectsDir,
      glob: "*.jsonl",
      extensions: [".jsonl"],
      parserId: "claude-code",
    },
    {
      dir: join(homedir(), ".codex", "sessions"),
      glob: "rollout-*.jsonl",
      extensions: [".jsonl"],
      parserId: "codex",
    },
    {
      dir: getClineTasksDir(),
      glob: "api_conversation_history.json",
      extensions: [".json"],
      parserId: "cline",
    },
  ];

  // Pro tier: Gemini CLI (Aider uses project-level files, not a watch dir)
  if (hasFeature("pro")) {
    targets.push({
      dir: join(homedir(), ".gemini", "tmp"),
      glob: "checkpoint-*.json",
      extensions: [".json"],
      parserId: "gemini-cli",
    });
  }

  // Add extra watch dirs from env var
  const extra = CONFIG.extraWatchDirs;
  for (const entry of extra) {
    // Split on the last colon to handle Windows drive letters (e.g. C:\path:.ext)
    const lastColon = entry.lastIndexOf(":");
    if (lastColon <= 0) continue;
    const dir = entry.slice(0, lastColon);
    const ext = entry.slice(lastColon + 1);
    if (dir && ext) {
      targets.push({
        dir,
        glob: `*${ext}`,
        extensions: [ext.startsWith(".") ? ext : `.${ext}`],
        parserId: `extra:${dir}`,
      });
    }
  }

  return targets.filter((t) => existsSync(t.dir));
}

export class FileWatcher {
  private watchers: FSWatcher[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private debounceMs: number;
  private targets: WatchTarget[];

  constructor(debounceMs = CONFIG.watcher.debounceMs, targets?: WatchTarget[]) {
    this.debounceMs = debounceMs;
    this.targets = targets ?? getWatchTargets();
  }

  /**
   * Start watching all target directories.
   * Each target gets its own independent fs.watch().
   */
  start(onChange: FileChangeCallback): void {
    for (const target of this.targets) {
      this.startWatchTarget(target, onChange);
    }
  }

  /**
   * Stop all watchers and clear all debounce timers.
   */
  stop(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // Ignore errors on close
      }
    }
    this.watchers = [];
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private startWatchTarget(target: WatchTarget, onChange: FileChangeCallback): void {
    if (!existsSync(target.dir)) return;

    try {
      const watcher = watch(
        target.dir,
        { recursive: true },
        (_event, filename) => {
          if (!filename) return;
          if (!matchesTarget(filename, target)) return;

          // Debounce: wait for file to stop changing
          const key = `${target.parserId}:${filename}`;
          const existing = this.debounceTimers.get(key);
          if (existing) clearTimeout(existing);

          this.debounceTimers.set(
            key,
            setTimeout(() => {
              this.debounceTimers.delete(key);
              onChange(filename, target.parserId);
            }, this.debounceMs)
          );
        }
      );
      this.watchers.push(watcher);
    } catch {
      // If watching fails for this target, silently skip it.
      // One tool's watcher failing must not affect others.
    }
  }
}

/**
 * Check if a filename matches a watch target's criteria.
 */
function matchesTarget(filename: string, target: WatchTarget): boolean {
  // Normalize path separators
  const normalized = filename.replace(/\\/g, "/");
  const basename = normalized.split("/").pop() || "";

  // Check extension match
  const extMatch = target.extensions.some((ext) => basename.endsWith(ext));
  if (!extMatch) return false;

  // Check glob prefix match (e.g., "checkpoint-*.json" means starts with "checkpoint-")
  if (target.glob.includes("*")) {
    const prefix = target.glob.split("*")[0];
    if (prefix && !basename.startsWith(prefix)) return false;
  } else {
    // Exact filename match (e.g., "api_conversation_history.json")
    if (basename !== target.glob) return false;
  }

  return true;
}

/**
 * Resolve the Cline tasks directory based on platform.
 */
function getClineTasksDir(): string {
  const platform = process.platform;
  if (platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "tasks");
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "tasks");
  }
  return join(homedir(), ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "tasks");
}
