/**
 * Orca 連携の拡張（261005_2）の純関数部分: 画面の解釈・返信テキストの整形・送信先の正確な特定・
 * Codex の承認待ちの重ね合わせ。CLI は呼ばない。
 */
import { describe, expect, it } from "vitest";
import type { SessionView } from "../src/shared/types";
import {
  agentsByPane,
  applyOrcaCodexConfirm,
  findExactTerminal,
  findSendableTerminal,
  parsePaneKeysBySession,
  parseScreenLines,
  parseWorktrees,
  rawSessionId,
  sanitizeReplyText,
  type OrcaTerminal,
} from "../src/main/orca";

const term = (handle: string, tabId: string, leafId: string): OrcaTerminal => ({ handle, worktreePath: "C:/dev/app", tabId, leafId });

describe("画面の解釈", () => {
  it("行末の空白と末尾の空行を除き、末尾から指定行数を返す", () => {
    const result = { terminal: { tail: ["a  ", "b", "", "c\t", "", "  "] } };
    expect(parseScreenLines(result)).toEqual(["a", "b", "", "c"]);
    expect(parseScreenLines(result, 2)).toEqual(["", "c"]);
    expect(parseScreenLines({ terminal: { tail: "x" } })).toEqual([]);
    expect(parseScreenLines(null)).toEqual([]);
  });
});

describe("返信テキストの整形", () => {
  it("改行は空白にして 1 行にまとめ、制御文字（Esc 等）を除く。空は null", () => {
    expect(sanitizeReplyText("  はい\r\nお願いします  ")).toBe("はい お願いします");
    expect(sanitizeReplyText("a\x1b[2Jb\x03")).toBe("a[2Jb");
    expect(sanitizeReplyText(" \n ")).toBeNull();
    expect(sanitizeReplyText("x".repeat(5000))).toHaveLength(4000);
  });
});

describe("送信先の正確な特定", () => {
  const terminals = [term("h1", "t1", "l1"), term("h2", "t2", "l2")];
  it("セッション ID → paneKey が引けたターミナルだけを返す（Codex は接頭辞を外す）", () => {
    const panes = new Map([["claude-1", "t2:l2"], ["thread-1", "t1:l1"]]);
    expect(findExactTerminal(terminals, panes, "claude-1")?.handle).toBe("h2");
    expect(findExactTerminal(terminals, panes, "codex:thread-1")?.handle).toBe("h1");
  });

  it("引けない・ペインが既に無い・セッション未指定は null（推定で送らない）", () => {
    expect(findExactTerminal(terminals, new Map(), "claude-1")).toBeNull();
    expect(findExactTerminal(terminals, new Map([["claude-1", "t9:l9"]]), "claude-1")).toBeNull();
    expect(findExactTerminal(terminals, new Map([["", "t1:l1"]]), undefined)).toBeNull();
    expect(rawSessionId("codex:")).toBeUndefined();
  });
});

describe("送信してよいターミナル（レビュー指摘）", () => {
  const withAgent = (handle: string, tabId: string, leafId: string, agentIdentity?: string): OrcaTerminal =>
    ({ handle, worktreePath: "C:/dev/app", tabId, leafId, agentIdentity });

  it("エージェントが居なくなったペイン（素のシェル）や別種のエージェントには送らない", () => {
    const panes = new Map([["s1", "t1:l1"]]);
    expect(findSendableTerminal([withAgent("h1", "t1", "l1", "claude")], panes, "s1", "claude")?.handle).toBe("h1");
    expect(findSendableTerminal([withAgent("h1", "t1", "l1")], panes, "s1", "claude")).toBeNull();
    expect(findSendableTerminal([withAgent("h1", "t1", "l1", "codex")], panes, "s1", "claude")).toBeNull();
  });

  it("同じセッションが複数ペインに残れば最新の記録、同じペインを後から別セッションが使えば新しい方だけが持つ", () => {
    const json = JSON.stringify({
      entries: {
        a: { paneKey: "t1:l1", providerSession: { id: "old" }, receivedAt: 100 },
        b: { paneKey: "t2:l2", providerSession: { id: "resumed" }, receivedAt: 100 },
        c: { paneKey: "t3:l3", providerSession: { id: "resumed" }, receivedAt: 300 },
        d: { paneKey: "t1:l1", providerSession: { id: "new" }, receivedAt: 200 },
      },
    });
    const map = parsePaneKeysBySession(json);
    expect(map.get("resumed")).toBe("t3:l3");
    expect(map.get("new")).toBe("t1:l1");
    expect(map.has("old")).toBe(false);
  });

  it("終了（SessionEnd）を記録したペインは対応付けない", () => {
    const json = JSON.stringify({ entries: { a: { paneKey: "t1:l1", providerSession: { id: "s" }, hookEventName: "SessionEnd", receivedAt: 5 } } });
    expect(parsePaneKeysBySession(json).size).toBe(0);
  });
});

describe("Codex の承認待ち（Orca の状態で補う）", () => {
  const view = (sessionId: string, state: SessionView["state"], provider: SessionView["provider"] = "codex"): SessionView =>
    ({ sessionId, projectId: "p", provider, state, lastEventAt: 1, runningSince: 1 });
  const agents = agentsByPane(parseWorktrees({
    worktrees: [{
      path: "C:/dev/app",
      agents: [
        { paneKey: "t1:l1", state: "waiting", agentType: "codex", toolName: "shell" },
        { paneKey: "t2:l2", state: "blocked", agentType: "codex", toolName: "request_user_input" },
        { paneKey: "t3:l3", state: "working", agentType: "codex" },
        { paneKey: "t4:l4", state: "waiting", agentType: "claude" },
      ],
    }],
  }));
  const panes = new Map([["a", "t1:l1"], ["b", "t2:l2"], ["c", "t3:l3"], ["d", "t4:l4"]]);

  it("実行中の Codex で Orca が waiting / blocked なら確認待ち（質問系のツールは question）", () => {
    const out = applyOrcaCodexConfirm([view("codex:a", "running"), view("codex:b", "running")], panes, agents);
    expect(out[0]).toMatchObject({ state: "confirm", confirmKind: "permission" });
    expect(out[0].runningSince).toBeUndefined();
    expect(out[1]).toMatchObject({ state: "confirm", confirmKind: "question" });
  });

  it("Orca が working、対応が無い、完了済み、Claude のセッションは変えない", () => {
    const input = [view("codex:c", "running"), view("codex:x", "running"), view("codex:a", "done"), view("d", "running", "claude")];
    expect(applyOrcaCodexConfirm(input, panes, agents)).toEqual(input);
  });
});
