/**
 * 分割タイル（260904_1 #3）: 同じプロジェクトで生きているセッションが 2 本以上あるときだけ
 * splitSessions に一覧（起動順）が載り、終了済み（dead）は外れる。生死は登録簿（session-registry）由来で
 * setDead / pruneDeadSessions から反映される。件数は表示タイル基準（countTiles）。
 * （パス区切りはフォワードスラッシュ表記。normalizePath が区切りを同一視するため等価）
 */
import { describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import { countTiles, StateStore, type HookEvent } from "../src/main/state-store";

function project(id: string, p: string): Project {
  return { id, name: p.split("/").pop() ?? p, path: p, clickTarget: "cursor", registeredAt: "2026-09-04T00:00:00Z" };
}
const projects = [project("p1", "C:/dev/dev"), project("p2", "C:/dev/other")];

function evt(name: HookEvent["hook_event_name"], sessionId: string, cwd = "C:/dev/dev", extra: Partial<HookEvent> = {}): HookEvent {
  return { hook_event_name: name, session_id: sessionId, cwd, ...extra };
}

/** 時刻を進められるストア */
function storeAt(start = 1_000_000) {
  let now = start;
  const store = new StateStore(() => now);
  return { store, tick: (ms: number) => { now += ms; } };
}

describe("splitSessions（260904_1 #3）", () => {
  it("同じプロジェクトで 2 本が生きていれば起動順（firstSeenAt 昇順）で載る。1 本のプロジェクトは載らない", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s-second-name-but-first"), projects); // ターミナル 1（先に起動）
    tick(1_000);
    store.applyEvent(evt("UserPromptSubmit", "s-a"), projects); // ターミナル 2
    tick(1_000);
    store.applyEvent(evt("Stop", "s-second-name-but-first"), projects); // 1 が完了（最終イベントは 1 の方が新しい）
    store.applyEvent(evt("Notification", "s-other", "C:/dev/other"), projects); // p2 は 1 本

    const split = store.splitSessions(projects);
    expect(Object.keys(split)).toEqual(["p1"]);
    expect(split["p1"].map((s) => [s.sessionId, s.state])).toEqual([
      ["s-second-name-but-first", "done"],
      ["s-a", "running"],
    ]);
    // 従来の 1 タイル表示（displaySessions）は実行中優先のまま
    expect(store.displaySessions(projects)["p1"].sessionId).toBe("s-a");
  });

  it("終了済み（setDead）のセッションは分割から外れ、1 本になれば分割自体が解ける", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("Stop", "s1"), projects);
    tick(10);
    store.applyEvent(evt("Stop", "s2"), projects);
    expect(store.splitSessions(projects)["p1"]).toHaveLength(2);

    expect(store.setDead("s1", true)).toBe(true);
    expect(store.setDead("s1", true)).toBe(false); // 変化なし
    expect(store.splitSessions(projects)).toEqual({});
    // 表示選定は生存を優先（最終イベントが新しい s2 でもあるが、dead の s1 より s2）
    expect(store.displaySessions(projects)["p1"].sessionId).toBe("s2");

    expect(store.setDead("s1", false)).toBe(true);
    expect(store.splitSessions(projects)["p1"]).toHaveLength(2);
  });

  it("表示選定: 終了済みの方が最終イベントが新しくても生存セッションを表示する", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("Notification", "s-alive"), projects); // 確認待ち（古い）
    tick(60_000);
    store.applyEvent(evt("Stop", "s-dead"), projects); // 完了（新しい）
    store.setDead("s-dead", true);
    expect(store.displaySessions(projects)["p1"].sessionId).toBe("s-alive");
    // 生存セッション同士は従来規則（実行中優先 → 最終イベント優先）
    store.setDead("s-dead", false);
    expect(store.displaySessions(projects)["p1"].sessionId).toBe("s-dead");
  });

  it("終了したターミナルの履歴だけに終了印を付け、生存確認やイベント復帰で外す", () => {
    const { store } = storeAt();
    store.applyEvent(evt("Stop", "s1"), projects);
    expect(store.displaySessions(projects)["p1"]).not.toHaveProperty("terminalClosed");

    store.setDead("s1", true);
    expect(store.displaySessions(projects)["p1"].terminalClosed).toBe(true);
    expect(store.exportSessions()).toEqual([]);

    store.setDead("s1", false);
    expect(store.displaySessions(projects)["p1"]).not.toHaveProperty("terminalClosed");
    store.setDead("s1", true);
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    expect(store.displaySessions(projects)["p1"]).not.toHaveProperty("terminalClosed");
    expect(store.exportSessions()[0]).not.toHaveProperty("terminalClosed");
  });

  it("終了済みビューをシードしても生存扱いや保存対象に戻さず、復帰後は終了印を残さない", () => {
    const { store } = storeAt();
    store.seedSession({ sessionId: "s1", projectId: "p1", state: "done", lastEventAt: 100, terminalClosed: true });
    expect(store.displaySessions(projects)["p1"].terminalClosed).toBe(true);
    expect(store.exportSessions()).toEqual([]);

    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    expect(store.displaySessions(projects)["p1"]).not.toHaveProperty("terminalClosed");
    const restored = new StateStore();
    restored.importSessions(store.exportSessions());
    expect(restored.displaySessions(projects)["p1"]).not.toHaveProperty("terminalClosed");
  });

  it("切断（disconnected）は分割の対象外。復帰イベントが届けば dead が解けて再び対象になる", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1", "C:/dev/dev", { transcript_path: "C:/t/s1.jsonl" }), projects);
    tick(10);
    store.applyEvent(evt("UserPromptSubmit", "s2"), projects);
    store.markDisconnected("s1");
    expect(store.splitSessions(projects)).toEqual({});

    store.setDead("s2", true);
    store.applyEvent(evt("UserPromptSubmit", "s2"), projects); // イベント到着 = 生きている
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects); // 切断からの復帰
    expect(store.splitSessions(projects)["p1"].map((s) => s.sessionId)).toEqual(["s1", "s2"]);
  });

  it("正常 SessionEnd を受けた完了セッションは終了済みになり分割から外れる（表示は従来どおり残る）", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("Stop", "s1"), projects);
    tick(10);
    store.applyEvent(evt("Stop", "s2"), projects);
    expect(store.applyEvent(evt("SessionEnd", "s2", "C:/dev/dev", { reason: "prompt_input_exit" }), projects)).toBe(null);
    expect(store.splitSessions(projects)).toEqual({});
    expect(store.displaySessions(projects)["p1"].sessionId).toBe("s1"); // 生存を優先
    store.removeSession("s1");
    expect(store.displaySessions(projects)["p1"]).toEqual(expect.objectContaining({ sessionId: "s2", state: "done" }));
  });

  it("登録解除済みプロジェクトは分割一覧に載らない", () => {
    const { store } = storeAt();
    store.applyEvent(evt("Stop", "s1"), projects);
    store.applyEvent(evt("Stop", "s2"), projects);
    expect(store.splitSessions([project("p2", "C:/dev/other")])).toEqual({});
  });
});

describe("pruneDeadSessions / removeSession", () => {
  it("生存セッションのあるプロジェクトの終了済み記録だけ破棄し、生存が無いプロジェクトの終了済みは残す", () => {
    const { store } = storeAt();
    store.applyEvent(evt("Stop", "s1"), projects);
    store.applyEvent(evt("Stop", "s2"), projects);
    store.applyEvent(evt("Stop", "s3", "C:/dev/other"), projects);
    store.setDead("s1", true);
    store.setDead("s3", true);
    expect(store.pruneDeadSessions()).toEqual(["s1"]);
    expect(store.sessionIds().sort()).toEqual(["s2", "s3"]);
    expect(store.displaySessions(projects)["p2"].state).toBe("done"); // 「完了・N分前」の表示は残る
    expect(store.pruneDeadSessions()).toEqual([]);
  });

  it("removeSession は 1 件だけ消し、未知 ID は false", () => {
    const { store } = storeAt();
    store.applyEvent(evt("Stop", "s1"), projects);
    store.applyEvent(evt("Stop", "s2"), projects);
    expect(store.removeSession("s1")).toBe(true);
    expect(store.removeSession("s1")).toBe(false);
    expect(store.sessionIds()).toEqual(["s2"]);
  });
});

describe("countTiles（表示タイル基準の件数）", () => {
  it("分割タイルはそれぞれ数える。従来の counts（プロジェクトごと）は変わらない", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    tick(10);
    store.applyEvent(evt("Notification", "s2"), projects);
    store.applyEvent(evt("Notification", "s3", "C:/dev/other"), projects);
    const split = store.splitSessions(projects);
    const display = store.displaySessions(projects);
    const tiles = projects.flatMap((p) => split[p.id] ?? (display[p.id] !== undefined ? [display[p.id]] : []));
    expect(countTiles(tiles)).toEqual({ running: 1, done: 0, confirm: 2, error: 0, total: 3 });
    expect(store.counts(projects)).toEqual({ running: 1, done: 0, confirm: 1, error: 0, total: 2 });
  });

  it("切断は disconnected キーで数え、0 件のときはキー自体を付けない", () => {
    expect(countTiles([{ sessionId: "a", projectId: "p", state: "disconnected", lastEventAt: 0 }])).toEqual({
      running: 0, done: 0, confirm: 0, error: 0, disconnected: 1, total: 1,
    });
    expect(countTiles([])).toEqual({ running: 0, done: 0, confirm: 0, error: 0, total: 0 });
  });
});

describe("firstSeenAt（並び順の起点）", () => {
  it("最初のイベント時刻で固定され、後続イベントで動かない。配信ビューにも載る", () => {
    const { store, tick } = storeAt(5_000);
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    tick(30_000);
    store.applyEvent(evt("Stop", "s1"), projects);
    expect(store.displaySessions(projects)["p1"].firstSeenAt).toBe(5_000);
  });

  it("再接続（reviveSession）で復元したセッションは transcript の更新時刻を起点にする", () => {
    const { store } = storeAt();
    store.reviveSession({ sessionId: "r1", projectId: "p1", lastEventAt: 777, transcriptPath: "C:/t/r1.jsonl", turnEnd: "concluded" });
    expect(store.displaySessions(projects)["p1"].firstSeenAt).toBe(777);
  });
});
