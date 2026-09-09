/**
 * 260907_1: 完了・切断 → 実行中の復帰判定（findResumedFromStopped）と、登録簿 busy 中の切断抑止。
 *
 * 認識合わせ: 「ループ中に codex や fork が動いているのにタイルが完了・切断のまま」を、
 * (R1) 登録簿 status=busy（＋transcript 終端が concluded でない）
 * (R2) transcript の block 痕跡（stop_hook_summary.preventedContinuation=true）
 * (R3) 切断後の transcript／subagent 記録の更新
 * のいずれかで「実行中」へ戻す。(R4) busy のセッションは transcript が止まっていても切断にしない。
 */
import { describe, expect, it } from "vitest";
import {
  BLOCKED_STOP_MARGIN_MS,
  STOPPED_RESUME_MIN_AGE_MS,
  TRANSCRIPT_STALE_HARD_MS,
  findDisconnected,
  findResumedFromStopped,
  type StoppedTarget,
} from "../src/main/liveness-monitor";

const T0 = 1_000_000;
const REASON = "[Eval-loop iteration 2/4 | RESUME 1/3] Continue now.";

function target(id: string, state: StoppedTarget["state"] = "done", lastEventAt = T0, transcriptPath: string | undefined = `C:/t/${id}.jsonl`): StoppedTarget {
  return { sessionId: id, projectId: "p1", state, transcriptPath, lastEventAt };
}

function deps(opts: {
  now?: number;
  status?: Record<string, string>;
  turnEnd?: Record<string, "concluded" | "open" | "unknown">;
  blocked?: Record<string, { at: number; reason: string }>;
  activity?: Record<string, number | null>;
}) {
  return {
    now: () => opts.now ?? T0 + 60_000,
    registryStatus: (sid: string) => opts.status?.[sid],
    turnEnd: (p: string) => opts.turnEnd?.[p] ?? "unknown",
    blockedStop: (p: string, sinceMs: number) => {
      const b = opts.blocked?.[p];
      return b !== undefined && b.at >= sinceMs ? b : null;
    },
    activityMtimeMs: (p: string) => opts.activity?.[p] ?? null,
  };
}

describe("定数", () => {
  it("Stop 後の猶予 3 秒・block 痕跡の許容ずれ 2 秒", () => {
    expect(STOPPED_RESUME_MIN_AGE_MS).toBe(3_000);
    expect(BLOCKED_STOP_MARGIN_MS).toBe(2_000);
  });
});

describe("findResumedFromStopped — R1 登録簿 status=busy", () => {
  it("busy かつ transcript 終端が open → 復帰（reason=registry）", () => {
    const t = target("s1");
    expect(findResumedFromStopped([t], deps({ status: { s1: "busy" }, turnEnd: { "C:/t/s1.jsonl": "open" } }))).toEqual([{ target: t, reason: "registry" }]);
  });

  it("busy かつ終端 unknown（判定材料なし）→ 復帰。busy かつ transcript パス不明 → 復帰", () => {
    const a = target("a");
    const b = target("b", "done", T0, undefined);
    expect(findResumedFromStopped([a, b], deps({ status: { a: "busy", b: "busy" } })).map((h) => h.target.sessionId)).toEqual(["a", "b"]);
  });

  it("busy でも transcript 終端が concluded なら復帰しない（busy が古いまま残る事故への保険）", () => {
    expect(findResumedFromStopped([target("s1")], deps({ status: { s1: "busy" }, turnEnd: { "C:/t/s1.jsonl": "concluded" } }))).toEqual([]);
  });

  it("idle / waiting / 登録簿なし は根拠にならない", () => {
    const d = deps({ status: { i: "idle", w: "waiting" }, turnEnd: { "C:/t/i.jsonl": "open", "C:/t/w.jsonl": "open", "C:/t/n.jsonl": "open" } });
    expect(findResumedFromStopped([target("i"), target("w"), target("n")], d)).toEqual([]);
  });

  it("最終イベント（Stop）から MIN_AGE 未満は判定しない（登録簿が idle へ切り替わる猶予）", () => {
    const early = deps({ now: T0 + STOPPED_RESUME_MIN_AGE_MS - 1, status: { s1: "busy" } });
    expect(findResumedFromStopped([target("s1")], early)).toEqual([]);
    const onTime = deps({ now: T0 + STOPPED_RESUME_MIN_AGE_MS, status: { s1: "busy" } });
    expect(findResumedFromStopped([target("s1")], onTime)).toHaveLength(1);
  });

  it("切断中のセッションにも同じ規則（busy → 復帰）", () => {
    const t = target("s1", "disconnected");
    expect(findResumedFromStopped([t], deps({ status: { s1: "busy" } }))).toEqual([{ target: t, reason: "registry" }]);
  });
});

describe("findResumedFromStopped — R2 block された Stop の痕跡", () => {
  it("最終イベント−許容ずれ 以降の block があれば復帰（reason=blocked-stop、理由文付き）", () => {
    const t = target("s1");
    const hits = findResumedFromStopped([t], deps({ blocked: { "C:/t/s1.jsonl": { at: T0 - BLOCKED_STOP_MARGIN_MS, reason: REASON } } }));
    expect(hits).toEqual([{ target: t, reason: "blocked-stop", blockReason: REASON }]);
  });

  it("許容ずれより古い block は復帰しない（前のターンの痕跡）", () => {
    expect(findResumedFromStopped([target("s1")], deps({ blocked: { "C:/t/s1.jsonl": { at: T0 - BLOCKED_STOP_MARGIN_MS - 1, reason: REASON } } }))).toEqual([]);
  });

  it("登録簿 busy と block の両方が成立するときは registry を理由にし、1 件だけ返す", () => {
    const hits = findResumedFromStopped([target("s1")], deps({ status: { s1: "busy" }, blocked: { "C:/t/s1.jsonl": { at: T0, reason: REASON } } }));
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toBe("registry");
  });

  it("登録簿が busy でなくても block 痕跡だけで復帰する（Cursor 起動 = status 無し）", () => {
    const hits = findResumedFromStopped([target("s1")], deps({ status: { s1: "idle" }, blocked: { "C:/t/s1.jsonl": { at: T0 + 100, reason: REASON } } }));
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toBe("blocked-stop");
  });
});

describe("findResumedFromStopped — R3 切断後の更新", () => {
  it("切断中に transcript（本体または subagent）が切断判定より後に更新 → 復帰（reason=transcript）", () => {
    const t = target("s1", "disconnected");
    expect(findResumedFromStopped([t], deps({ activity: { "C:/t/s1.jsonl": T0 + 1 } }))).toEqual([{ target: t, reason: "transcript" }]);
  });

  it("切断判定と同時刻以前の更新・取得不可は復帰しない", () => {
    expect(findResumedFromStopped([target("s1", "disconnected")], deps({ activity: { "C:/t/s1.jsonl": T0 } }))).toEqual([]);
    expect(findResumedFromStopped([target("s1", "disconnected")], deps({ activity: { "C:/t/s1.jsonl": null } }))).toEqual([]);
  });

  it("完了（done）は更新だけでは復帰しない（Stop 後にも stop_hook_summary 等が書かれるため）", () => {
    expect(findResumedFromStopped([target("s1", "done")], deps({ activity: { "C:/t/s1.jsonl": T0 + 60_000 } }))).toEqual([]);
  });

  it("transcript パス不明のセッションは登録簿以外の根拠を使えない", () => {
    expect(findResumedFromStopped([target("s1", "disconnected", T0, undefined)], deps({ activity: {} }))).toEqual([]);
  });
});

describe("findResumedFromStopped — 混在", () => {
  it("条件を満たすものだけを対象順に返す", () => {
    const a = target("a"); // busy
    const b = target("b"); // 何も無し
    const c = target("c", "disconnected"); // 更新あり
    const d = target("d"); // block
    const hits = findResumedFromStopped(
      [a, b, c, d],
      deps({ status: { a: "busy" }, activity: { "C:/t/c.jsonl": T0 + 5 }, blocked: { "C:/t/d.jsonl": { at: T0, reason: REASON } } })
    );
    expect(hits.map((h) => `${h.target.sessionId}:${h.reason}`)).toEqual(["a:registry", "c:transcript", "d:blocked-stop"]);
  });
});

describe("findDisconnected — R4 登録簿 busy は切断しない", () => {
  const sweepTarget = { sessionId: "s1", projectId: "p1", transcriptPath: "C:/t/s1.jsonl" };
  const stale = { now: () => T0 + TRANSCRIPT_STALE_HARD_MS + 1, mtimeMs: () => T0, windowPresent: () => false };

  it("HARD 閾値を超えていても status=busy なら切断しない", () => {
    expect(findDisconnected([sweepTarget], { ...stale, registryStatus: () => "busy" })).toEqual([]);
  });

  it("status が未取得（undefined）・waiting なら従来どおり切断する。idle は生きて入力待ちなので切断しない（260909_1）", () => {
    expect(findDisconnected([sweepTarget], { ...stale, registryStatus: () => undefined })).toEqual([sweepTarget]);
    expect(findDisconnected([sweepTarget], { ...stale, registryStatus: () => "waiting" })).toEqual([sweepTarget]);
    expect(findDisconnected([sweepTarget], { ...stale, registryStatus: () => "idle" })).toEqual([]);
  });

  it("registryStatus を渡さない呼び出し（従来の deps）も従来どおり", () => {
    expect(findDisconnected([sweepTarget], stale)).toEqual([sweepTarget]);
  });
});
