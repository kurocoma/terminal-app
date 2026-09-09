/**
 * 260909_1: SessionStart hook → 同じプロジェクトの「終了済み」「切断」の記録を消してタイルを待機へ戻す。
 * 2026-09-09 実測: Claude Code を再起動した後、前のセッションの「切断・8 分前」が最初のプロンプトまで残った。
 */
import { describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import { ACCEPTED_EVENT_NAMES, mapEventToState, StateStore, validateEvent, type HookEvent } from "../src/main/state-store";

function project(id: string, p: string): Project {
  return { id, name: p.split("\\").pop() ?? p, path: p, clickTarget: "cursor", registeredAt: "2026-09-09T00:00:00Z" };
}

const projects = [project("p1", "C:\\dev\\instagram-app"), project("p2", "C:\\dev\\other")];

function evt(name: HookEvent["hook_event_name"], sessionId: string, extra: Partial<HookEvent> = {}): HookEvent {
  return { hook_event_name: name, session_id: sessionId, cwd: "C:\\dev\\instagram-app", transcript_path: `C:/t/${sessionId}.jsonl`, ...extra };
}

describe("SessionStart の受理", () => {
  it("validateEvent が受理し source を保持する。mapEventToState は null（状態を作らない）", () => {
    expect(ACCEPTED_EVENT_NAMES).toContain("SessionStart");
    const r = validateEvent({ hook_event_name: "SessionStart", session_id: "new1", cwd: "C:\\dev\\instagram-app", source: "startup" });
    expect(r.ok && r.event.source).toBe("startup");
    expect(mapEventToState(evt("SessionStart", "new1"))).toBe(null);
  });
});

describe("applyEvent(SessionStart)", () => {
  it("同じプロジェクトの切断・終了済みの記録を消し、待機へ戻す。生存中の実行中・完了には触れない", () => {
    const store = new StateStore(() => 1_000_000);
    store.applyEvent(evt("UserPromptSubmit", "old1", { prompt: "a" }), projects);
    store.markDisconnected("old1"); // 切断
    store.applyEvent(evt("Stop", "old2"), projects);
    store.setDead("old2", true); // 終了済み（登録簿にプロセスなし）
    store.applyEvent(evt("Stop", "alive"), projects); // 完了・生存
    store.applyEvent(evt("UserPromptSubmit", "run", { prompt: "b" }), projects); // 実行中・生存
    store.applyEvent(evt("UserPromptSubmit", "p2s", { prompt: "c", cwd: "C:\\dev\\other" }), projects);
    store.markDisconnected("p2s"); // 別プロジェクトの切断（対象外）

    const r = store.applyEvent(evt("SessionStart", "new1", { source: "startup" }), projects);
    expect(r).toEqual({ projectId: "p1", sessionId: "new1", state: "waiting", prunedSessions: ["old1", "old2"] });
    expect(store.sessionIds().sort()).toEqual(["alive", "p2s", "run"]);
    expect(store.displaySessions(projects).p1.sessionId).toBe("run"); // 実行中優先は従来どおり
    expect(store.displaySessions(projects).p2.state).toBe("disconnected");
  });

  it("消すものが無ければ何もしない（表示は作らない）。同じ session_id の古い記録（resume）は消す", () => {
    const store = new StateStore(() => 1_000_000);
    expect(store.applyEvent(evt("SessionStart", "s1", { source: "startup" }), projects)).toEqual({ projectId: "p1", sessionId: "s1", state: "waiting", prunedSessions: [] });
    expect(store.displaySessions(projects).p1).toBeUndefined();
    store.applyEvent(evt("Stop", "s1"), projects);
    expect(store.applyEvent(evt("SessionStart", "s1", { source: "resume" }), projects)?.prunedSessions).toEqual(["s1"]);
    expect(store.sessionIds()).toEqual([]);
  });

  it("未登録 cwd は従来どおり破棄（null）", () => {
    const store = new StateStore(() => 1_000_000);
    expect(store.applyEvent(evt("SessionStart", "s1", { cwd: "C:\\elsewhere" }), projects)).toBe(null);
  });
});
