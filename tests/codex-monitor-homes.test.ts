/**
 * Codex の複数保存先（261005_1）: 通常の CODEX_HOME と Orca 用の CODEX_HOME をまとめて読む。
 */
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexHomesSource, codexHomes } from "../src/main/codex-monitor";
import type { CodexReadResult, CodexSessionRecord } from "../src/main/codex-session-reader";
import type { Liveness } from "../src/main/session-registry";

const record = (sessionId: string, lastEventAt: number, state: CodexSessionRecord["state"] = "running"): CodexSessionRecord =>
  ({ sessionId, cwd: "C:/dev/app", state, lastEventAt, firstSeenAt: lastEventAt });

afterEach(() => vi.unstubAllEnvs());

describe("CodexHomesSource", () => {
  const results: Record<string, CodexReadResult> = {
    user: { available: true, sessions: [record("both", 100, "done"), record("cursor-only", 50)] },
    orca: { available: true, sessions: [record("both", 200, "running"), record("orca-only", 70)] },
  };

  it("両方の DB を合わせ、同じスレッドは最終更新の新しい方を採る", () => {
    const source = new CodexHomesSource(() => ["user", "orca"], (h) => results[h], () => "unknown");
    const read = source.read();
    expect(read.available).toBe(true);
    expect(read.sessions.map((s) => [s.sessionId, s.state])).toEqual([["both", "running"], ["cursor-only", "running"], ["orca-only", "running"]]);
  });

  it("生存判定は見つかった保存先のロックだけで行い、alive が 1 つでもあれば alive", () => {
    const locks: Record<string, Liveness> = { "user:both": "dead", "orca:both": "alive", "user:cursor-only": "alive", "orca:orca-only": "dead" };
    const asked: string[] = [];
    const source = new CodexHomesSource(() => ["user", "orca"], (h) => results[h], (home, id) => {
      asked.push(`${home}:${id}`);
      return locks[`${home}:${id}`] ?? "unknown";
    });
    source.read();
    expect(source.liveness("both")).toBe("alive");
    expect(source.liveness("cursor-only")).toBe("alive");
    expect(source.liveness("orca-only")).toBe("dead");
    // Orca 側に無いスレッドは Orca のロックを見ない（ロック不在 = dead と誤判定しない）
    expect(asked).not.toContain("orca:cursor-only");
    expect(asked).not.toContain("user:orca-only");
  });

  it("判定不能が混じれば unknown、片方の DB が読めなくても読めた方を使う", () => {
    const source = new CodexHomesSource(
      () => ["user", "orca"],
      (h) => (h === "orca" ? { available: false, sessions: [], error: "locked" } : results.user),
      (home) => (home === "user" ? "unknown" : "dead"),
    );
    const read = source.read();
    expect(read.available).toBe(true);
    expect(read.sessions.map((s) => s.sessionId)).toEqual(["both", "cursor-only"]);
    expect(source.liveness("both")).toBe("unknown");
    const none = new CodexHomesSource(() => ["a"], () => ({ available: false, sessions: [], error: "locked" }));
    expect(none.read()).toEqual({ available: false, sessions: [], error: "locked" });
  });
});

describe("片方の保存先だけ読めないとき（レビュー指摘 P1）", () => {
  it("30 秒以内は直近の成功結果を使い、実行中の会話を消さず、Orca 側の lock で生存を判定し続ける", () => {
    let now = 0;
    let orcaReadable = true;
    const locks: Record<string, Liveness> = { "user:both": "dead", "orca:both": "alive", "orca:orca-only": "alive" };
    const source = new CodexHomesSource(
      () => ["user", "orca"],
      (h) => h === "user"
        ? { available: true, sessions: [record("both", 100)] }
        : orcaReadable ? { available: true, sessions: [record("both", 200), record("orca-only", 200)] } : { available: false, sessions: [], error: "locked" },
      (home, id) => locks[`${home}:${id}`] ?? "unknown",
      () => now,
    );
    source.read();
    orcaReadable = false;
    now = 10_000;
    const during = source.read();
    expect(during.sessions.map((s) => s.sessionId).sort()).toEqual(["both", "orca-only"]);
    expect(source.liveness("both")).toBe("alive");
    expect(source.liveness("orca-only")).toBe("alive");
    // 猶予を過ぎたら読めない保存先は外す（読める保存先の会話は残る）
    now = 40_000;
    expect(source.read().sessions.map((s) => s.sessionId)).toEqual(["both"]);
  });
});

describe("codexHomes", () => {
  it("検証用の TERMINAL_APP_CODEX_HOME 指定時はそれだけを読む", () => {
    vi.stubEnv("TERMINAL_APP_CODEX_HOME", "C:\\fixture\\codex");
    expect(codexHomes()).toEqual(["C:\\fixture\\codex"]);
  });

  it("CODEX_HOME が別の場所（Orca から起動して継承した等）でも ~/.codex を読み落とさない", () => {
    vi.stubEnv("TERMINAL_APP_CODEX_HOME", "");
    vi.stubEnv("CODEX_HOME", "C:\\elsewhere\\codex");
    const homes = codexHomes();
    expect(homes[0]).toBe("C:\\elsewhere\\codex");
    expect(homes).toContain(path.join(os.homedir(), ".codex"));
  });
});
