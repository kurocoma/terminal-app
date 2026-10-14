/**
 * Orca の作業台 → terminal-app のプロジェクトの割り当て（261015_5）。
 * 同じフォルダに作業台が複数ある（dev のフォルダ作業台 4 つ）・Orca がサブフォルダを登録している（pad-python/portal_tool）ケース。
 */
import { describe, expect, it } from "vitest";
import {
  belongsToProject,
  orcaSleepingPathSet,
  orcaWorktreePathSet,
  ownerProjectPath,
  pickOrcaTerminal,
  type OrcaTerminal,
  type OrcaWorktree,
} from "../src/main/orca";
import { normalizePath } from "../src/main/state-store";

const wt = (path: string, worktreeId: string, live?: number): OrcaWorktree =>
  ({ path, worktreeId, agents: [], ...(live !== undefined ? { liveTerminals: live } : {}) });
const projects = ["C:/u/dev", "C:/u/dev/terminal-app", "C:/u/dev/pad-python"];
const key = (p: string): string => normalizePath(p);

describe("作業台 → プロジェクト", () => {
  it("最長一致で割り当てる。どこにも属さなければ null", () => {
    expect(ownerProjectPath("C:/u/dev/pad-python/portal_tool", projects)).toBe(key("C:/u/dev/pad-python"));
    expect(ownerProjectPath("C:/u/dev/terminal-app", projects)).toBe(key("C:/u/dev/terminal-app"));
    expect(ownerProjectPath("C:/u/dev/app-gallery", projects)).toBe(key("C:/u/dev"));
    expect(ownerProjectPath("C:/u/orca/workspaces/x", projects)).toBeNull();
  });

  it("より深い登録プロジェクトのフォルダは親プロジェクトに含めない", () => {
    expect(belongsToProject("C:/u/dev/terminal-app", "C:/u/dev", projects)).toBe(false);
    expect(belongsToProject("C:/u/dev/pad-python/portal_tool", "C:/u/dev/pad-python", projects)).toBe(true);
  });
});

describe("接続とスリープの判定", () => {
  it("同じフォルダの作業台が 1 つでも動いていればスリープではない（dev のフォルダ作業台）", () => {
    const list = [wt("C:/u/dev", "folder:a", 0), wt("C:/u/dev", "folder:b", 1), wt("C:/u/dev", "folder:c", 0)];
    expect(orcaSleepingPathSet(list, projects).has(key("C:/u/dev"))).toBe(false);
    expect(orcaWorktreePathSet(list, projects).has(key("C:/u/dev"))).toBe(true);
    expect(orcaSleepingPathSet(list).has(key("C:/u/dev"))).toBe(false);
  });

  it("全部 0 本ならスリープ", () => {
    const list = [wt("C:/u/dev", "folder:a", 0), wt("C:/u/dev", "folder:b", 0)];
    expect(orcaSleepingPathSet(list, projects).has(key("C:/u/dev"))).toBe(true);
  });

  it("Orca がサブフォルダを登録していれば親プロジェクトとして繋がる（pad-python/portal_tool）", () => {
    const list = [wt("C:/u/dev/pad-python/portal_tool", "r::C:/u/dev/pad-python/portal_tool", 1)];
    expect(orcaWorktreePathSet(list, projects).has(key("C:/u/dev/pad-python"))).toBe(true);
    expect(orcaWorktreePathSet(list, projects).has(key("C:/u/dev"))).toBe(false);
  });
});

describe("切替先ターミナル（サブフォルダ）", () => {
  const term = (handle: string, worktreePath: string, worktreeId?: string): OrcaTerminal =>
    ({ handle, worktreePath, worktreeId, tabId: `tab-${handle}`, leafId: `leaf-${handle}`, agentIdentity: "claude" });

  it("サブフォルダのターミナルを親プロジェクトの切替先にする。より深い登録プロジェクトのものは使わない", () => {
    const terminals = [term("t-app", "C:/u/dev/terminal-app"), term("t-portal", "C:/u/dev/pad-python/portal_tool")];
    const worktrees = [wt("C:/u/dev/terminal-app", "r1::x", 1), wt("C:/u/dev/pad-python/portal_tool", "r2::y", 1)];
    const pick = (projectPath: string): string | undefined =>
      pickOrcaTerminal({ terminals, worktrees, paneBySession: new Map(), projectPath, projectPaths: projects })?.handle;
    expect(pick("C:/u/dev/pad-python")).toBe("t-portal");
    expect(pick("C:/u/dev")).toBeUndefined();
  });
});

describe("別セッションのタブへ飛ばない", () => {
  const term = (handle: string, worktreeId: string, tabId: string): OrcaTerminal =>
    ({ handle, worktreePath: "", worktreeId, tabId, leafId: "leaf", agentIdentity: "claude" });

  it("押したセッションのターミナルが無ければ、他セッションのものと分かっているタブは選ばない", () => {
    const terminals = [term("t-b", "folder:b", "tab-b")];
    const worktrees = [wt("C:/u/dev", "folder:a", 0), wt("C:/u/dev", "folder:b", 1)];
    const paneBySession = new Map([["session-b", "tab-b:leaf"]]);
    const pick = (sessionId?: string): string | undefined => pickOrcaTerminal({
      terminals, worktrees, paneBySession, projectPath: "C:/u/dev", projectPaths: projects,
      ...(sessionId !== undefined ? { hint: { sessionId, provider: "claude" } } : {}),
    })?.handle;
    expect(pick("session-a")).toBeUndefined();
    expect(pick("session-b")).toBe("t-b");
    expect(pick()).toBe("t-b");
  });
});

describe("ジャンクション越しのフォルダ（261015_6）", () => {
  // dev/zaico-kanri-app は dev/tana2/zaico-kanri-app へのジャンクション。Orca は実体のパスで作業台を返す
  const resolve = (p: string): string => p.replace(/zaico-kanri-app$/i, "tana2/zaico-kanri-app").replace(/\/dev\/tana2\/tana2\//i, "/dev/tana2/");
  const ps = ["C:/u/dev", "C:/u/dev/zaico-kanri-app"];

  it("実体のパスの作業台を、ジャンクション側の登録プロジェクトに割り当てる", () => {
    expect(ownerProjectPath("C:/u/dev/tana2/zaico-kanri-app", ps, resolve)).toBe(key("C:/u/dev/zaico-kanri-app"));
    expect(ownerProjectPath("C:/u/dev/tana2/other", ps, resolve)).toBe(key("C:/u/dev"));
  });
});
