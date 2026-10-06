/**
 * Orca 連携（261005_1）の純関数部分: CLI 出力の解釈・状態ファイルの読み取り・切替先ターミナルの選定・
 * Orca の窓とフォルダ一覧による接続判定・CLI / Codex 保存先の解決。CLI は呼ばない。
 */
import * as path from "path";
import { describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import {
  isTruncated,
  orcaSleepingPathSet,
  orcaCodexHome,
  orcaWorktreePathSet,
  parseCliOutput,
  parsePaneKeysBySession,
  parseTerminals,
  parseWorktrees,
  pickOrcaTerminal,
  resolveOrcaCli,
  type OrcaTerminal,
  type OrcaWorktree,
} from "../src/main/orca";
import { hasWindowFor } from "../src/main/window-control";
import { computeWindowPresence } from "../src/main/window-presence";
import { resolveLaunchCommand } from "../src/main/app-launcher";

const term = (handle: string, worktreePath: string, tabId: string, leafId: string, agentIdentity?: string): OrcaTerminal =>
  ({ handle, worktreePath, tabId, leafId, agentIdentity });

describe("CLI 出力の解釈", () => {
  it("ok:true は result を返し、ok:false は error.code だけを返す（本文をメッセージに含めない）", () => {
    expect(parseCliOutput(JSON.stringify({ ok: true, result: { a: 1 } }))).toEqual({ ok: true, result: { a: 1 } });
    const failed = parseCliOutput(JSON.stringify({ ok: false, error: { code: "selector_not_found", message: "x", data: { secret: "s" } } }));
    expect(failed).toMatchObject({ ok: false, code: "selector_not_found" });
    expect(JSON.stringify(failed)).not.toContain("secret");
    expect(parseCliOutput("not json")).toMatchObject({ ok: false, code: "invalid_output" });
  });

  it("スリープ中 = 登録済みで生きているターミナルが 0 のフォルダ（件数不明の版は含めない。261005_4）", () => {
    const worktrees = parseWorktrees({
      worktrees: [
        { path: "C:/dev/awake", liveTerminalCount: 2, agents: [] },
        { path: "C:/dev/asleep", liveTerminalCount: 0, agents: [] },
        { path: "C:/dev/unknown", agents: [] },
      ],
    });
    expect([...orcaSleepingPathSet(worktrees)]).toEqual(["c:\\dev\\asleep"]);
  });

  it("一覧の打ち切り（truncated）を検知する", () => {
    expect(isTruncated({ worktrees: [], truncated: true })).toBe(true);
    expect(isTruncated({ worktrees: [], truncated: false })).toBe(false);
    expect(isTruncated(undefined)).toBe(false);
  });

  it("terminal list: 切断・孤立・必須項目の欠けたものは除く", () => {
    const terminals = parseTerminals({
      terminals: [
        { handle: "term_a", worktreePath: "C:/dev/app", tabId: "t1", leafId: "l1", connected: true, agentIdentity: "claude", preview: "..." },
        { handle: "term_b", worktreePath: "C:/dev/app", tabId: "t2", leafId: "l2", connected: false },
        { handle: "term_c", worktreePath: "C:/dev/app", tabId: "t3", leafId: "l3", orphaned: true },
        { handle: "term_d", worktreePath: "C:/dev/app", tabId: "t4" },
      ],
    });
    expect(terminals).toEqual([term("term_a", "C:/dev/app", "t1", "l1", "claude")]);
    expect(parseTerminals(null)).toEqual([]);
  });

  it("worktree ps: path とエージェント（paneKey・state）を取り出し、アーカイブ済みは除く", () => {
    const worktrees = parseWorktrees({
      worktrees: [
        { path: "C:/dev/app", liveTerminalCount: 2, agents: [{ paneKey: "t1:l1", state: "waiting", agentType: "claude", updatedAt: 5, prompt: "p" }, { state: "working" }] },
        { path: "C:/dev/old", isArchived: true, agents: [] },
        { path: "C:/dev/idle", liveTerminalCount: 0, agents: [] },
        { path: "C:/dev" },
      ],
    });
    expect(worktrees).toEqual([
      { path: "C:/dev/app", liveTerminals: 2, agents: [{ paneKey: "t1:l1", state: "waiting", agentType: "claude", updatedAt: 5 }] },
      { path: "C:/dev/idle", liveTerminals: 0, agents: [] },
      { path: "C:/dev", agents: [] },
    ]);
    // ターミナルの無いフォルダ（サイドバーに居るだけ）は接続扱いにしない。件数不明の版はフォルダがあれば含める
    expect([...orcaWorktreePathSet(worktrees)]).toEqual(["c:\\dev\\app", "c:\\dev"]);
  });
});

describe("Orca の状態ファイル（session → paneKey）", () => {
  it("providerSession.id と paneKey だけを対応付ける。壊れた内容は空", () => {
    const json = JSON.stringify({
      version: 2,
      entries: {
        "t1:l1": { paneKey: "t1:l1", providerSession: { id: "claude-1" }, payload: { prompt: "x" } },
        "t2:l2": { paneKey: "t2:l2", providerSession: { id: "0199-codex" } },
        broken: { paneKey: "t3:l3" },
      },
    });
    expect([...parsePaneKeysBySession(json)]).toEqual([["claude-1", "t1:l1"], ["0199-codex", "t2:l2"]]);
    expect(parsePaneKeysBySession("{").size).toBe(0);
    expect(parsePaneKeysBySession(JSON.stringify({ entries: [] })).size).toBe(0);
  });
});

describe("切替先ターミナルの選定", () => {
  const terminals = [
    term("h-other", "C:/dev/other", "t9", "l9", "claude"),
    term("h-shell", "C:/dev/app", "t1", "l1"),
    term("h-claude-a", "C:/dev/app", "t1", "l2", "claude"),
    term("h-claude-b", "C:/dev/app", "t2", "l1", "claude"),
    term("h-codex", "C:/dev/app", "t3", "l1", "codex"),
  ];
  const worktrees: OrcaWorktree[] = [{
    path: "C:/dev/app",
    agents: [
      { paneKey: "t1:l2", state: "working", agentType: "claude", updatedAt: 10 },
      { paneKey: "t2:l1", state: "waiting", agentType: "claude", updatedAt: 5 },
      { paneKey: "t3:l1", state: "done", agentType: "codex", updatedAt: 20 },
    ],
  }];
  const pick = (hint?: Parameters<typeof pickOrcaTerminal>[0]["hint"], paneBySession = new Map<string, string>(), projectPath = "C:\\dev\\app") =>
    pickOrcaTerminal({ terminals, worktrees, paneBySession, projectPath, hint })?.handle;

  it("セッション ID から paneKey が引ければそのタブ（Codex の接頭辞は外して照合）", () => {
    expect(pick({ sessionId: "s-1" }, new Map([["s-1", "t2:l1"]]))).toBe("h-claude-b");
    expect(pick({ sessionId: "codex:thread-1", provider: "codex" }, new Map([["thread-1", "t3:l1"]]))).toBe("h-codex");
  });

  it("引けなければ同じ種類で状態が一致するエージェントのタブ（確認待ち → waiting）", () => {
    expect(pick({ sessionId: "unknown", provider: "claude", state: "confirm" })).toBe("h-claude-b");
    expect(pick({ provider: "claude", state: "running" })).toBe("h-claude-a");
  });

  it("状態が一致しなければ同じ種類で更新の新しいエージェント、エージェントが無ければ同じ種類のターミナル", () => {
    expect(pick({ provider: "claude", state: "done" })).toBe("h-claude-a");
    expect(pick({ provider: "codex", state: "running" })).toBe("h-codex");
    const noAgents = pickOrcaTerminal({ terminals, worktrees: [], paneBySession: new Map(), projectPath: "C:/dev/app", hint: { provider: "codex" } });
    expect(noAgents?.handle).toBe("h-codex");
  });

  it("git 管理外のフォルダ（worktreePath が空）は worktreeId で照合する（レビュー指摘）", () => {
    const folderTerms = parseTerminals({
      terminals: [{ handle: "h-folder", worktreePath: "", worktreeId: "folder:abc", tabId: "tf", leafId: "lf", agentIdentity: "claude" }],
    });
    expect(folderTerms).toHaveLength(1);
    const folderWts = parseWorktrees({ worktrees: [{ path: "C:/dev", worktreeId: "folder:abc", liveTerminalCount: 1, agents: [] }] });
    const picked = pickOrcaTerminal({ terminals: folderTerms, worktrees: folderWts, paneBySession: new Map(), projectPath: "C:\\dev" });
    expect(picked?.handle).toBe("h-folder");
    // 空パスのターミナルが別フォルダに紛れ込まない
    expect(pickOrcaTerminal({ terminals: folderTerms, worktrees: folderWts, paneBySession: new Map(), projectPath: "C:\\other" })).toBeNull();
  });

  it("フォルダのターミナルが無ければ null（大文字小文字・区切り文字の違いは同一視）", () => {
    expect(pick({ provider: "claude" }, new Map(), "C:/dev/none")).toBeUndefined();
    expect(pick(undefined, new Map(), "c:/DEV/OTHER/")).toBe("h-other");
  });
});

describe("Orca の窓と接続判定", () => {
  const proj = (id: string, dir: string, clickTarget: Project["clickTarget"]): Project =>
    ({ id, name: id, path: dir, clickTarget, registeredAt: "" });
  const orcaWindow = { title: "Orca", exe: "orca.exe" };

  it("Orca の窓はタイトルにフォルダ名が無くても見つかる（Cursor の窓では代用しない）", () => {
    expect(hasWindowFor("orca", "app", [orcaWindow])).toBe(true);
    expect(hasWindowFor("orca", "app", [{ title: "app - Cursor", exe: "cursor.exe" }])).toBe(false);
    expect(hasWindowFor("cursor", "app", [orcaWindow])).toBe(false);
  });

  it("Orca 対象は窓があり、Orca で開いているフォルダに含まれるときだけ接続あり", () => {
    const projects = [proj("in", "C:\\dev\\app", "orca"), proj("out", "C:\\dev\\other", "orca"), proj("cur", "C:\\dev\\app", "cursor")];
    const paths = new Set(["c:\\dev\\app"]);
    expect(computeWindowPresence(projects, [orcaWindow], paths)).toEqual({ in: true, out: false, cur: false });
    // フォルダ一覧を取れなかったときは窓の有無だけ（灰色にしない側）
    expect(computeWindowPresence(projects, [orcaWindow], null)).toEqual({ in: true, out: true, cur: false });
    // Orca が閉じていれば一覧に関係なく未接続
    expect(computeWindowPresence(projects, [], paths)).toEqual({ in: false, out: false, cur: false });
  });
});

describe("CLI・保存先の解決", () => {
  const LOCAL = "C:\\Users\\u\\AppData\\Local";
  const ROAMING = "C:\\Users\\u\\AppData\\Roaming";

  it("orca.exe は既定のインストール先 → PATH の順で探す", () => {
    const installed = path.join(LOCAL, "Programs", "orca", "resources", "bin", "orca.exe");
    expect(resolveOrcaCli({ env: { LOCALAPPDATA: LOCAL, PATH: "C:\\tools" }, exists: (p) => p === installed })).toBe(installed);
    const onPath = path.join("C:\\tools", "orca.exe");
    expect(resolveOrcaCli({ env: { LOCALAPPDATA: LOCAL, PATH: "C:\\tools" }, exists: (p) => p === onPath })).toBe(onPath);
    expect(resolveOrcaCli({ env: {}, exists: () => true })).toBeNull();
  });

  it("Orca 用の CODEX_HOME は存在するときだけ返す", () => {
    const home = path.join(ROAMING, "orca", "codex-runtime-home", "home");
    expect(orcaCodexHome({ env: { APPDATA: ROAMING }, exists: (p) => p === home })).toBe(home);
    expect(orcaCodexHome({ env: { APPDATA: ROAMING }, exists: () => false })).toBeNull();
  });

  it("Orca の立ち上げは exe 起動の対象にしない（wt.exe 等へ落ちない）", () => {
    expect(resolveLaunchCommand("orca", "C:\\dev\\app", { env: { LOCALAPPDATA: LOCAL }, exists: () => true })).toBeNull();
  });
});
