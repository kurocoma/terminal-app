/**
 * 指示の履歴（261005_3）: そのセッションでユーザーが送った指示を新しい順に取り出す。
 * 「何を指示したか忘れる」ため、タイルのプレビュー・Orca の返信パネルに出す。
 * - Claude: transcript（JSONL）の末尾から type=user のレコード。tool_result・メタ・サブエージェント・
 *   Claude Code が差し込む枠（system-reminder 等。stripSystemBlocks）は除く
 * - Codex: thread_history_1.sqlite の userMessage（読み取り専用で開く）
 * 指示の本文はログに残さない（表示のためだけに renderer へ渡す）
 */
import * as fs from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { tailRecords } from "./session-scan";
import { stripSystemBlocks } from "./state-store";

export interface Instruction {
  text: string;
  /** 送った時刻（epoch ms）。不明なら省略 */
  at?: number;
}

/** 表示する件数の既定値 */
export const INSTRUCTIONS_MAX = 5;
/** 1 件の最大文字数（長い指示は末尾を省略） */
export const INSTRUCTION_TEXT_MAX = 600;
/** Claude の transcript を読む量（ツール出力で膨らむため、作業テキスト用の 256KB より多く読む） */
const CLAUDE_TAIL_BYTES = 2 * 1024 * 1024;

/** 表示用に整える。システムの枠を除き、行ごとの余白と 3 行以上の空行を詰める。空なら null */
export function cleanInstruction(text: string): string | null {
  const cleaned = stripSystemBlocks(text)
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (cleaned === "" || /^\[Request interrupted by user/.test(cleaned)) return null;
  return cleaned.length > INSTRUCTION_TEXT_MAX ? `${cleaned.slice(0, INSTRUCTION_TEXT_MAX)}…` : cleaned;
}

function userTextOf(rec: Record<string, unknown>): string | null {
  const message = rec.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const blocks = content.filter((b): b is Record<string, unknown> => b !== null && typeof b === "object");
  // tool_result を含むレコードはツールの戻り値（ユーザーの指示ではない）
  if (blocks.some((b) => b.type === "tool_result")) return null;
  const texts = blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string);
  return texts.length === 0 ? null : texts.join("\n");
}

/** transcript のレコード（新しい順）から指示を最大 n 件（新しい順） */
export function claudeInstructionsFrom(recordsNewestFirst: ReadonlyArray<Record<string, unknown>>, n: number = INSTRUCTIONS_MAX): Instruction[] {
  const out: Instruction[] = [];
  for (const rec of recordsNewestFirst) {
    if (out.length >= n) break;
    if (rec.type !== "user" || rec.isMeta === true || rec.isSidechain === true || rec.isCompactSummary === true) continue;
    const raw = userTextOf(rec);
    const text = raw === null ? null : cleanInstruction(raw);
    if (text === null) continue;
    const at = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
    out.push(Number.isFinite(at) ? { text, at } : { text });
  }
  return out;
}

export function claudeInstructionsOf(transcriptPath: string, n: number = INSTRUCTIONS_MAX): Instruction[] {
  return claudeInstructionsFrom(tailRecords(transcriptPath, CLAUDE_TAIL_BYTES), n);
}

/** 複数の保存先から集めた指示を、重複（同じ時刻・同じ本文）を除いて新しい順に最大 n 件 */
export function mergeInstructions(lists: ReadonlyArray<readonly Instruction[]>, n: number = INSTRUCTIONS_MAX): Instruction[] {
  const seen = new Set<string>();
  const all: Instruction[] = [];
  for (const item of lists.flat()) {
    const key = `${item.at ?? ""}\u0000${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(item);
  }
  return all.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, n);
}

/** Codex の指示を最大 n 件（新しい順）。DB が無い・読めないときは null */
export function codexInstructionsOf(codexHome: string, threadId: string, n: number = INSTRUCTIONS_MAX): Instruction[] | null {
  const dbPath = path.join(codexHome, "thread_history_1.sqlite");
  if (!fs.existsSync(dbPath)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(`
      SELECT created_at_ms AS at,
        CASE WHEN json_valid(item_json) THEN substr(json_extract(item_json, '$.content[0].text'), 1, 4000) END AS text
      FROM thread_items
      WHERE thread_id = ? AND item_type = 'userMessage'
      ORDER BY rollout_ordinal DESC LIMIT ?
    `).all(threadId, n * 2) as Array<{ at: unknown; text: unknown }>;
    const out: Instruction[] = [];
    for (const row of rows) {
      if (out.length >= n || typeof row.text !== "string") continue;
      const text = cleanInstruction(row.text);
      if (text === null) continue;
      out.push(typeof row.at === "number" && row.at > 0 ? { text, at: row.at } : { text });
    }
    return out;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* 読み取り専用の後始末の失敗は無視 */ }
  }
}
