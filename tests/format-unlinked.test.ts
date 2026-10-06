/**
 * 未接続タイル（260903_1）の表示判定・ラベル整形（renderer 側の純関数。format.ts）。
 * 規則: 対象アプリのウィンドウが無く（present === false）、かつ実行中・確認待ちでもないタイルを
 * 「未接続」として灰色表示・非表示の対象にする。判定不能（undefined）は未接続にしない（安全側）。
 */
import { describe, expect, it } from "vitest";
import { fmtUnlinkedLabel, isUnlinked } from "../src/renderer/format";

describe("isUnlinked（260903_1）", () => {
  it("ウィンドウ無し＋セッション無し（待機）は未接続", () => {
    expect(isUnlinked(false, undefined)).toBe(true);
    expect(isUnlinked(false, "waiting")).toBe(true);
  });

  it("ウィンドウ無しでも完了・エラー・切断は未接続（もう手を動かしていない）", () => {
    expect(isUnlinked(false, "done")).toBe(true);
    expect(isUnlinked(false, "error")).toBe(true);
    expect(isUnlinked(false, "disconnected")).toBe(true);
  });

  it("実行中・確認待ちはウィンドウが見つからなくても未接続にしない（タイトル一致の偽陰性で作業中タイルを隠さない）", () => {
    expect(isUnlinked(false, "running")).toBe(false);
    expect(isUnlinked(false, "confirm")).toBe(false);
  });

  it("ウィンドウあり・判定不能（undefined）は状態によらず未接続にしない", () => {
    expect(isUnlinked(true, undefined)).toBe(false);
    expect(isUnlinked(true, "done")).toBe(false);
    expect(isUnlinked(undefined, undefined)).toBe(false);
    expect(isUnlinked(undefined, "done")).toBe(false);
  });

  it("開いている Codex の完了・エラーは Cursor のウィンドウが無くても灰色化・非表示にしない", () => {
    expect(isUnlinked(false, "done", "codex")).toBe(false);
    expect(isUnlinked(false, "error", "codex")).toBe(false);
    expect(isUnlinked(false, "done", "codex", false)).toBe(false);
  });

  it("終了を確認した Codex の履歴は、ウィンドウが無ければ Claude と同じく未接続（260929_1）", () => {
    expect(isUnlinked(false, "done", "codex", true)).toBe(true);
    expect(isUnlinked(false, "error", "codex", true)).toBe(true);
    expect(isUnlinked(false, "disconnected", "codex", true)).toBe(true);
    expect(isUnlinked(true, "done", "codex", true)).toBe(false);
    expect(isUnlinked(undefined, "done", "codex", true)).toBe(false);
  });

  it("Claude と既存セッションの未接続判定は変えない", () => {
    expect(isUnlinked(false, "done", "claude")).toBe(true);
    expect(isUnlinked(false, "done", undefined)).toBe(true);
  });
});

describe("fmtUnlinkedLabel（260903_1）", () => {
  it("件数付きのトグルラベルを返す", () => {
    expect(fmtUnlinkedLabel(3)).toBe("未接続を表示（3）");
    expect(fmtUnlinkedLabel(0)).toBe("未接続を表示（0）");
  });
});
