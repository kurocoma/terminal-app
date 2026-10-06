import * as fs from "fs";
import * as path from "path";

/**
 * 最小構成のファイルロガー（design.md 10 章）。
 * - 出力先: <dataDir>/logs/app.log
 * - ローテーション: 日次（日付が変わったら app-YYYYMMDD.log へ退避）・直近 7 日分のみ保持
 * - 個人利用前提のため同期 I/O の簡易実装とする（書き込み量は少ない）
 * - 通常はファイルだけへ出力する。親の Codex 等の対話画面へログを混ぜない
 */
export class Logger {
  private readonly logDir: string;
  private readonly logFile: string;
  private currentDate: string;

  constructor(dataDir: string, private readonly mirrorToConsole = false) {
    this.logDir = path.join(dataDir, "logs");
    this.logFile = path.join(this.logDir, "app.log");
    this.currentDate = this.today();
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      this.rotateIfNeeded();
    } catch {
      /* ログ不能でも本体を止めない（NFR-02 と同思想） */
    }
  }

  info(msg: string): void {
    this.write("INFO", msg);
  }

  warn(msg: string): void {
    this.write("WARN", msg);
  }

  error(msg: string): void {
    this.write("ERROR", msg);
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private write(level: string, msg: string): void {
    const line = `${new Date().toISOString()} [${level}] ${msg}`;
    if (this.mirrorToConsole) console.log(line);
    try {
      if (this.today() !== this.currentDate) this.rotateIfNeeded();
      fs.appendFileSync(this.logFile, line + "\n", "utf8");
    } catch {
      /* 書けなくても継続 */
    }
  }

  /** 日付が変わっていたら app.log を app-YYYYMMDD.log へ退避し、7 日より古い退避分を削除 */
  private rotateIfNeeded(): void {
    try {
      if (fs.existsSync(this.logFile)) {
        const mtime = fs.statSync(this.logFile).mtime;
        const fileDate = mtime.toISOString().slice(0, 10);
        if (fileDate !== this.today()) {
          const archived = path.join(this.logDir, `app-${fileDate.replaceAll("-", "")}.log`);
          fs.renameSync(this.logFile, archived);
        }
      }
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const f of fs.readdirSync(this.logDir)) {
        if (/^app-\d{8}\.log$/.test(f)) {
          const full = path.join(this.logDir, f);
          if (fs.statSync(full).mtime.getTime() < cutoff) fs.unlinkSync(full);
        }
      }
      this.currentDate = this.today();
    } catch {
      /* ローテーション失敗は無視して追記継続 */
    }
  }
}

/** テストや純粋ロジックから使う空実装 */
export const nullLogger = {
  info: (_msg: string): void => undefined,
  warn: (_msg: string): void => undefined,
  error: (_msg: string): void => undefined,
};

export type LoggerLike = Pick<Logger, "info" | "warn" | "error">;
