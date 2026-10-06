import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { CODEX_RECENT_MS, CODEX_STALE_RUNNING_MS, readCodexSessions } from "../src/main/codex-session-reader";

const NOW = Date.UTC(2026, 8, 25, 7);
let codexHome: string;
let state: DatabaseSync;
let history: DatabaseSync;

beforeEach(() => {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-app-codex-reader-"));
  state = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  history = new DatabaseSync(path.join(codexHome, "thread_history_1.sqlite"));
  state.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, cwd TEXT, source TEXT, archived INTEGER,
    created_at INTEGER, updated_at INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER,
    name TEXT, title TEXT
  )`);
  history.exec(`CREATE TABLE thread_turns (
    thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT,
    started_at INTEGER, completed_at INTEGER
  );
  CREATE INDEX turns_page ON thread_turns(thread_id, rollout_ordinal);
  CREATE TABLE thread_items (
    thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER,
    item_type TEXT, item_json TEXT
  );
  CREATE INDEX items_page ON thread_items(thread_id, turn_id, rollout_ordinal)`);
});

afterEach(() => {
  state.close();
  history.close();
  // このテストが生成した tmp 配下のディレクトリだけを除去する。
  if (path.dirname(path.resolve(codexHome)) === path.resolve(os.tmpdir()) && path.basename(codexHome).startsWith("terminal-app-codex-reader-")) {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

interface ThreadOptions {
  id?: string;
  source?: string;
  archived?: number;
  updatedAt?: number;
  createdAt?: number;
  name?: string | null;
  title?: string;
}

function thread(options: ThreadOptions = {}): string {
  const id = options.id ?? "thread-1";
  const createdAt = options.createdAt ?? NOW - 2 * 60 * 60_000;
  const updatedAt = options.updatedAt ?? NOW - 1000;
  state.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, "C:\\dev\\test-project", options.source ?? "cli", options.archived ?? 0,
    Math.floor(createdAt / 1000), Math.floor(updatedAt / 1000), createdAt, updatedAt,
    options.name ?? null, options.title ?? "Codex の状態表示"
  );
  return id;
}

function turn(status: string, options: { threadId?: string; turnId?: string; ordinal?: number; startedAt?: number; completedAt?: number } = {}): void {
  history.prepare("INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?)").run(
    options.threadId ?? "thread-1", options.turnId ?? "turn-1", options.ordinal ?? 1, status,
    Math.floor((options.startedAt ?? NOW - 60_000) / 1000),
    options.completedAt === undefined ? null : Math.floor(options.completedAt / 1000)
  );
}

function item(type: string, ordinal: number, body: Record<string, unknown>, turnId = "turn-1"): void {
  history.prepare("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?)").run(
    "thread-1", turnId, `item-${ordinal}`, ordinal, type, JSON.stringify({ type, ...body })
  );
}

const read = () => readCodexSessions({ codexHome, now: NOW });

describe("Codex ローカル履歴の読み取り", () => {
  it("CLI / Desktop の最新ターンを採用し、表示用テキストと実際の開始時刻を返す", () => {
    thread({ name: "表示名", source: "vscode" });
    turn("completed", { ordinal: 1, turnId: "old-turn", completedAt: NOW - 120_000 });
    turn("inProgress", { ordinal: 10, startedAt: NOW - 60_000 });
    item("userMessage", 11, { content: [{ type: "text", text: "現在の\n  タスクを確認" }] });
    expect(read()).toEqual({
      available: true,
      sessions: [{
        sessionId: "thread-1", cwd: "C:\\dev\\test-project", state: "running",
        firstSeenAt: NOW - 2 * 60 * 60_000, lastEventAt: NOW - 1000,
        runningSince: NOW - 60_000, taskTitle: "表示名", workText: "現在の タスクを確認",
      }],
    });
  });

  it.each([
    ["inProgress", "running"], ["completed", "done"], ["interrupted", "done"], ["failed", "error"],
  ])("ターン status=%s を %s に対応付ける", (status, expected) => {
    thread();
    turn(status);
    expect(read().sessions[0]?.state).toBe(expected);
    if (expected !== "running") expect(read().sessions[0]?.runningSince).toBeUndefined();
  });

  it("最新ターンの未知の状態を実行中と見なさず、古い既知ターンへ戻さない", () => {
    thread();
    turn("inProgress");
    turn("futureStatus", { turnId: "new-turn", ordinal: 2 });
    expect(read()).toEqual({ available: true, sessions: [] });
  });

  it("子エージェント・exec・mcp・アーカイブ・24 時間より古い履歴を表示しない", () => {
    const entries: ThreadOptions[] = [
      { id: "child", source: '{"subagent":{"thread_spawn":{"parent_thread_id":"root"}}}' },
      { id: "exec", source: "exec" }, { id: "mcp", source: "mcp" },
      { id: "archive", archived: 1 }, { id: "old", updatedAt: NOW - CODEX_RECENT_MS - 1 },
    ];
    for (const entry of entries) turn("inProgress", { threadId: thread(entry) });
    expect(read()).toEqual({ available: true, sessions: [] });
  });

  it("30 分以上更新が無い未完了ターンは切断表示にする", () => {
    const staleAt = NOW - CODEX_STALE_RUNNING_MS - 1;
    thread({ updatedAt: staleAt });
    turn("inProgress", { startedAt: staleAt - 60_000 });
    expect(read().sessions[0]).toMatchObject({ state: "disconnected", lastEventAt: staleAt });
    expect(read().sessions[0]?.runningSince).toBeUndefined();
  });

  it("ミリ秒列が未記録なら秒列へ戻し、完了時刻を最終時刻として扱う", () => {
    thread();
    state.exec("UPDATE threads SET created_at_ms = NULL, updated_at_ms = NULL");
    turn("completed", { completedAt: NOW });
    expect(read().sessions[0]).toMatchObject({ firstSeenAt: NOW - 2 * 60 * 60_000, lastEventAt: NOW, state: "done" });
  });

  it.each(["inProgress", "completed"])("%s の明示質問は後続ツールが完了していても回答待ち", (status) => {
    thread();
    turn(status);
    item("userMessage", 2, { content: [{ type: "text", text: "設定して" }] });
    item("agentMessage", 3, { questions: [{ title: "表示する対象", options: ["CLI", "Desktop"] }], delivery: "async" });
    item("commandExecution", 4, { status: "completed", aggregatedOutput: "output" });
    item("agentMessage", 5, { text: "調査を続けます", questions: null });
    expect(read().sessions[0]).toMatchObject({ state: "confirm", confirmKind: "question" });
    expect(read().sessions[0]?.runningSince).toBeUndefined();
  });

  it("質問後のユーザー回答で確認待ちを解除する", () => {
    thread();
    turn("inProgress");
    item("agentMessage", 2, { questions: [{ title: "対象", options: null }] });
    item("userMessage", 3, { content: [{ type: "text", text: "両方" }] });
    expect(read().sessions[0]).toMatchObject({ state: "running", workText: "両方" });
    expect(read().sessions[0]?.confirmKind).toBeUndefined();
  });

  it("選択肢を省略した自由入力の構造化質問も回答待ちにする", () => {
    thread();
    turn("inProgress");
    item("agentMessage", 2, { questions: [{ title: "必要な設定を教えてください" }] });
    expect(read().sessions[0]).toMatchObject({ state: "confirm", confirmKind: "question" });
  });

  it("前ターンの質問や中断済み質問を確認待ちとして残さない", () => {
    thread();
    turn("completed", { turnId: "old-turn" });
    item("agentMessage", 2, { questions: [{ title: "前の質問", options: null }] }, "old-turn");
    turn("interrupted", { ordinal: 3 });
    item("agentMessage", 4, { questions: [{ title: "中断された質問", options: null }] });
    expect(read().sessions[0]).toMatchObject({ state: "done" });
    expect(read().sessions[0]?.confirmKind).toBeUndefined();
  });

  it("質問文らしい通常テキストや未完了コマンドから確認待ちを推測しない", () => {
    thread();
    turn("inProgress");
    item("agentMessage", 2, { text: "実行しますか？", questions: [] });
    item("commandExecution", 3, { status: "inProgress" });
    expect(read().sessions[0]).toMatchObject({ state: "running" });
    expect(read().sessions[0]?.confirmKind).toBeUndefined();
  });

  it("壊れた item JSON は無視し、本文で状態を失わない", () => {
    thread();
    turn("completed");
    history.prepare("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?)").run("thread-1", "turn-1", "broken", 2, "agentMessage", "{broken");
    expect(read().sessions[0]?.state).toBe("done");
  });

  it("読み取りで既存 DB の内容と更新日時を変えない", () => {
    thread();
    turn("inProgress");
    const files = ["state_5.sqlite", "thread_history_1.sqlite"].map((name) => path.join(codexHome, name));
    const before = files.map((file) => ({ content: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs }));
    expect(read().available).toBe(true);
    for (const [i, file] of files.entries()) {
      expect(fs.readFileSync(file)).toEqual(before[i].content);
      expect(fs.statSync(file).mtimeMs).toBe(before[i].mtime);
    }
  });

  it("未導入なら空で返し、DB やディレクトリを作らない", () => {
    const absent = path.join(codexHome, "absent");
    expect(readCodexSessions({ codexHome: absent, now: NOW })).toEqual({ available: false, sessions: [] });
    expect(fs.existsSync(absent)).toBe(false);
  });

  it("スキーマ非互換は固定の診断にし、アプリを止めない", () => {
    history.exec("DROP TABLE thread_turns");
    expect(read()).toEqual({ available: false, sessions: [], error: "Codex のローカル履歴を読み込めません（使用中または未対応の形式）" });
  });
});
