/**
 * 260927_1: 自己診断の純関数（ログ集計・往復検知・表示と実データの突き合わせ）。
 *
 * 実データ（2026-09-27 の app.log 5 日分）で確かめた形:
 * - 「確認待ちから復帰 → 終了検知」が同じ秒に並ぶ往復が 109 回
 * - 「Jev: タイムアウト（4000ms…）」の WARN が出る
 */
import { describe, expect, it } from "vitest";
import {
  DIAGNOSE_WINDOW_MS,
  FLIP_FLOP_WINDOW_MS,
  analyzeAppLog,
  checkSessionConsistency,
  formatCheck,
  formatCounts,
  overallLevel,
  parseLogLine,
  type ConsistencyDeps,
  type DiagSession,
} from "../src/main/diagnose";

const T = Date.parse("2026-09-27T06:00:00.000Z");
const at = (offsetMs: number): string => new Date(T + offsetMs).toISOString();

describe("parseLogLine", () => {
  it("時刻・レベル・見出し・本文・セッションを取り出す", () => {
    const e = parseLogLine(`${at(0)} [INFO] event 受信: Stop → done (project=p1, session=6bf8601a-aa2e-4b44-a4fa-c14997d42e4c)`);
    expect(e).toMatchObject({ at: T, level: "INFO", kind: "event 受信", session: "6bf8601a" });
    expect(e?.rest).toContain("Stop → done");
  });

  it("WARN / ERROR も読む。セッションが無い行は session なし", () => {
    expect(parseLogLine(`${at(0)} [WARN] Jev: タイムアウト（4000ms。判定なしとして続行）`)).toMatchObject({ level: "WARN", kind: "Jev" });
    expect(parseLogLine(`${at(0)} [INFO] 起動時復元: 22 プロジェクトを走査`)?.session).toBeUndefined();
  });

  it("形が違う行・時刻が壊れた行は null", () => {
    expect(parseLogLine("ただの文字列")).toBeNull();
    expect(parseLogLine("not-a-date [INFO] foo: bar")).toBeNull();
    expect(parseLogLine("")).toBeNull();
  });
});

describe("analyzeAppLog", () => {
  const lines = [
    `${at(-2 * 60 * 60_000)} [INFO] event 受信: Stop → done (project=p1, session=aaaaaaaa-0000-0000-0000-000000000000)`,
    `${at(-60_000)} [INFO] event 受信: UserPromptSubmit → running (project=p1, session=aaaaaaaa-0000-0000-0000-000000000000)`,
    `${at(-50_000)} [INFO] event 受信: Notification 種別=idle → confirm (project=p1, session=aaaaaaaa-0000-0000-0000-000000000000)`,
    `${at(-40_000)} [INFO] Jev 返答待ち判定: app (session=aaaaaaaa-0000-0000-0000-000000000000) → 完了のまま (asks_user=0.10)`,
    `${at(-30_000)} [INFO] Jev 危険度判定: app (session=aaaaaaaa-0000-0000-0000-000000000000) → 印なし`,
    `${at(-20_000)} [WARN] Jev: タイムアウト（4000ms。判定なしとして続行）`,
  ].join("\n");

  it("イベント・判定・警告を数える", () => {
    const s = analyzeAppLog(lines, T);
    expect(s.events).toEqual({ Stop: 1, UserPromptSubmit: 1, Notification: 1 });
    expect(s.judgments).toEqual({ 返答待ち判定: 1, 危険度判定: 1 });
    expect(s.problems).toHaveLength(1);
    expect(s.problems[0].level).toBe("WARN");
    expect(s.lines).toBe(6);
  });

  it("窓の外は数えない", () => {
    const s = analyzeAppLog(lines, T, 30 * 60_000);
    expect(s.events.Stop).toBeUndefined();
    expect(s.since).toBe(T - 30 * 60_000);
    expect(analyzeAppLog(lines, T, DIAGNOSE_WINDOW_MS).events.Stop).toBe(1);
  });

  it("「復帰 → 終了検知」の往復を数える（実データで見つかった形）", () => {
    const sid = "bbbbbbbb-0000-0000-0000-000000000000";
    const flip = [
      `${at(-300_000)} [INFO] 確認待ちから復帰: app (session=${sid}) — 許可後に transcript が更新`,
      `${at(-299_000)} [INFO] 終了検知: app (session=${sid}) — Stop 未受信だがターン完了`,
      `${at(-240_000)} [INFO] 確認待ちから復帰: app (session=${sid}) — 許可後に transcript が更新`,
      `${at(-239_000)} [INFO] 終了検知: app (session=${sid}) — Stop 未受信だがターン完了`,
    ].join("\n");
    const s = analyzeAppLog(flip, T);
    expect(s.flipFlops).toHaveLength(1);
    expect(s.flipFlops[0]).toMatchObject({ session: "bbbbbbbb", count: 3, pattern: "確認待ちから復帰 → 終了検知" });
  });

  it("間隔が空いた遷移は往復に数えない（普通の作業の流れ）", () => {
    const sid = "cccccccc-0000-0000-0000-000000000000";
    const slow = [
      `${at(-FLIP_FLOP_WINDOW_MS * 3)} [INFO] 確認待ちから復帰: app (session=${sid}) — x`,
      `${at(-FLIP_FLOP_WINDOW_MS)} [INFO] 終了検知: app (session=${sid}) — y`,
    ].join("\n");
    expect(analyzeAppLog(slow, T).flipFlops).toEqual([]);
  });

  it("同じ向きの連続は往復ではない。空ログは空の集計", () => {
    const sid = "dddddddd-0000-0000-0000-000000000000";
    const same = [`${at(-20_000)} [INFO] 終了検知: app (session=${sid}) — x`, `${at(-10_000)} [INFO] 終了検知: app (session=${sid}) — y`].join("\n");
    expect(analyzeAppLog(same, T).flipFlops).toEqual([]);
    const empty = analyzeAppLog("", T);
    expect(empty.lines).toBe(0);
    expect(empty.flipFlops).toEqual([]);
  });
});

describe("checkSessionConsistency", () => {
  const base: DiagSession = { sessionId: "eeeeeeee-1111", projectId: "p1", state: "confirm", lastEventAt: T - 60_000, transcriptPath: "C:/t/s.jsonl" };
  const deps = (over: Partial<ConsistencyDeps> = {}): ConsistencyDeps => ({
    now: () => T,
    liveness: () => "alive",
    turnEnd: () => "concluded",
    subagentMtimeMs: () => null,
    projectName: () => "app",
    ...over,
  });

  it("確認待ち・返答待ちなのにターンが動いていれば NG", () => {
    const f = checkSessionConsistency([base], deps({ turnEnd: () => "open" }));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ level: "ng", session: "eeeeeeee", project: "app" });
    expect(f[0].text).toContain("確認待ち");
    const q = checkSessionConsistency([{ ...base, confirmKind: "question" }], deps({ turnEnd: () => "open" }));
    expect(q[0].text).toContain("返答待ち");
  });

  it("完了なのにサブエージェントが動いていれば NG", () => {
    const f = checkSessionConsistency([{ ...base, state: "done" }], deps({ subagentMtimeMs: () => T - 10_000 }));
    expect(f[0]).toMatchObject({ level: "ng" });
    expect(f[0].text).toContain("サブエージェント");
    // 古い subagent 記録は対象外
    expect(checkSessionConsistency([{ ...base, state: "done" }], deps({ subagentMtimeMs: () => T - 10 * 60_000 }))).toEqual([]);
  });

  it("登録簿に居ないセッションは warn（他の判定はしない）", () => {
    const f = checkSessionConsistency([base], deps({ liveness: () => "dead", turnEnd: () => "open" }));
    expect(f).toHaveLength(1);
    expect(f[0].level).toBe("warn");
  });

  it("実行中のままターンが終わって時間が経っていれば warn", () => {
    const stale: DiagSession = { ...base, state: "running", lastEventAt: T - 10 * 60_000 };
    expect(checkSessionConsistency([stale], deps())[0].level).toBe("warn");
    // 直後はまだ掃引待ちなので挙げない
    expect(checkSessionConsistency([{ ...stale, lastEventAt: T - 60_000 }], deps())).toEqual([]);
  });

  it("切断表示なのに transcript が動いていれば NG。整合していれば何も出ない", () => {
    expect(checkSessionConsistency([{ ...base, state: "disconnected" }], deps({ turnEnd: () => "open" }))[0].level).toBe("ng");
    expect(checkSessionConsistency([base], deps())).toEqual([]);
    expect(checkSessionConsistency([{ ...base, transcriptPath: undefined }], deps({ turnEnd: () => "open" }))).toEqual([]);
  });
});

describe("まとめの整形", () => {
  it("ng > warn > ok の順で全体判定する", () => {
    expect(overallLevel([{ name: "a", level: "ok", detail: "" }])).toBe("ok");
    expect(overallLevel([{ name: "a", level: "ok", detail: "" }, { name: "b", level: "warn", detail: "" }])).toBe("warn");
    expect(overallLevel([{ name: "a", level: "warn", detail: "" }, { name: "b", level: "ng", detail: "" }])).toBe("ng");
    expect(overallLevel([])).toBe("ok");
  });

  it("1 行の体裁と件数の並べ方", () => {
    expect(formatCheck({ name: "Jev", level: "ok", detail: "応答 261ms" })).toBe("OK   Jev: 応答 261ms");
    expect(formatCounts({ Stop: 32, UserPromptSubmit: 40, Notification: 29 })).toBe("UserPromptSubmit 40 / Stop 32 / Notification 29");
    expect(formatCounts({ a: 1, b: 2, c: 3 }, 2)).toBe("c 3 / b 2");
    expect(formatCounts({})).toBe("なし");
  });
});
