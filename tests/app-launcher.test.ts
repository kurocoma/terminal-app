/**
 * 立ち上げ（260717_1）の解決ロジック検証。
 * resolveLaunchCommand は env と存在確認を注入できるため、実環境に依存せずに
 * 「どのインストールを・どの引数で起動するか」を確認する。
 */
import * as path from "path";
import { spawn, spawnSync } from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchProjectApp, resolveLaunchCommand, type ResolveDeps } from "../src/main/app-launcher";

vi.mock("child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("child_process")>(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));
vi.mock("fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("fs")>(),
  lstatSync: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const PROJECT = "C:\\Users\\me\\dev\\my-app";

function deps(env: ResolveDeps["env"], existing: string[]): ResolveDeps {
  const set = new Set(existing.map((p) => path.normalize(p).toLowerCase()));
  return { env, exists: (p) => set.has(path.normalize(p).toLowerCase()) };
}

describe("resolveLaunchCommand: cursor", () => {
  it("PATH の cursor bin エントリから Cursor.exe を導出する（最優先）", () => {
    const bin = "C:\\Program Files\\cursor\\resources\\app\\bin";
    const exe = "C:\\Program Files\\cursor\\Cursor.exe";
    const localExe = "C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe";
    const d = deps(
      {
        PATH: ["C:\\Windows", bin].join(path.delimiter),
        LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
      },
      [exe, localExe] // 両方実在しても PATH 由来を優先する
    );
    const cmd = resolveLaunchCommand("cursor", PROJECT, d);
    expect(cmd).not.toBeNull();
    expect(path.normalize(cmd!.exe)).toBe(path.normalize(exe));
    expect(cmd!.args).toEqual([PROJECT]);
  });

  it("PATH に cursor bin が無ければ %LOCALAPPDATA%\\Programs\\cursor へフォールバックする", () => {
    const localExe = "C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe";
    const d = deps(
      { PATH: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      [localExe]
    );
    const cmd = resolveLaunchCommand("cursor", PROJECT, d);
    expect(cmd).not.toBeNull();
    expect(path.normalize(cmd!.exe)).toBe(path.normalize(localExe));
  });

  it("%ProgramFiles%\\cursor もフォールバック候補になる", () => {
    const pfExe = "C:\\Program Files\\cursor\\Cursor.exe";
    const d = deps(
      { PATH: "C:\\Windows", ProgramFiles: "C:\\Program Files" },
      [pfExe]
    );
    const cmd = resolveLaunchCommand("cursor", PROJECT, d);
    expect(cmd).not.toBeNull();
    expect(path.normalize(cmd!.exe)).toBe(path.normalize(pfExe));
  });

  it("PATH の bin エントリが実在しない Cursor.exe を指すなら拾わない（exists で除外）", () => {
    const bin = "C:\\old\\cursor\\resources\\app\\bin"; // アンインストール後に残った PATH エントリ
    const localExe = "C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe";
    const d = deps(
      { PATH: bin, LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      [localExe]
    );
    const cmd = resolveLaunchCommand("cursor", PROJECT, d);
    expect(cmd).not.toBeNull();
    expect(path.normalize(cmd!.exe)).toBe(path.normalize(localExe));
  });

  it("どの候補も実在しなければ null（呼び出し側がエラーメッセージにする）", () => {
    const d = deps({ PATH: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, []);
    expect(resolveLaunchCommand("cursor", PROJECT, d)).toBeNull();
  });
});

describe("resolveLaunchCommand: terminal", () => {
  it("PATH 上の wt.exe を -d <projectPath> 付きで解決する", () => {
    const wtDir = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps";
    const d = deps(
      { PATH: ["C:\\Windows", wtDir].join(path.delimiter) },
      [path.join(wtDir, "wt.exe")]
    );
    const cmd = resolveLaunchCommand("terminal", PROJECT, d);
    expect(cmd).not.toBeNull();
    expect(path.normalize(cmd!.exe)).toBe(path.normalize(path.join(wtDir, "wt.exe")));
    expect(cmd!.args).toEqual(["-d", PROJECT]);
  });

  it("PATH に無くても %LOCALAPPDATA%\\Microsoft\\WindowsApps のエイリアスを拾う", () => {
    const alias = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
    const d = deps(
      { PATH: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      [alias]
    );
    const cmd = resolveLaunchCommand("terminal", PROJECT, d);
    expect(cmd).not.toBeNull();
    expect(path.normalize(cmd!.exe)).toBe(path.normalize(alias));
  });

  it("wt.exe が見つからなければ null", () => {
    const d = deps({ PATH: "C:\\Windows" }, []);
    expect(resolveLaunchCommand("terminal", PROJECT, d)).toBeNull();
  });
});

describe("launchProjectApp: child environment", () => {
  const codexKeys = ["CODEX_CI", "CODEX_SESSION_ID", "CODEX_THREAD_ID"];

  function launchedEnv() {
    const options = vi.mocked(spawn).mock.calls[0]?.[2];
    expect(options).toBeDefined();
    return options!.env ?? process.env;
  }

  it.each(["cursor", "terminal"] as const)("%s の子プロセスへ Codex の端末設定と識別情報を渡さない", (target) => {
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("TERM", "dumb");
    vi.stubEnv("FORCE_COLOR", "0");
    for (const key of codexKeys) vi.stubEnv(key, "launcher-test-fixture");
    vi.stubEnv("LAUNCHER_TEST_CUSTOM", "preserved");

    expect(launchProjectApp(target, PROJECT)).toEqual({ ok: true });
    const env = launchedEnv();
    for (const key of [...codexKeys, "NO_COLOR", "TERM", "FORCE_COLOR"]) {
      expect(env[key], key).toBeUndefined();
    }
    expect(env.LAUNCHER_TEST_CUSTOM).toBe("preserved");
    expect(env.PATH ?? env.Path).toBe(process.env.PATH ?? process.env.Path);
    expect(process.env.NO_COLOR).toBe("1");
    expect(process.env.TERM).toBe("dumb");
    expect(process.env.CODEX_CI).toBe("launcher-test-fixture");

    // spawn の設定だけでなく、実際の子プロセスにも汚染が届かないことを確認する。
    const probe = spawnSync(process.execPath, ["-e", `
      const keys = ["NO_COLOR", "TERM", "FORCE_COLOR", "CODEX_CI", "CODEX_SESSION_ID", "CODEX_THREAD_ID"];
      process.stdout.write(JSON.stringify({
        absent: keys.every(key => process.env[key] === undefined),
        custom: process.env.LAUNCHER_TEST_CUSTOM
      }));
    `], { env, encoding: "utf8", windowsHide: true });
    expect(probe.status).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual({ absent: true, custom: "preserved" });
  });

  it("Codex 以外から起動された場合はユーザーの色・端末設定を維持する", () => {
    for (const key of codexKeys) vi.stubEnv(key, undefined);
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("TERM", "dumb");
    vi.stubEnv("FORCE_COLOR", "0");

    expect(launchProjectApp("cursor", PROJECT).ok).toBe(true);
    expect(launchedEnv()).toMatchObject({ NO_COLOR: "1", TERM: "dumb", FORCE_COLOR: "0" });
  });

  it.each(codexKeys)("%s だけでも Codex 由来を検出し、通常の端末能力と CODEX_HOME は維持する", (key) => {
    for (const codexKey of codexKeys) vi.stubEnv(codexKey, undefined);
    vi.stubEnv(key, "launcher-test-fixture");
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("NO_COLOR", "user-choice");
    vi.stubEnv("FORCE_COLOR", "3");
    vi.stubEnv("CODEX_HOME", "C:/test-codex-home");

    expect(launchProjectApp("cursor", PROJECT).ok).toBe(true);
    expect(launchedEnv()).toMatchObject({ TERM: "xterm-256color", NO_COLOR: "user-choice", FORCE_COLOR: "3", CODEX_HOME: "C:/test-codex-home" });
    for (const codexKey of codexKeys) expect(launchedEnv()[codexKey]).toBeUndefined();
  });
});
