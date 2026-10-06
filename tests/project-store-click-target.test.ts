/**
 * クリック先（Cursor / Orca / ターミナル）の一括変更と既定値（261005_1）。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../src/main/project-store";
import type { ClickTarget } from "../src/shared/types";

let dataDir: string;
let dirs: string[];

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-data-"));
  dirs = ["a", "b"].map((n) => {
    const d = path.join(dataDir, n);
    fs.mkdirSync(d);
    return d;
  });
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function newStore(): ProjectStore {
  const store = new ProjectStore(dataDir);
  store.load();
  return store;
}

describe("クリック先の一括変更（261005_1）", () => {
  it("全プロジェクトを揃え、既定値として config.json に残る（再ロード後も保持）", () => {
    const store = newStore();
    store.addProject(dirs[0]);
    store.addProject(dirs[1], "orca");
    expect(store.setAllClickTargets("orca")).toBe(1);
    expect(store.projects.map((p) => p.clickTarget)).toEqual(["orca", "orca"]);
    const reloaded = newStore();
    expect(reloaded.config.defaultClickTarget).toBe("orca");
    expect(reloaded.projects.map((p) => p.clickTarget)).toEqual(["orca", "orca"]);
  });

  it("未知の値は受け付けない（個別・一括とも）", () => {
    const store = newStore();
    const added = store.addProject(dirs[0]);
    expect(store.setClickTarget(added.project!.id, "vscode" as ClickTarget)).toBe(false);
    expect(store.setAllClickTargets("vscode" as ClickTarget)).toBe(-1);
    expect(store.projects[0].clickTarget).toBe("cursor");
    expect(store.config.defaultClickTarget).toBeUndefined();
  });

  it("手編集で壊れた値は読み込み時に cursor / 既定なしへ戻す", () => {
    fs.writeFileSync(path.join(dataDir, "projects.json"), JSON.stringify({
      projects: [{ id: "x", name: "a", path: dirs[0], clickTarget: "vscode", registeredAt: "" }],
    }));
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ defaultClickTarget: 42 }));
    const store = newStore();
    expect(store.projects[0].clickTarget).toBe("cursor");
    expect(store.config.defaultClickTarget).toBeUndefined();
  });
});
