/**
 * 指示の履歴（261005_3）: ユーザーが送った指示だけを新しい順に取り出す。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { claudeInstructionsFrom, cleanInstruction, codexInstructionsOf, mergeInstructions } from "../src/main/instructions";

describe("Claude の transcript から", () => {
  const user = (content: unknown, extra: Record<string, unknown> = {}, ts = "2026-10-05T07:00:00.000Z"): Record<string, unknown> =>
    ({ type: "user", timestamp: ts, message: { role: "user", content }, ...extra });

  it("ユーザーの指示だけを新しい順に返し、ツール結果・メタ・サブエージェント・要約・中断表示・システム枠は除く", () => {
    const records = [ // 新しい順
      user("最新の指示", {}, "2026-10-05T07:05:00.000Z"),
      user([{ type: "tool_result", tool_use_id: "x", content: "ok" }]),
      { type: "assistant", message: { content: [{ type: "text", text: "返答" }] } },
      user("<system-reminder>差し込み</system-reminder>"),
      user("メタ", { isMeta: true }),
      user("子エージェント", { isSidechain: true }),
      user("要約", { isCompactSummary: true }),
      user("[Request interrupted by user]"),
      user([{ type: "text", text: "<task-notification>完了</task-notification>\n貼り付けの後の指示" }], {}, "2026-10-05T07:01:00.000Z"),
      user("古い指示", {}, "2026-10-05T06:00:00.000Z"),
    ];
    const out = claudeInstructionsFrom(records, 5);
    expect(out.map((i) => i.text)).toEqual(["最新の指示", "貼り付けの後の指示", "古い指示"]);
    expect(out[0].at).toBe(Date.parse("2026-10-05T07:05:00.000Z"));
    expect(claudeInstructionsFrom(records, 1)).toHaveLength(1);
  });

  it("整形: 行末の空白と 3 行以上の空行を詰め、長い指示は省略する", () => {
    expect(cleanInstruction("a  \n\n\n\nb")).toBe("a\n\nb");
    expect(cleanInstruction("   ")).toBeNull();
    expect(cleanInstruction("x".repeat(700))).toHaveLength(601);
  });
});

describe("Codex の履歴 DB から", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("userMessage だけを新しい順に返す（他スレッド・他の種類は含めない）。DB が無ければ null", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-instr-"));
    const db = new DatabaseSync(path.join(dir, "thread_history_1.sqlite"));
    db.exec("CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, created_at_ms INTEGER, item_json TEXT, item_type TEXT)");
    const add = db.prepare("INSERT INTO thread_items VALUES (?, 't', ?, ?, ?, ?)");
    const msg = (text: string) => JSON.stringify({ type: "userMessage", content: [{ type: "text", text }] });
    add.run("th", 1, 1000, msg("一つ目"), "userMessage");
    add.run("th", 2, 2000, JSON.stringify({ text: "返答" }), "agentMessage");
    add.run("th", 3, 3000, msg("二つ目"), "userMessage");
    add.run("other", 4, 4000, msg("別スレッド"), "userMessage");
    db.close();
    expect(codexInstructionsOf(dir, "th")).toEqual([{ text: "二つ目", at: 3000 }, { text: "一つ目", at: 1000 }]);
    expect(codexInstructionsOf(path.join(dir, "absent"), "th")).toBeNull();
  });

  it("複数の保存先の結果は重複を除いて時刻順に統合する", () => {
    const merged = mergeInstructions([[{ text: "a", at: 1 }, { text: "c", at: 3 }], [{ text: "c", at: 3 }, { text: "b", at: 2 }]]);
    expect(merged.map((i) => i.text)).toEqual(["c", "b", "a"]);
  });
});
