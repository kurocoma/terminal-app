import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Logger } from "../src/main/logger";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it("通常の動作ログは親ターミナルに出さず、日本語を含めファイルに保存する", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-app-logger-"));
  dirs.push(dir);
  const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const logger = new Logger(dir);

  logger.info("セッションを更新しました");
  logger.warn("接続を再試行します");
  logger.error("読み取りに失敗しました");

  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).not.toHaveBeenCalled();
  const log = fs.readFileSync(path.join(dir, "logs", "app.log"), "utf8");
  expect(log).toContain("[INFO] セッションを更新しました");
  expect(log).toContain("[WARN] 接続を再試行します");
  expect(log).toContain("[ERROR] 読み取りに失敗しました");
});
