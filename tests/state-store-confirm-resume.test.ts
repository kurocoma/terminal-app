/**
 * 確認待ち → 実行中の復帰（260904_1 #2）: StateStore.resumeFromConfirm / confirmSessions。
 * 掃引（liveness-monitor.findResumedFromConfirm）のヒットを適用する側の遷移規則を確認する。
 */
import { describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import { StateStore, type HookEvent } from "../src/main/state-store";

const projects: Project[] = [{ id: "p1", name: "app", path: "C:/dev/app", clickTarget: "cursor", registeredAt: "2026-09-04T00:00:00Z" }];

function evt(name: HookEvent["hook_event_name"], sessionId: string, extra: Partial<HookEvent> = {}): HookEvent {
  return { hook_event_name: name, session_id: sessionId, cwd: "C:/dev/app", ...extra };
}

function storeAt(start = 1_000_000) {
  let now = start;
  const store = new StateStore(() => now);
  return { store, tick: (ms: number) => { now += ms; } };
}

describe("confirmSessions", () => {
  it("確認待ちのセッションだけを transcript パスと確認待ち時刻付きで返す（終了済みは除く）", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("Notification", "c1", { transcript_path: "C:/t/c1.jsonl", message: "Claude needs your permission" }), projects);
    tick(10);
    store.applyEvent(evt("UserPromptSubmit", "r1"), projects);
    store.applyEvent(evt("Notification", "c2"), projects);
    store.setDead("c2", true);
    expect(store.confirmSessions()).toEqual([{ sessionId: "c1", projectId: "p1", transcriptPath: "C:/t/c1.jsonl", lastEventAt: 1_000_000, kind: "permission" }]);
  });
});

describe("resumeFromConfirm", () => {
  it("確認待ち → 実行中。経過時間の起点と最終イベント時刻は検知時刻", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("Notification", "c1"), projects);
    tick(20_000);
    expect(store.resumeFromConfirm("c1")).toBe(true);
    const v = store.displaySessions(projects)["p1"];
    expect(v.state).toBe("running");
    expect(v.runningSince).toBe(1_020_000);
    expect(v.lastEventAt).toBe(1_020_000);
  });

  it("確認待ち以外（完了・実行中）や未知セッションには適用しない", () => {
    const { store } = storeAt();
    store.applyEvent(evt("Stop", "d1"), projects);
    store.applyEvent(evt("UserPromptSubmit", "r1"), projects);
    expect(store.resumeFromConfirm("d1")).toBe(false);
    expect(store.resumeFromConfirm("r1")).toBe(false);
    expect(store.resumeFromConfirm("zzz")).toBe(false);
  });

  it("復帰後に再び Notification が来れば確認待ちに戻り、Stop で完了になる（通常の遷移が壊れない）", () => {
    const { store } = storeAt();
    store.applyEvent(evt("Notification", "c1"), projects);
    store.resumeFromConfirm("c1");
    store.applyEvent(evt("Notification", "c1"), projects);
    expect(store.displaySessions(projects)["p1"].state).toBe("confirm");
    store.applyEvent(evt("Stop", "c1"), projects);
    expect(store.displaySessions(projects)["p1"].state).toBe("done");
  });
});
