/**
 * Orca へのフォルダ登録（261015_1）の純関数部分: 登録手順の判定と `repo list` の読み取り。CLI は呼ばない。
 */
import { describe, expect, it } from "vitest";
import { parseRepoPaths, pickWorktreeSelector, registerPlan, type OrcaWorktree } from "../src/main/orca";
import { normalizePath } from "../src/main/state-store";

describe("Orca 登録の手順", () => {
  it("git 管理のフォルダはそのまま登録", () => {
    expect(registerPlan(true, false)).toBe("add");
    expect(registerPlan(true, true)).toBe("add");
  });

  it("git 管理外は、許可が無ければ登録しない（needs-git）。許可があれば git init してから登録", () => {
    expect(registerPlan(false, false)).toBe("needs-git");
    expect(registerPlan(false, true)).toBe("init-then-add");
  });
});

describe("repo list の読み取り", () => {
  it("path を正規化して集める。壊れた要素は飛ばす", () => {
    const result = { repos: [{ path: "C:/dev/app-a", kind: "git" }, { path: "C:/dev/app-b/", kind: "folder" }, { kind: "git" }, "x"] };
    const set = parseRepoPaths(result);
    expect(set.has(normalizePath("C:/dev/app-a"))).toBe(true);
    expect(set.has(normalizePath("C:/dev/app-b"))).toBe(true);
    expect(set.size).toBe(2);
  });

  it("repos が無ければ空", () => {
    expect(parseRepoPaths({}).size).toBe(0);
    expect(parseRepoPaths(null).size).toBe(0);
  });
});

describe("作業台の選択子（261015_3）", () => {
  const wt = (path: string, worktreeId: string, live?: number): OrcaWorktree => ({ path, worktreeId, agents: [], ...(live !== undefined ? { liveTerminals: live } : {}) });

  it("同じフォルダの作業台からターミナルが生きているものを優先して id: で返す", () => {
    const list = [wt("C:/Users/x/dev", "folder:a", 0), wt("C:/Users/x/dev", "folder:b", 1), wt("C:/Users/x/other", "repo::C:/Users/x/other", 2)];
    expect(pickWorktreeSelector(list, "C:/Users/x/dev")).toBe("id:folder:b");
  });

  it("生きているものが無ければ先頭、該当フォルダが無ければ null、一覧が取れなければ null", () => {
    const list = [wt("C:/Users/x/dev", "folder:a", 0), wt("C:/Users/x/dev", "folder:b", 0)];
    expect(pickWorktreeSelector(list, "C:/Users/x/dev")).toBe("id:folder:a");
    expect(pickWorktreeSelector(list, "C:/Users/x/none")).toBeNull();
    expect(pickWorktreeSelector(null, "C:/Users/x/dev")).toBeNull();
  });
});
