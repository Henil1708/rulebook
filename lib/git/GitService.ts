// All git access for the workspace repo. execFile only (never a shell string), and every
// write goes through one process-wide mutex shared with agent runs.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { promisify } from "node:util";
import { buildCommitMessage, parseTrailers, sanitiseMessage, type Trailers } from "./message";

const execFileAsync = promisify(execFile);

// One queue per process. Kept on globalThis so Next's per-route bundles share it.
// ponytail: in-process lock only; one server process owns workspace/, so no file lock needed.
const g = globalThis as { __rulebookLock?: Promise<unknown>; __rulebookLockDepth?: number };

/** Run `fn` after every earlier locked call has settled. */
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  g.__rulebookLockDepth = (g.__rulebookLockDepth ?? 0) + 1;
  const next = (g.__rulebookLock ?? Promise.resolve()).then(fn, fn).finally(() => {
    g.__rulebookLockDepth! -= 1;
  });
  g.__rulebookLock = next.catch(() => {});
  return next;
}

/** True while a locked call is running or queued, so routes can answer "busy" instead of waiting minutes. */
export function lockBusy(): boolean {
  return (g.__rulebookLockDepth ?? 0) > 0;
}

/** Refs/branches go straight into argv, so a leading `-` would be read as an option (e.g. `--output=`). */
function assertRef(ref: string): string {
  if (!/^[\w./@^~{}-]+$/.test(ref) || ref.startsWith("-")) throw new Error(`invalid ref: ${ref}`);
  return ref;
}

/** Repo-relative path that cannot climb out of the repo. */
function assertRelPath(path: string): string {
  const p = normalize(path);
  if (isAbsolute(p) || p === ".." || p.startsWith("../") || p.startsWith("-")) throw new Error(`invalid path: ${path}`);
  return p;
}

export interface Commit {
  sha: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  trailers: Trailers;
}

export interface Change {
  files: Record<string, string>;
  message: string;
  trailers?: Trailers;
  /** Runs inside the lock right after the commit, e.g. to record the sha before anyone else can act. */
  after?: (sha: string) => void | Promise<void>;
}

export interface BlameLine {
  sha: string;
  line: number;
  text: string;
}

export class GitService {
  constructor(readonly cwd: string) {}

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd: this.cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }

  /** `git init` + first commit of everything in cwd, with a fixed local identity. */
  init(message: string): Promise<string> {
    return withLock(async () => {
      await this.git(["init", "-q", "-b", "main"]);
      await this.git(["config", "user.name", "Rulebook"]);
      await this.git(["config", "user.email", "rulebook@localhost"]);
      await this.git(["add", "-A"]);
      await this.git(["commit", "-q", "-m", buildCommitMessage(message)]);
      return this.head();
    });
  }

  async head(): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  async log(opts: { ref?: string; path?: string; max?: number } = {}): Promise<Commit[]> {
    const args = ["log", `--format=%H%x1f%an%x1f%aI%x1f%s%x1f%B%x1e`, `--max-count=${opts.max ?? 200}`, assertRef(opts.ref ?? "HEAD")];
    if (opts.path) args.push("--", assertRelPath(opts.path));
    const out = await this.git(args);
    return out.split("\x1e").map((r) => r.trim()).filter(Boolean).map((r) => {
      const [sha, author, date, subject, raw] = r.split("\x1f");
      const body = raw.slice(subject.length).trim();
      return { sha, author, date, subject, body, trailers: parseTrailers(raw) };
    });
  }

  async show(ref: string): Promise<string> {
    return this.git(["show", "--no-color", assertRef(ref)]);
  }

  async diff(from: string, to?: string, path?: string): Promise<string> {
    const args = ["diff", "--no-color", assertRef(from)];
    if (to) args.push(assertRef(to));
    if (path) args.push("--", assertRelPath(path));
    return this.git(args);
  }

  async blame(path: string, ref = "HEAD"): Promise<BlameLine[]> {
    const out = await this.git(["blame", "--line-porcelain", assertRef(ref), "--", assertRelPath(path)]);
    const lines: BlameLine[] = [];
    let sha = "";
    let line = 0;
    for (const l of out.split("\n")) {
      const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(l);
      if (header) [sha, line] = [header[1], Number(header[2])];
      else if (l.startsWith("\t")) lines.push({ sha, line, text: l.slice(1) });
    }
    return lines;
  }

  async readFileAt(ref: string, path: string): Promise<string> {
    return this.git(["show", `${assertRef(ref)}:${assertRelPath(path)}`]);
  }

  /**
   * Write `files` (repo-relative path → content), stage them and commit with trailers. Returns the new sha.
   * Pass a function to build the change inside the lock, when it depends on the current repo state.
   */
  commit(
    files: Record<string, string> | (() => Promise<Change> | Change),
    message?: string,
    trailers: Trailers = {},
  ): Promise<string> {
    return withLock(async () => {
      const change = typeof files === "function" ? await files() : { files, message: message ?? "", trailers };
      return this.commitUnlocked(change);
    });
  }

  private async commitUnlocked({ files, message, trailers = {}, after }: Change): Promise<string> {
    const paths = Object.keys(files).map(assertRelPath);
    for (const p of paths) {
      await mkdir(dirname(join(this.cwd, p)), { recursive: true });
      await writeFile(join(this.cwd, p), files[p]);
    }
    await this.git(["add", "--", ...paths]);
    await this.git(["commit", "-q", "-m", buildCommitMessage(message, trailers)]);
    const sha = await this.head();
    await after?.(sha);
    return sha;
  }

  /** Append one line to a memory file (default memory/MEMORY.md) and commit it. Both text and message are sanitised. */
  appendMemory(text: string, message: string, path = "memory/MEMORY.md"): Promise<string> {
    return this.commit(async () => {
      const p = assertRelPath(path);
      const current = await readFile(join(this.cwd, p), "utf8").catch(() => "");
      return { files: { [p]: `${current}- ${sanitiseMessage(text, 500)}\n` }, message: sanitiseMessage(message) };
    });
  }

  /** `git revert --no-edit`; a conflicting revert is aborted so the repo stays clean. `after` runs inside the lock. */
  revert(sha: string, after?: (sha: string) => void | Promise<void>): Promise<string> {
    return withLock(async () => {
      try {
        await this.git(["revert", "--no-edit", assertRef(sha)]);
      } catch (err) {
        await this.git(["revert", "--abort"]).catch(() => {});
        throw err;
      }
      const head = await this.head();
      await after?.(head);
      return head;
    });
  }

  async branches(): Promise<{ current: string; all: string[] }> {
    const [current, all] = await Promise.all([
      this.git(["branch", "--show-current"]),
      this.git(["branch", "--format=%(refname:short)"]),
    ]);
    return { current: current.trim(), all: all.split("\n").filter(Boolean) };
  }

  switch(branch: string, create = false): Promise<void> {
    return withLock(async () => {
      await this.git(create ? ["switch", "-c", assertRef(branch)] : ["switch", assertRef(branch)]);
    });
  }

  merge(branch: string): Promise<string> {
    return withLock(async () => {
      await this.git(["merge", "--no-ff", "--no-edit", assertRef(branch)]);
      return this.head();
    });
  }
}
