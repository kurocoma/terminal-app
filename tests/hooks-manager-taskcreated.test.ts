/**
 * 260712_3: hooks への TaskCreated 追記のテスト。
 *
 * 設計: HOOK_EVENTS（3 イベント）は design.md 4.1 の凍結仕様のため既定挙動は変えず、
 * mergeHooks / removeHooks に events 引数を追加して実運用（index.ts）だけが
 * ALL_HOOK_EVENTS（3 イベント + TaskCreated）を渡す。ここではその両面を検証する。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALL_HOOK_EVENTS,
  HOOK_EVENTS,
  mergeHooks,
  removeHooks,
  settingsPathFor,
  TASK_HOOK_EVENTS,
} from "../src/main/hooks-manager";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-hooks-task-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function readSettings(): { hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>> } {
  return JSON.parse(fs.readFileSync(settingsPathFor(dir), "utf8"));
}

describe("イベント集合の定義", () => {
  it("ALL_HOOK_EVENTS = 従来 3 イベント + TaskCreated（既存 HOOK_EVENTS は不変）", () => {
    expect([...TASK_HOOK_EVENTS]).toEqual(["TaskCreated"]);
    expect([...ALL_HOOK_EVENTS]).toEqual([...HOOK_EVENTS, "TaskCreated", "SessionStart"]); // SessionStart は 260909_1
  });
});

describe("mergeHooks(…, ALL_HOOK_EVENTS)", () => {
  it("新規プロジェクトに TaskCreated を含む 4 イベントを追記する", () => {
    const result = mergeHooks(dir, 41321, ALL_HOOK_EVENTS);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    const hooks = readSettings().hooks;
    for (const evt of ALL_HOOK_EVENTS) {
      expect(Array.isArray(hooks[evt])).toBe(true);
      expect(hooks[evt][0].hooks[0].command).toContain("/terminal-app/event");
    }
  });

  it("既定引数（従来 3 イベント）では TaskCreated を追記しない（後方互換）", () => {
    const result = mergeHooks(dir, 41321);
    expect(result.ok).toBe(true);
    const hooks = readSettings().hooks;
    expect(hooks.TaskCreated).toBeUndefined();
    for (const evt of HOOK_EVENTS) expect(Array.isArray(hooks[evt])).toBe(true);
  });

  it("旧 3 イベント構成の既存プロジェクトへ追補すると TaskCreated だけが追加され、既存エントリは不変", () => {
    mergeHooks(dir, 41321); // 旧構成で登録済みの状態を再現
    const before = readSettings();
    const result = mergeHooks(dir, 41321, ALL_HOOK_EVENTS); // 起動時追補（index.ts 相当）
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    const after = readSettings();
    for (const evt of HOOK_EVENTS) {
      expect(after.hooks[evt]).toEqual(before.hooks[evt]); // 既存 3 イベントは 1 バイトも変わらない
    }
    expect(after.hooks.TaskCreated[0].hooks[0].command).toContain("/terminal-app/event");
  });

  it("4 イベント構成で 2 回目のマージは no-op（冪等）", () => {
    mergeHooks(dir, 41321, ALL_HOOK_EVENTS);
    const result = mergeHooks(dir, 41321, ALL_HOOK_EVENTS);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
  });

  it("ユーザー自身の TaskCreated hook が既にある場合は残して自アプリ分を追記する", () => {
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    const original = {
      hooks: { TaskCreated: [{ hooks: [{ type: "command", command: "echo user-own-task-hook" }] }] },
    };
    fs.writeFileSync(settingsPathFor(dir), JSON.stringify(original));
    mergeHooks(dir, 41321, ALL_HOOK_EVENTS);
    const hooks = readSettings().hooks;
    expect(hooks.TaskCreated).toHaveLength(2);
    expect(hooks.TaskCreated[0].hooks[0].command).toBe("echo user-own-task-hook");
    expect(hooks.TaskCreated[1].hooks[0].command).toContain("/terminal-app/event");
  });
});

describe("removeHooks(…, ALL_HOOK_EVENTS)", () => {
  it("登録解除で TaskCreated を含む自アプリ分がすべて除去される", () => {
    mergeHooks(dir, 41321, ALL_HOOK_EVENTS);
    const result = removeHooks(dir, ALL_HOOK_EVENTS);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    const settings = readSettings();
    expect(settings.hooks).toBeUndefined(); // 空になった hooks キーは削除される既存仕様
  });

  it("ユーザー自身の TaskCreated hook は除去されない", () => {
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(
      settingsPathFor(dir),
      JSON.stringify({ hooks: { TaskCreated: [{ hooks: [{ type: "command", command: "echo user-own-task-hook" }] }] } })
    );
    mergeHooks(dir, 41321, ALL_HOOK_EVENTS);
    removeHooks(dir, ALL_HOOK_EVENTS);
    const hooks = readSettings().hooks;
    expect(hooks.TaskCreated).toHaveLength(1);
    expect(hooks.TaskCreated[0].hooks[0].command).toBe("echo user-own-task-hook");
  });
});
