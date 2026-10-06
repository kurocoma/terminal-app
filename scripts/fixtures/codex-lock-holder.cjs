/* global require, process */
/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS child process for the native lock fixture. */
/**
 * Windows 用の使い捨て Codex writer lock。実ユーザーの lock ファイルは受け付けない。
 * node codex-lock-holder.cjs <temp-fixture/thread-writer-locks/UUID.lock>
 * stdout ready 後は stdin EOF まで所有し、明示解除して終了する。親 kill 時は OS が解放する。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const koffi = require("koffi");

if (process.platform !== "win32" || process.argv.length !== 3) {
  throw new Error("This Windows fixture requires one temporary lock path");
}
const filename = fs.realpathSync(process.argv[2]);
const relative = path.relative(fs.realpathSync(os.tmpdir()), filename);
const firstDirectory = relative.split(path.sep)[0];
if (path.isAbsolute(relative) || !firstDirectory.startsWith("ta-codex-") ||
    path.basename(path.dirname(filename)) !== "thread-writer-locks" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.lock$/i.test(path.basename(filename)) ||
    !fs.statSync(filename).isFile() || fs.statSync(filename).size !== 0) {
  throw new Error("Only a temporary ta-codex-* fixture empty lock file may be locked");
}

const kernel = koffi.load("kernel32.dll");
koffi.struct("TEST_OVERLAPPED", {
  Internal: "uintptr_t", InternalHigh: "uintptr_t", Offset: "uint32_t", OffsetHigh: "uint32_t", hEvent: "void *",
});
const open = kernel.func("__stdcall", "CreateFileW", "void *", ["str16", "uint32_t", "uint32_t", "void *", "uint32_t", "uint32_t", "void *"]);
const lock = kernel.func("bool __stdcall LockFileEx(void *, uint32_t, uint32_t, uint32_t, uint32_t, TEST_OVERLAPPED *)");
const unlock = kernel.func("bool __stdcall UnlockFileEx(void *, uint32_t, uint32_t, uint32_t, TEST_OVERLAPPED *)");
const close = kernel.func("bool __stdcall CloseHandle(void *)");
const lastError = kernel.func("uint32_t __stdcall GetLastError()");
// OPEN_EXISTING + FILE_SHARE_READ/WRITE/DELETE。ファイル自体の共有拒否ではなく排他 byte-range lock を再現する。
const handle = open(filename, 0xC0000000, 7, null, 3, 0x80, null);
if (!handle || koffi.address(handle) === (1n << BigInt(process.arch === "ia32" ? 32 : 64)) - 1n) {
  throw new Error("CreateFileW failed: " + lastError());
}
const overlapped = { Internal: 0, InternalHigh: 0, Offset: 0, OffsetHigh: 0, hEvent: null };
if (!lock(handle, 3, 0, 0xffffffff, 0xffffffff, overlapped)) {
  const code = lastError();
  close(handle);
  throw new Error("LockFileEx failed: " + code);
}
process.stdout.write("ready\n");
process.stdin.once("end", () => {
  const unlocked = unlock(handle, 0, 0xffffffff, 0xffffffff, overlapped);
  const code = unlocked ? 0 : lastError();
  close(handle);
  if (!unlocked) throw new Error("UnlockFileEx failed: " + code);
  process.exit(0);
});
process.stdin.resume();
