/**
 * 260908_1: 作業継続中の保持（heldReason）— liveness-monitor 側。
 * 呼び出し側（index.ts）が「品質ループ進行中」「バックグラウンド作業の完了待ち」と判定したセッションは、
 * (a) 終了検知・切断検知の対象外、(b) 完了・切断から実行中へ戻す、(c) 許可要求以外の確認待ちから実行中へ戻す。
 * heldReason を渡さなければ従来どおり（既存テストの互換）。
 */
import { describe, expect, it } from "vitest";
import {
  CONCLUDED_MIN_AGE_MS,
  CONFIRM_RESUME_MIN_AGE_MS,
  STOPPED_RESUME_MIN_AGE_MS,
  TRANSCRIPT_STALE_HARD_MS,
  findConcluded,
  findDisconnected,
  findResumedFromConfirm,
  findResumedFromStopped,
  type ConfirmTarget,
  type StoppedTarget,
  type SweepTarget,
} from "../src/main/liveness-monitor";

const T0 = 1_000_000;
const HELD = "ループ進行中（ループ 1/4・codex 実装中 12分）";
const heldOnly = (id: string) => (sid: string) => (sid === id ? HELD : undefined);

describe("findResumedFromStopped: 保持中の完了・切断は猶予を待たず実行中へ戻す", () => {
  const target = (id: string, state: StoppedTarget["state"] = "done"): StoppedTarget => ({ sessionId: id, projectId: "p1", state, transcriptPath: `C:/t/${id}.jsonl`, lastEventAt: T0 });
  const base = {
    now: () => T0 + 100, // Stop 直後（STOPPED_RESUME_MIN_AGE_MS 未満）
    registryStatus: () => "idle",
    turnEnd: () => "concluded" as const,
    blockedStop: () => null,
    activityMtimeMs: () => null,
  };

  it("held → reason=held（理由付き）。保持されていないセッションは従来判定（Stop 直後は判定しない）", () => {
    const hits = findResumedFromStopped([target("a"), target("b", "disconnected"), target("c")], { ...base, heldReason: heldOnly("b") });
    expect(hits).toEqual([{ target: target("b", "disconnected"), reason: "held", heldReason: HELD }]);
    expect(findResumedFromStopped([target("a")], base)).toEqual([]);
    expect(findResumedFromStopped([target("a")], { ...base, now: () => T0 + STOPPED_RESUME_MIN_AGE_MS, registryStatus: () => "busy", turnEnd: () => "open" })).toMatchObject([{ reason: "registry" }]);
  });
});

describe("findResumedFromConfirm: 保持中は許可要求以外の確認待ちを実行中へ戻す", () => {
  const target = (id: string, kind?: ConfirmTarget["kind"]): ConfirmTarget => ({ sessionId: id, projectId: "p1", transcriptPath: `C:/t/${id}.jsonl`, lastEventAt: T0, kind });
  const base = { now: () => T0 + 100, mtimeMs: () => null, registryStatus: () => "idle" };

  it("idle / other / 種別不明の確認待ち → held（通知直後でも戻す）。permission は人が応えるまで戻さない", () => {
    const held = () => HELD;
    expect(findResumedFromConfirm([target("a", "idle")], { ...base, heldReason: held })).toEqual([{ target: target("a", "idle"), reason: "held", heldReason: HELD }]);
    expect(findResumedFromConfirm([target("b", "other")], { ...base, heldReason: held })).toMatchObject([{ reason: "held" }]);
    expect(findResumedFromConfirm([target("c")], { ...base, heldReason: held })).toMatchObject([{ reason: "held" }]);
    expect(findResumedFromConfirm([target("d", "permission")], { ...base, heldReason: held })).toEqual([]);
  });

  it("permission でも従来の根拠（猶予後の登録簿 busy／transcript 更新）では戻る。保持なしの idle は従来どおり猶予内は戻さない", () => {
    const later = { ...base, now: () => T0 + CONFIRM_RESUME_MIN_AGE_MS, registryStatus: () => "busy", heldReason: () => HELD };
    expect(findResumedFromConfirm([target("d", "permission")], later)).toMatchObject([{ reason: "registry" }]);
    expect(findResumedFromConfirm([target("a", "idle")], base)).toEqual([]);
  });
});

describe("findConcluded / findDisconnected: 保持中は終了検知・切断検知の対象外", () => {
  const target = (id: string): SweepTarget => ({ sessionId: id, projectId: "p1", transcriptPath: `C:/t/${id}.jsonl` });

  it("findConcluded: transcript がターン完了でも held なら完了にしない（Monitor 起床のたびにターンが閉じるため）", () => {
    const deps = { now: () => T0 + CONCLUDED_MIN_AGE_MS + 1, mtimeMs: () => T0, turnEnd: () => "concluded" as const };
    expect(findConcluded([target("a"), target("b")], { ...deps, heldReason: heldOnly("a") })).toEqual([target("b")]);
    expect(findConcluded([target("a"), target("b")], deps)).toEqual([target("a"), target("b")]);
  });

  it("findDisconnected: transcript が HARD 閾値を超えて止まっていても held なら切断しない", () => {
    const deps = { now: () => T0 + TRANSCRIPT_STALE_HARD_MS + 1, mtimeMs: () => T0, windowPresent: () => false, registryStatus: () => undefined };
    expect(findDisconnected([target("a"), target("b")], { ...deps, heldReason: heldOnly("a") })).toEqual([target("b")]);
    expect(findDisconnected([target("a"), target("b")], deps)).toEqual([target("a"), target("b")]);
  });
});
