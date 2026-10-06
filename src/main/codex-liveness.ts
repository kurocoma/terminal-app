/**
 * Codex の writer lock から Windows 上のスレッド生存を読み取る。
 * Codex 自身が所有するロックは取得・変更せず、先頭 1 byte の読み取りだけを試す。
 * 排他ロック範囲への ReadFile は失敗し、Node.js は ERROR_LOCK_VIOLATION を EBUSY にする。
 * ロックファイルは空でもよい。読むことができれば、所有者のいない古いファイルと判断できる。
 *
 * 根拠: codex-rs/rollout/src/writer_lock.rs と Windows ReadFile / LockFileEx の仕様。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Liveness } from "./session-registry";

/** OS / ファイル操作の差し替えは単体検証用。実行時は全て読み取り専用の native 操作。 */
export interface CodexLivenessDeps {
  platform: NodeJS.Platform;
  statSync(filePath: string): Pick<fs.Stats, "isDirectory">;
  openSync(filePath: string, flags: "r"): number;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
}

const nativeDeps: CodexLivenessDeps = {
  platform: process.platform,
  statSync: fs.statSync,
  openSync: fs.openSync,
  readSync: fs.readSync,
  closeSync: fs.closeSync,
};

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
}

/**
 * directory 無し・OS 非対応・権限不足は unknown（旧版でも終了したと断定しない）。
 * directory が存在するのにファイルが無い、またはロックされていなければ dead。
 * read の EBUSY だけが alive の根拠。open の EBUSY は共有拒否等と区別できないため unknown。
 */
export function readCodexLiveness(
  codexHome: string,
  sessionId: string,
  deps: CodexLivenessDeps = nativeDeps,
): Liveness {
  if (deps.platform !== "win32" || sessionId.length !== 36 || !THREAD_ID.test(sessionId)) return "unknown";
  const directory = path.join(codexHome, "thread-writer-locks");
  try {
    if (!deps.statSync(directory).isDirectory()) return "unknown";
  } catch {
    return "unknown";
  }

  let fd: number;
  try {
    fd = deps.openSync(path.join(directory, `${sessionId}.lock`), "r");
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "dead" : "unknown";
  }
  try {
    deps.readSync(fd, Buffer.alloc(1), 0, 1, 0);
    return "dead";
  } catch (error) {
    return errorCode(error) === "EBUSY" ? "alive" : "unknown";
  } finally {
    try { deps.closeSync(fd); } catch { /* 読み取り済みの生存判定を閉じる失敗で覆さない */ }
  }
}
