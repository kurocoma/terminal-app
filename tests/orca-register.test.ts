/**
 * Orca へのフォルダ登録（261015_1）の純関数部分: 登録手順の判定と `repo list` の読み取り。CLI は呼ばない。
 */
import { describe, expect, it } from "vitest";
import { parseRepoPaths, registerPlan } from "../src/main/orca";
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
