/**
 * Codex のローカル履歴を読み取り専用で監視する。
 * 対象は対話 CLI / Cursor・Desktop（source=cli / vscode）。exec と子エージェントの履歴は除外する。
 * 本文はタイルの作業テキスト用に短く取り出すだけで、ログ・外部サービスには渡さない。
 */
import * as fs from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import type { SessionState } from "../shared/types";
import { extractWorkText } from "./state-store";

export const CODEX_RECENT_MS = 24 * 60 * 60_000;
/** DB にはプロセスの生存記録が無い。更新が止まった未完了ターンを永続的に実行中にはしない。 */
export const CODEX_STALE_RUNNING_MS = 30 * 60_000;

export interface CodexSessionRecord {
  sessionId: string;
  cwd: string;
  state: SessionState;
  lastEventAt: number;
  firstSeenAt: number;
  runningSince?: number;
  taskTitle?: string;
  workText?: string;
  confirmKind?: "permission" | "question";
}

export interface CodexReadResult {
  available: boolean;
  sessions: CodexSessionRecord[];
  error?: string;
}

export interface CodexReadOptions {
  codexHome: string;
  now?: number;
}

type Row = Record<string, unknown>;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function milliseconds(millis: unknown, seconds: unknown): number | undefined {
  return finiteNumber(millis) ?? (finiteNumber(seconds) === undefined ? undefined : (seconds as number) * 1000);
}

function shortText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text === "" ? undefined : text.slice(0, limit);
}

/** questions は実データの明示質問。通常の返答文やツールの inProgress から確認待ちを推測しない。 */
function hasQuestions(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const questions: unknown = JSON.parse(value);
    return Array.isArray(questions) && questions.some((question: unknown) => {
      if (question === null || typeof question !== "object") return false;
      const q = question as Record<string, unknown>;
      return typeof q.title === "string" && q.title.trim() !== "" &&
        (q.options === undefined || q.options === null || Array.isArray(q.options));
    });
  } catch {
    return false;
  }
}

function stateOf(status: unknown): SessionState | undefined {
  switch (status) {
    case "inProgress": return "running";
    case "completed":
    case "interrupted": return "done";
    case "failed": return "error";
    default: return undefined;
  }
}

/**
 * DB 未導入・更新中・スキーマ非互換でもアプリを止めない。
 * readOnly は両 DB で必須。PRAGMA journal_mode 等の変更や、ファイルの新規作成はしない。
 */
export function readCodexSessions(options: CodexReadOptions): CodexReadResult {
  const statePath = path.join(options.codexHome, "state_5.sqlite");
  const historyPath = path.join(options.codexHome, "thread_history_1.sqlite");
  if (!fs.existsSync(statePath) || !fs.existsSync(historyPath)) return { available: false, sessions: [] };

  const now = options.now ?? Date.now();
  let stateDb: DatabaseSync | undefined;
  let historyDb: DatabaseSync | undefined;
  try {
    stateDb = new DatabaseSync(statePath, { readOnly: true });
    historyDb = new DatabaseSync(historyPath, { readOnly: true });
    const threads = stateDb.prepare(`
      SELECT id, cwd, source, created_at, updated_at, created_at_ms, updated_at_ms, name, title
      FROM threads
      WHERE archived = 0 AND source IN ('cli', 'vscode')
        AND COALESCE(updated_at_ms, updated_at * 1000) >= ?
      ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC
    `).all(now - CODEX_RECENT_MS);
    const latestTurn = historyDb.prepare(`
      SELECT turn_id, status, started_at, completed_at
      FROM thread_turns WHERE thread_id = ?
      ORDER BY rollout_ordinal DESC LIMIT 1
    `);
    // 状態と本文を分けて読む。巨大な tool output や他ターンの履歴は取り出さない。
    const latestUser = historyDb.prepare(`
      SELECT rollout_ordinal,
        CASE WHEN json_valid(item_json) THEN
          substr(json_extract(item_json, '$.content[0].text'), 1, 2000)
        END AS text
      FROM thread_items
      WHERE thread_id = ? AND turn_id = ? AND item_type = 'userMessage'
      ORDER BY rollout_ordinal DESC LIMIT 1
    `);
    const questionItems = historyDb.prepare(`
      SELECT CASE WHEN json_valid(item_json) THEN json_extract(item_json, '$.questions') END AS questions
      FROM thread_items
      WHERE thread_id = ? AND turn_id = ? AND item_type = 'agentMessage' AND rollout_ordinal > ?
      ORDER BY rollout_ordinal DESC
    `);

    const sessions: CodexSessionRecord[] = [];
    for (const thread of threads) {
      if (typeof thread.id !== "string" || thread.id === "" || typeof thread.cwd !== "string" || thread.cwd.trim() === "") continue;
      const turn = latestTurn.get(thread.id) as Row | undefined;
      if (turn === undefined || typeof turn.turn_id !== "string") continue;
      let state = stateOf(turn.status);
      if (state === undefined) continue; // 新しい未知の状態を「実行中」とは見なさない
      const updated = milliseconds(thread.updated_at_ms, thread.updated_at);
      if (updated === undefined) continue;
      const completed = milliseconds(undefined, turn.completed_at);
      const started = milliseconds(undefined, turn.started_at);
      const lastEventAt = Math.max(updated, completed ?? 0, started ?? 0);
      const firstSeenAt = milliseconds(thread.created_at_ms, thread.created_at) ?? started ?? lastEventAt;
      const user = latestUser.get(thread.id, turn.turn_id) as Row | undefined;
      const canWaitForAnswer = turn.status === "inProgress" || turn.status === "completed";
      // 非同期質問の後でツールが動いても回答済みとはしない。後続 userMessage だけが質問を解除する。
      const pendingQuestion = canWaitForAnswer && questionItems
        .all(thread.id, turn.turn_id, finiteNumber(user?.rollout_ordinal) ?? -1)
        .some((item) => hasQuestions(item.questions));
      if (pendingQuestion) state = "confirm";
      else if (state === "running" && now - lastEventAt > CODEX_STALE_RUNNING_MS) state = "disconnected";

      const record: CodexSessionRecord = {
        sessionId: thread.id,
        cwd: thread.cwd,
        state,
        lastEventAt,
        firstSeenAt,
      };
      if (state === "running") record.runningSince = started ?? lastEventAt;
      if (pendingQuestion) record.confirmKind = "question";
      const title = shortText(thread.name, 160) ?? shortText(thread.title, 160);
      if (title !== undefined) record.taskTitle = title;
      const workText = extractWorkText(typeof user?.text === "string" ? user.text : undefined);
      if (workText !== undefined) record.workText = workText;
      sessions.push(record);
    }
    return { available: true, sessions };
  } catch {
    // SQL エラーに由来する入力や本文をログへ持ち出さないため、固定の診断だけを返す。
    return { available: false, sessions: [], error: "Codex のローカル履歴を読み込めません（使用中または未対応の形式）" };
  } finally {
    try { historyDb?.close(); } catch { /* 次の掃引で再接続する */ }
    try { stateDb?.close(); } catch { /* 次の掃引で再接続する */ }
  }
}
