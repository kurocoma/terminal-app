import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { readCodexLiveness, type CodexLivenessDeps } from "../src/main/codex-liveness";

const THREAD = "0199c1a1-1234-7abc-8def-0123456789ab";
const HOME = path.join("C:", "test-codex");

function error(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function fake(overrides: Partial<CodexLivenessDeps> = {}): CodexLivenessDeps {
  return {
    platform: "win32",
    statSync: vi.fn(() => ({ isDirectory: () => true })),
    openSync: vi.fn(() => 42),
    readSync: vi.fn(() => 0),
    closeSync: vi.fn(),
    ...overrides,
  };
}

describe("readCodexLiveness", () => {
  it("先頭 1 byte を読み取り専用で調べ、read の EBUSY のみ alive にする", () => {
    const deps = fake({ readSync: vi.fn(() => { throw error("EBUSY"); }) });
    expect(readCodexLiveness(HOME, THREAD, deps)).toBe("alive");
    expect(deps.statSync).toHaveBeenCalledWith(path.join(HOME, "thread-writer-locks"));
    expect(deps.openSync).toHaveBeenCalledWith(path.join(HOME, "thread-writer-locks", `${THREAD}.lock`), "r");
    expect(deps.readSync).toHaveBeenCalledWith(42, Buffer.alloc(1), 0, 1, 0);
    expect(deps.closeSync).toHaveBeenCalledExactlyOnceWith(42);
  });

  it.each([0, 1])("読み取り成功（%i bytes）はロックの残骸として dead", (bytes) => {
    const deps = fake({ readSync: vi.fn(() => bytes) });
    expect(readCodexLiveness(HOME, THREAD, deps)).toBe("dead");
    expect(deps.closeSync).toHaveBeenCalledExactlyOnceWith(42);
  });

  it("ロック directory がありファイルだけが無い場合は dead", () => {
    const deps = fake({ openSync: vi.fn(() => { throw error("ENOENT"); }) });
    expect(readCodexLiveness(HOME, THREAD, deps)).toBe("dead");
    expect(deps.readSync).not.toHaveBeenCalled();
    expect(deps.closeSync).not.toHaveBeenCalled();
  });

  it.each(["ENOENT", "EACCES", "EPERM", "EBUSY"])("directory 検査が %s なら unknown", (code) => {
    const deps = fake({ statSync: vi.fn(() => { throw error(code); }) });
    expect(readCodexLiveness(HOME, THREAD, deps)).toBe("unknown");
    expect(deps.openSync).not.toHaveBeenCalled();
  });

  it("directory のはずの場所が通常ファイルなら unknown", () => {
    const deps = fake({ statSync: vi.fn(() => ({ isDirectory: () => false })) });
    expect(readCodexLiveness(HOME, THREAD, deps)).toBe("unknown");
    expect(deps.openSync).not.toHaveBeenCalled();
  });

  it.each(["EBUSY", "EACCES", "EPERM", "EIO"])("open の %s は生存根拠にせず unknown", (code) => {
    const deps = fake({ openSync: vi.fn(() => { throw error(code); }) });
    expect(readCodexLiveness(HOME, THREAD, deps)).toBe("unknown");
    expect(deps.readSync).not.toHaveBeenCalled();
    expect(deps.closeSync).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "EPERM", "EIO", "ENOENT"])("read の %s は unknown にし fd を閉じる", (code) => {
    const deps = fake({ readSync: vi.fn(() => { throw error(code); }) });
    expect(readCodexLiveness(HOME, THREAD, deps)).toBe("unknown");
    expect(deps.closeSync).toHaveBeenCalledExactlyOnceWith(42);
  });

  it("fd=0 でも閉じ、close 失敗で判定を壊さない", () => {
    const deps = fake({ openSync: vi.fn(() => 0), closeSync: vi.fn(() => { throw error("EIO"); }) });
    expect(readCodexLiveness(HOME, THREAD, deps)).toBe("dead");
    expect(deps.closeSync).toHaveBeenCalledExactlyOnceWith(0);
  });

  it.each<NodeJS.Platform>(["linux", "darwin"])("%s ではファイルを触らず unknown", (platform) => {
    const deps = fake({ platform });
    expect(readCodexLiveness(HOME, THREAD, deps)).toBe("unknown");
    expect(deps.statSync).not.toHaveBeenCalled();
  });

  it.each(["", "../outside", `../${THREAD}`, `${THREAD}/child`, `${THREAD}.lock`, "not-a-uuid", `${THREAD}\n`])(
    "UUID 以外の sessionId=%j はファイルを触らず unknown", (sessionId) => {
      const deps = fake();
      expect(readCodexLiveness(HOME, sessionId, deps)).toBe("unknown");
      expect(deps.statSync).not.toHaveBeenCalled();
    },
  );
});

// 実 OS の挙動を独立プロセスで検証する。ロック取得はこのテストで生成する空ファイルに限る。
const LOCK_HOLDER = path.resolve("scripts/fixtures/codex-lock-holder.cjs");

async function startLockChild(filename: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, [LOCK_HOLDER, filename], { stdio: "pipe", windowsHide: true });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`Native lock timeout: ${stderr}`)); }, 5000);
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("ready\n")) { clearTimeout(timeout); resolve(); }
      });
      child.once("error", (err) => { clearTimeout(timeout); reject(err); });
      child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Native lock exited ${code}: ${stderr}`)); });
    });
    return child;
  } catch (err) {
    child.kill();
    throw err;
  }
}

describe.skipIf(process.platform !== "win32")("Windows の実 writer lock", () => {
  it.each(["unlock", "terminate"])("空ファイルの排他ロックを alive とし、%s 後の残骸を dead にする", async (command) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ta-codex-lock-"));
    const directory = path.join(root, "thread-writer-locks");
    fs.mkdirSync(directory);
    const filename = path.join(directory, `${THREAD}.lock`);
    fs.writeFileSync(filename, "", { flag: "wx" });
    const originalMtime = fs.statSync(filename).mtimeMs;
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      expect(readCodexLiveness(root, THREAD)).toBe("dead");
      child = await startLockChild(filename);
      expect(readCodexLiveness(root, THREAD)).toBe("alive");
      expect(readCodexLiveness(root, THREAD)).toBe("alive");
      const exited = once(child, "exit");
      if (command === "unlock") child.stdin.end();
      else child.kill();
      const [code] = await exited;
      if (command === "unlock") expect(code).toBe(0);
      await expect.poll(() => readCodexLiveness(root, THREAD), { timeout: 2000, interval: 25 }).toBe("dead");
      expect(fs.statSync(filename).size).toBe(0);
      expect(fs.statSync(filename).mtimeMs).toBe(originalMtime);
      fs.unlinkSync(filename);
      expect(readCodexLiveness(root, THREAD)).toBe("dead");
      fs.rmdirSync(directory);
      expect(readCodexLiveness(root, THREAD)).toBe("unknown");
    } finally {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith("ta-codex-lock-")) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }, 10000);
});
