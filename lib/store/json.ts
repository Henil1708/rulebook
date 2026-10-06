// Small JSON files under workspace/.rulebook. Writes are synchronous write-to-temp + rename, so a crash never
// leaves a half-written file and two writes in one process can't interleave.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readJson<T>(file: string, fallback: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
}
