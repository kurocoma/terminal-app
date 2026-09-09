/**
 * 260908_1: 作業継続中の保持 — StateStore 側。
 * - UserPromptSubmit の prompt が `<task-notification>`（Monitor / バックグラウンド Bash の通知による自動起床。
 *   2026-09-08 実測: transcript の origin.kind="task-notification"）なら作業テキストを上書きせず backgroundDriven を立てる
 * - applyEvent の holdRunning: Stop / Notification を「完了」「確認待ち」にせず実行中を保つ
 * - Notification の種別（confirmKind）を確認待ち一覧に載せる／cwd を保持しループ探索の材料にする
 */
import { describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import { classifyNotification, isTaskNotificationPrompt, StateStore, validateEvent, type HookEvent } from "../src/main/state-store";

function project(id: string, p: string): Project {
  return { id, name: p.split("\\").pop() ?? p, path: p, clickTarget: "cursor", registeredAt: "2026-09-08T00:00:00Z" };
}

const projects = [project("p1", "C:\\dev\\Pricefluctuation-app")];

function evt(name: HookEvent["hook_event_name"], sessionId: string, extra: Partial<HookEvent> = {}): HookEvent {
  return { hook_event_name: name, session_id: sessionId, cwd: "C:\\dev\\Pricefluctuation-app", transcript_path: `C:/t/${sessionId}.jsonl`, ...extra };
}

const TASK_NOTIFICATION =
  '<task-notification>\n<task-id>bnompbcuf</task-id>\n<summary>Monitor event: "実行係 codex の進捗 (iter 000, effort xhigh)"</summary>\n<event>[17:16:03 +8m00s] generator#000 run : "npm test"</event>\n</task-notification>';

function storeAt(): { store: StateStore; tick: (ms: number) => void } {
  let t = 1_000_000;
  const store = new StateStore(() => t);
  return { store, tick: (ms) => (t += ms) };
}

describe("isTaskNotificationPrompt", () => {
  it("先頭（空白許容）が <task-notification> のときだけ true", () => {
    expect(isTaskNotificationPrompt(TASK_NOTIFICATION)).toBe(true);
    expect(isTaskNotificationPrompt("  \n<task-notification>x")).toBe(true);
    expect(isTaskNotificationPrompt("動いてる？")).toBe(false);
    expect(isTaskNotificationPrompt("<command-name>/foo</command-name>")).toBe(false);
    expect(isTaskNotificationPrompt(undefined)).toBe(false);
  });
});

describe("classifyNotification（260908_2: 公式 notification_type を優先）", () => {
  it("permission_prompt / elicitation_* / agent_needs_input → permission、idle_prompt → idle、他 → other。文言は見ない", () => {
    expect(classifyNotification("Claude is waiting for your input", "permission_prompt")).toBe("permission");
    expect(classifyNotification("x", "elicitation_dialog")).toBe("permission");
    expect(classifyNotification("x", "elicitation_url_dialog")).toBe("permission");
    expect(classifyNotification("x", "agent_needs_input")).toBe("permission");
    expect(classifyNotification("Claude needs your permission", "idle_prompt")).toBe("idle");
    expect(classifyNotification("x", "auth_success")).toBe("other");
    expect(classifyNotification("x", "agent_completed")).toBe("other");
    expect(classifyNotification("x", "quota_auto_resume_fired")).toBe("other");
  });

  it("notification_type が無い・空なら従来どおり message の文言で推定する", () => {
    expect(classifyNotification("Claude needs your permission to use Bash")).toBe("permission");
    expect(classifyNotification("Claude is waiting for your input", "")).toBe("idle");
    expect(classifyNotification("something")).toBe("other");
    expect(classifyNotification(undefined)).toBe("other");
  });

  it("validateEvent は notification_type を保持し、applyEvent の確認待ち種別に反映する", () => {
    const r = validateEvent({ hook_event_name: "Notification", session_id: "s1", cwd: "C:\\dev\\Pricefluctuation-app", message: "Claude is waiting for your input", notification_type: "agent_needs_input" });
    expect(r.ok && r.event.notification_type).toBe("agent_needs_input");
    const { store } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "x" }), projects);
    store.applyEvent(evt("Notification", "s1", { message: "Claude is waiting for your input", notification_type: "agent_needs_input" }), projects);
    expect(store.confirmSessions()).toMatchObject([{ sessionId: "s1", kind: "permission" }]);
  });
});

describe("task-notification による起床", () => {
  it("実行中にはなるが作業テキストは人の依頼文のまま。backgroundDriven が立ち、人のプロンプトで解除される", () => {
    const { store } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "ホットキー設定機能を品質ループで実装して" }), projects);
    store.applyEvent(evt("Stop", "s1"), projects);
    const r = store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: TASK_NOTIFICATION }), projects);
    expect(r?.state).toBe("running");
    expect(store.displaySessions(projects).p1.workText).toBe("ホットキー設定機能を品質ループで実装して");
    expect(store.isBackgroundDriven("s1")).toBe(true);
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "動いてる？" }), projects);
    expect(store.displaySessions(projects).p1.workText).toBe("動いてる？");
    expect(store.isBackgroundDriven("s1")).toBe(false);
    expect(store.isBackgroundDriven("unknown")).toBe(false);
  });

  it("最初のイベントが task-notification でも（作業テキスト無しで）実行中になる", () => {
    const { store } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: TASK_NOTIFICATION }), projects);
    const v = store.displaySessions(projects).p1;
    expect(v.state).toBe("running");
    expect(v.workText).toBeUndefined();
  });
});

describe("applyEvent の holdRunning（作業継続中の保持）", () => {
  it("Stop を holdRunning で受けると完了にならず実行中のまま（経過時間の起点も維持）。transcript パスは更新される", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "作業" }), projects);
    const since = store.displaySessions(projects).p1.runningSince;
    tick(30_000);
    const r = store.applyEvent(evt("Stop", "s1", { transcript_path: "C:/t/new.jsonl" }), projects, { holdRunning: true });
    expect(r).toMatchObject({ state: "running", sessionId: "s1" });
    const v = store.displaySessions(projects).p1;
    expect(v.state).toBe("running");
    expect(v.runningSince).toBe(since);
    expect(store.transcriptPathOf("s1")).toBe("C:/t/new.jsonl");
    expect(store.runningSessions().map((t) => t.sessionId)).toEqual(["s1"]);
  });

  it("Notification（入力待ち）を holdRunning で受けると確認待ちにならない。holdRunning 無しなら従来どおり確認待ち＋種別", () => {
    const { store } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "作業" }), projects);
    const held = store.applyEvent(evt("Notification", "s1", { message: "Claude is waiting for your input" }), projects, { holdRunning: true });
    expect(held?.state).toBe("running");
    expect(store.confirmSessions()).toEqual([]);
    const r = store.applyEvent(evt("Notification", "s1", { message: "Claude needs your permission to use Bash" }), projects);
    expect(r?.state).toBe("confirm");
    expect(store.confirmSessions()).toMatchObject([{ sessionId: "s1", kind: "permission" }]);
    store.applyEvent(evt("Notification", "s1", { message: "Claude is waiting for your input" }), projects);
    expect(store.confirmSessions()).toMatchObject([{ sessionId: "s1", kind: "idle" }]);
  });

  it("holdRunning は UserPromptSubmit / SessionEnd の遷移を変えない（正常終了は従来どおり破棄・エラーはエラー）", () => {
    const { store } = storeAt();
    expect(store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "x" }), projects, { holdRunning: true })?.state).toBe("running");
    expect(store.applyEvent(evt("SessionEnd", "s1", { reason: "other" }), projects, { holdRunning: true })?.state).toBe("error");
    expect(store.applyEvent(evt("SessionEnd", "s1", { reason: "exit" }), projects, { holdRunning: true })).toBe(null);
  });
});

describe("loopLookupSessions（ループ state の探索材料）", () => {
  it("生存セッションの id・cwd（hook payload）・プロジェクトのパスを返す。終了済みは含めない", () => {
    const { store } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "x", cwd: "C:\\dev\\Pricefluctuation-app\\packages\\web" }), projects);
    store.applyEvent(evt("UserPromptSubmit", "s2", { prompt: "y" }), projects);
    store.setDead("s2", true);
    expect(store.loopLookupSessions(projects)).toEqual([
      { sessionId: "s1", cwd: "C:\\dev\\Pricefluctuation-app\\packages\\web", projectPath: "C:\\dev\\Pricefluctuation-app" },
    ]);
  });

  it("再接続復元だけのセッションは cwd 無し（プロジェクトのパスだけ）", () => {
    const { store } = storeAt();
    store.reviveSession({ sessionId: "s3", projectId: "p1", lastEventAt: 1_000_000, transcriptPath: "C:/t/s3.jsonl", turnEnd: "open" });
    expect(store.loopLookupSessions(projects)).toEqual([{ sessionId: "s3", cwd: undefined, projectPath: "C:\\dev\\Pricefluctuation-app" }]);
  });
});
