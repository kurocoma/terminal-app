/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
/**
 * ⑤ ウィンドウ制御（design.md 7 章 / REQ-05, REQ-06）。
 * koffi（N-API ベース FFI）で user32.dll / kernel32.dll を呼ぶ。
 * - 対象探索: プロセス exe 名 ＋ ウィンドウタイトルにプロジェクト folder 名（大文字小文字非区別）。
 *   複数一致時は Z オーダー最前面（EnumWindows は Z 順で列挙される）
 * - 前面化: IsIconic → ShowWindow(SW_RESTORE) → SetForegroundWindow。
 *   失敗時フォールバック: AttachThreadInput → ALT キー送出（design.md 7.2）
 * - koffi がロードできない環境でも本体を落とさない（失敗を FocusOutcome で返す）
 */
import * as path from "path";
import type { ClickTarget } from "../shared/types";
import { PointerWarper, type PointerPort, type PointerState, type Rect, type WarpEvent } from "./pointer-warp";
import { absoluteMousePoint, PointerPulse } from "./pointer-pulse";

export interface FocusOutcome {
  ok: boolean;
  message?: string;
}

/** 前面化のオプション（260925_1） */
export interface FocusOptions {
  /**
   * タッチ／ペンでタイルを押した時に true。Windows はタッチ入力でマウスポインターを隠し、位置も
   * タッチした画面に残すため、別画面の Cursor を前面化するとポインターが「迷子」になる。
   * true なら前面化後にポインターを対象ウィンドウ中央へ移し、擬似マウス移動で再表示させる
   */
  warpPointer?: boolean;
  /** ポインター移動の経過（遅延つき再試行・最終状態）を受け取る。ログ用 */
  onWarpEvent?: (ev: WarpEvent) => void;
}

export interface TopLevelWindow {
  title: string;
  exe: string;
}

const SW_RESTORE = 9;
const SW_SHOWNORMAL = 1;
const SW_SHOWMINIMIZED = 2;
const SW_SHOWMAXIMIZED = 3;
/** WINDOWPLACEMENT.flags: 最小化中のウィンドウが復元時に最大化へ戻る */
const WPF_RESTORETOMAXIMIZED = 0x0002;
/** MonitorFromRect: どのモニタにも掛からなければ NULL */
const MONITOR_DEFAULTTONULL = 0;
const VK_MENU = 0x12;
const KEYEVENTF_KEYUP = 0x0002;
/** MOVE | MOVE_NOCOALESCE | VIRTUALDESK | ABSOLUTE */
const POINTER_INPUT_FLAGS = 0xE001;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/** ウィンドウ配置（260904_1 #3）。GetWindowPlacement の通常時矩形 ＋ 表示状態 */
export interface WindowPlacementInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
  minimized: boolean;
}

export type PlacementResult = { ok: true; placement: WindowPlacementInfo } | { ok: false; message: string };

/** clickTarget → 対象プロセス exe 名（design.md 7.1） */
const TARGET_EXES: Record<ClickTarget, string[]> = {
  cursor: ["cursor.exe"],
  orca: ["orca.exe"],
  terminal: [
    "windowsterminal.exe",
    "conhost.exe",
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
    "wezterm-gui.exe",
    "alacritty.exe",
    "mintty.exe",
  ],
};

interface Win32Api {
  koffi: any;
  EnumWindowsProc: any;
  EnumWindows: any;
  IsWindowVisible: any;
  GetWindowTextW: any;
  GetWindowThreadProcessId: any;
  IsIconic: any;
  ShowWindow: any;
  SetForegroundWindow: any;
  GetForegroundWindow: any;
  AttachThreadInput: any;
  KeybdEvent: any;
  OpenProcess: any;
  QueryFullProcessImageNameW: any;
  CloseHandle: any;
  GetCurrentThreadId: any;
  /** ウィンドウ位置の記憶／復元（260904_1 #3） */
  GetWindowPlacement: any;
  SetWindowPlacement: any;
  MonitorFromRect: any;
  WINDOWPLACEMENT: any;
  /** タッチ後のポインター迷子対策（260925_1） */
  GetWindowRect: any;
  GetCursorPos: any;
  GetCursorInfo: any;
  CURSORINFO: any;
  SetCursorPos: any;
  SendInput: any;
  MOUSE_INPUT: any;
  GetSystemMetrics: any;
  GetMonitorInfo: any;
  MONITORINFO: any;
  GetClipCursor: any;
  GetAsyncKeyState: any;
  WindowFromPoint: any;
}

let cached: Win32Api | null | undefined;

function loadApi(): Win32Api | null {
  if (cached !== undefined) return cached;
  if (process.platform !== "win32") {
    cached = null;
    return cached;
  }
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");
    const EnumWindowsProc = koffi.proto("bool __stdcall EnumWindowsProc(void *hwnd, intptr_t lParam)");
    // ウィンドウ位置の記憶／復元（260904_1 #3）用の構造体。名前はプロセス内で一意なら何でもよい
    const POINT = koffi.struct("TA_POINT", { x: "int32", y: "int32" });
    const RECT = koffi.struct("TA_RECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });
    // GetCursorInfo（260925_2）: flags に CURSOR_SHOWING / CURSOR_SUPPRESSED（タッチで抑制中）が入る
    const CURSORINFO = koffi.struct("TA_CURSORINFO", { cbSize: "uint32", flags: "uint32", hCursor: "void *", ptScreenPos: POINT });
    const MONITORINFO = koffi.struct("TA_MONITORINFO", { cbSize: "uint32", rcMonitor: RECT, rcWork: RECT, dwFlags: "uint32" });
    const MOUSEINPUT = koffi.struct("TA_MOUSEINPUT", {
      dx: "int32", dy: "int32", mouseData: "uint32", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr_t",
    });
    // INPUT の union は MOUSEINPUT が最大。マウス入力のみ扱い、x64 では offset 8 / 全体 40 bytes。
    const MOUSE_INPUT = koffi.struct("TA_MOUSE_INPUT", { type: "uint32", mi: MOUSEINPUT });
    const WINDOWPLACEMENT = koffi.struct("TA_WINDOWPLACEMENT", {
      length: "uint32",
      flags: "uint32",
      showCmd: "uint32",
      ptMinPosition: POINT,
      ptMaxPosition: POINT,
      rcNormalPosition: RECT,
    });
    cached = {
      koffi,
      EnumWindowsProc,
      EnumWindows: user32.func("bool __stdcall EnumWindows(EnumWindowsProc *proc, intptr_t lParam)"),
      IsWindowVisible: user32.func("bool __stdcall IsWindowVisible(void *hwnd)"),
      GetWindowTextW: user32.func("int __stdcall GetWindowTextW(void *hwnd, _Out_ uint16_t *str, int nMaxCount)"),
      GetWindowThreadProcessId: user32.func(
        "uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)"
      ),
      IsIconic: user32.func("bool __stdcall IsIconic(void *hwnd)"),
      ShowWindow: user32.func("bool __stdcall ShowWindow(void *hwnd, int nCmdShow)"),
      SetForegroundWindow: user32.func("bool __stdcall SetForegroundWindow(void *hwnd)"),
      GetForegroundWindow: user32.func("void *__stdcall GetForegroundWindow()"),
      AttachThreadInput: user32.func("bool __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, bool fAttach)"),
      KeybdEvent: user32.func("void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, size_t dwExtraInfo)"),
      OpenProcess: kernel32.func("void *__stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)"),
      QueryFullProcessImageNameW: kernel32.func(
        "bool __stdcall QueryFullProcessImageNameW(void *h, uint32_t flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)"
      ),
      CloseHandle: kernel32.func("bool __stdcall CloseHandle(void *h)"),
      GetCurrentThreadId: kernel32.func("uint32_t __stdcall GetCurrentThreadId()"),
      GetWindowPlacement: user32.func("bool __stdcall GetWindowPlacement(void *hwnd, _Inout_ TA_WINDOWPLACEMENT *wp)"),
      SetWindowPlacement: user32.func("bool __stdcall SetWindowPlacement(void *hwnd, const TA_WINDOWPLACEMENT *wp)"),
      MonitorFromRect: user32.func("void *__stdcall MonitorFromRect(const TA_RECT *rc, uint32_t flags)"),
      WINDOWPLACEMENT,
      GetWindowRect: user32.func("bool __stdcall GetWindowRect(void *hwnd, _Out_ TA_RECT *rc)"),
      GetCursorPos: user32.func("bool __stdcall GetCursorPos(_Out_ TA_POINT *pt)"),
      GetCursorInfo: user32.func("bool __stdcall GetCursorInfo(_Inout_ TA_CURSORINFO *ci)"),
      CURSORINFO,
      SetCursorPos: user32.func("bool __stdcall SetCursorPos(int x, int y)"),
      SendInput: user32.func("uint32 __stdcall SendInput(uint32 count, const TA_MOUSE_INPUT *inputs, int size)"),
      MOUSE_INPUT,
      GetSystemMetrics: user32.func("int __stdcall GetSystemMetrics(int index)"),
      GetMonitorInfo: user32.func("int __stdcall GetMonitorInfoW(void *monitor, _Inout_ TA_MONITORINFO *info)"),
      MONITORINFO,
      GetClipCursor: user32.func("int __stdcall GetClipCursor(_Out_ TA_RECT *rect)"),
      GetAsyncKeyState: user32.func("int16 __stdcall GetAsyncKeyState(int key)"),
      WindowFromPoint: user32.func("void * __stdcall WindowFromPoint(TA_POINT point)"),
    };
  } catch (e) {
    console.error(`window-control: koffi のロードに失敗しました: ${String(e)}`);
    cached = null;
  }
  return cached;
}

export function isAvailable(): boolean {
  return loadApi() !== null;
}

function decodeUtf16(arr: Uint16Array, len: number): string {
  return String.fromCharCode(...Array.from(arr.subarray(0, len)));
}

function getWindowTitle(api: Win32Api, hwnd: any): string {
  const buf = new Uint16Array(512);
  const len = api.GetWindowTextW(hwnd, buf, buf.length) as number;
  return len > 0 ? decodeUtf16(buf, len) : "";
}

function getProcessExe(api: Win32Api, hwnd: any): string {
  const pidBuf = new Uint32Array(1);
  api.GetWindowThreadProcessId(hwnd, pidBuf);
  const pid = pidBuf[0];
  if (pid === 0) return "";
  const h = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (h === null) return "";
  try {
    const nameBuf = new Uint16Array(1024);
    const sizeBuf = new Uint32Array([nameBuf.length]);
    const ok = api.QueryFullProcessImageNameW(h, 0, nameBuf, sizeBuf) as boolean;
    if (!ok) return "";
    return path.basename(decodeUtf16(nameBuf, sizeBuf[0])).toLowerCase();
  } finally {
    api.CloseHandle(h);
  }
}

interface EnumResult {
  hwnd: any;
  title: string;
  exe: string;
}

/** 可視トップレベルウィンドウを Z オーダー順（手前から）で列挙する */
function enumWindows(api: Win32Api): EnumResult[] {
  const results: EnumResult[] = [];
  const cb = api.koffi.register((hwnd: any, _lParam: unknown) => {
    try {
      if (!api.IsWindowVisible(hwnd)) return true;
      const title = getWindowTitle(api, hwnd);
      if (title === "") return true;
      results.push({ hwnd, title, exe: getProcessExe(api, hwnd) });
    } catch {
      /* 個別ウィンドウの取得失敗は列挙を止めない */
    }
    return true;
  }, api.koffi.pointer(api.EnumWindowsProc));
  try {
    api.EnumWindows(cb, 0);
  } finally {
    api.koffi.unregister(cb);
  }
  return results;
}

/** smoke 検証・デバッグ用: 可視トップレベルウィンドウの一覧（タイトル・プロセス exe 名） */
export function listTopLevelWindows(): TopLevelWindow[] {
  const api = loadApi();
  if (api === null) return [];
  return enumWindows(api).map((w) => ({ title: w.title, exe: w.exe }));
}

/**
 * 対象プロジェクトのウィンドウが一覧に存在するか（切断検知の補助シグナル。260712_2）。
 * 探索条件は focusProjectWindow と同一（exe 名 ＋ タイトルに folder 名。design.md 7.1）。
 * タイトル一致はヒューリスティックのため偽陰性がある（タブ切替でタイトルが変わる等）—
 * 呼び出し側（liveness-monitor）は「消失」を単独の切断根拠にしないこと。
 */
export function hasWindowFor(target: ClickTarget, folderName: string, windows: readonly TopLevelWindow[]): boolean {
  return pickTargetWindow(target, folderName, windows) !== undefined;
}

/**
 * 対象ウィンドウの選択（Z 順の配列から）。
 * - cursor / terminal: exe 名 ＋ タイトルに folder 名（design.md 7.1）
 * - orca（261005_1）: Orca は 1 枚の窓に全フォルダを載せ、タイトルは常に "Orca" — folder 名では探さない。
 *   タイトルがちょうど "Orca" の窓（メイン窓）を優先し、無ければ orca.exe の窓（ポップアウト等）。
 *   フォルダが Orca で開かれているかは orca.ts（CLI の worktree 一覧）が判定する
 */
function pickTargetWindow<T extends TopLevelWindow>(target: ClickTarget, folderName: string, windows: readonly T[]): T | undefined {
  const wanted = TARGET_EXES[target];
  if (target === "orca") {
    const own = windows.filter((w) => wanted.includes(w.exe));
    return own.find((w) => w.title.trim().toLowerCase() === "orca") ?? own[0];
  }
  const needle = folderName.toLowerCase();
  return windows.find((w) => wanted.includes(w.exe) && w.title.toLowerCase().includes(needle));
}

function isForeground(api: Win32Api, hwnd: any): boolean {
  try {
    const fg = api.GetForegroundWindow();
    if (fg === null || hwnd === null) return false;
    return String(api.koffi.address(fg)) === String(api.koffi.address(hwnd));
  } catch {
    return false;
  }
}

/**
 * 対象プロジェクトのウィンドウ（hwnd）を探す。
 * EnumWindows は Z 順（手前から）のため、最初の一致 = Z オーダー最前面（design.md 7.1）
 */
function findProjectWindow(api: Win32Api, target: ClickTarget, folderName: string): any | null {
  const found = pickTargetWindow(target, folderName, enumWindows(api));
  return found === undefined ? null : found.hwnd;
}

/**
 * クリック → 前面化（design.md 3.2(c) / 7 章）。
 * folderName = プロジェクトのフォルダ basename（タイトル一致はヒューリスティック。design.md 7.1）
 */
export function focusProjectWindow(target: ClickTarget, folderName: string, options: FocusOptions = {}): FocusOutcome {
  const api = loadApi();
  if (api === null) {
    return { ok: false, message: "Win32 API を利用できません（koffi 未ロード）" };
  }
  try {
    const hwnd = findProjectWindow(api, target, folderName);
    const outcome: FocusOutcome = hwnd === null
      ? { ok: false, message: target === "orca" ? "Orca のウィンドウが見つかりません（Orca が起動していません）" : `ウィンドウが見つかりません（${folderName} / ${target}）` }
      : bringToForeground(api, hwnd);
    if (options.warpPointer === true) {
      // 成功: 対象ウィンドウ中央へ。失敗: 位置は変えず再表示だけ（隠れたまま放置しない。260925_2）
      if (outcome.ok) pointerWarper(api).warpTo(hwnd, options.onWarpEvent);
      else pointerWarper(api).reveal(options.onWarpEvent);
    }
    return outcome;
  } catch (e) {
    return { ok: false, message: `前面化に失敗しました: ${String(e)}` };
  }
}

/**
 * タイル外のタッチ終了など、前面化を伴わない場面でポインターを再表示する（260925_2）。
 * Windows はタッチ画面に触れるたびにポインターを隠すため、タイルのタップ以外でも迷子になる
 */
export function revealPointer(onEvent?: (ev: WarpEvent) => void): boolean {
  const api = loadApi();
  if (api === null) return false;
  pointerWarper(api).reveal(onEvent);
  return true;
}

/** 現在のポインター状態（診断・テスト用）。Win32 が使えなければ null */
export function readPointerState(): PointerState | null {
  const api = loadApi();
  if (api === null) return null;
  return makePointerPort(api).cursor();
}

let warper: PointerWarper | null = null;

function pointerWarper(api: Win32Api): PointerWarper {
  if (warper === null) warper = new PointerWarper({ port: makePointerPort(api) });
  return warper;
}

function makePointerPort(api: Win32Api): PointerPort {
  const port: PointerPort = {
    windowRect(handle: unknown): Rect | null {
      const rc = { left: 0, top: 0, right: 0, bottom: 0 };
      return (api.GetWindowRect(handle, rc) as boolean) ? rc : null;
    },
    cursor(): PointerState | null {
      const ci = { cbSize: api.koffi.sizeof(api.CURSORINFO) as number, flags: 0, hCursor: null, ptScreenPos: { x: 0, y: 0 } };
      if (api.GetCursorInfo(ci) as boolean) {
        const foregroundPid = new Uint32Array(1);
        const pointerWindowPid = new Uint32Array(1);
        api.GetWindowThreadProcessId(api.GetForegroundWindow(), foregroundPid);
        api.GetWindowThreadProcessId(api.WindowFromPoint(ci.ptScreenPos), pointerWindowPid);
        return {
          pos: { x: ci.ptScreenPos.x, y: ci.ptScreenPos.y }, flags: ci.flags,
          hasCursorShape: ci.hCursor !== null, foregroundPid: foregroundPid[0], pointerWindowPid: pointerWindowPid[0],
        };
      }
      const pt = { x: 0, y: 0 };
      if (api.GetCursorPos(pt) as boolean) return { pos: { x: pt.x, y: pt.y }, flags: null };
      return null;
    },
    setCursorPos(x: number, y: number): void {
      if (!api.SetCursorPos(x, y)) throw new Error("SetCursorPos failed");
    },
    jiggle(onFailure): void {
      pulse.start(onFailure);
    },
    cancelJiggle(): void { pulse.cancel(); },
  };
  const pulse = new PointerPulse({
    position: () => port.cursor()?.pos ?? null,
    canMove: () => [1, 2, 4, 5, 6].every((key) => (api.GetAsyncKeyState(key) & 0x8000) === 0),
    monitorBounds(point): Rect | null {
      const monitor = api.MonitorFromRect({ left: point.x, top: point.y, right: point.x + 1, bottom: point.y + 1 }, MONITOR_DEFAULTTONULL);
      if (monitor === null) return null;
      const empty = (): Rect => ({ left: 0, top: 0, right: 0, bottom: 0 });
      const info = { cbSize: api.koffi.sizeof(api.MONITORINFO), rcMonitor: empty(), rcWork: empty(), dwFlags: 0 };
      const clip = empty();
      if (!api.GetMonitorInfo(monitor, info) || !api.GetClipCursor(clip)) return null;
      return {
        left: Math.max(info.rcMonitor.left, clip.left), top: Math.max(info.rcMonitor.top, clip.top),
        right: Math.min(info.rcMonitor.right, clip.right), bottom: Math.min(info.rcMonitor.bottom, clip.bottom),
      };
    },
    move(point): void {
      const left = api.GetSystemMetrics(76) as number;
      const top = api.GetSystemMetrics(77) as number;
      const absolute = absoluteMousePoint(point, {
        left, top, right: left + (api.GetSystemMetrics(78) as number), bottom: top + (api.GetSystemMetrics(79) as number),
      });
      const input = { type: 0, mi: { dx: absolute.x, dy: absolute.y, mouseData: 0, dwFlags: POINTER_INPUT_FLAGS, time: 0, dwExtraInfo: 0 } };
      if (api.SendInput(1, [input], api.koffi.sizeof(api.MOUSE_INPUT)) !== 1) throw new Error("SendInput failed");
    },
  });
  return port;
}

function emptyPlacement(api: Win32Api): any {
  return {
    length: api.koffi.sizeof(api.WINDOWPLACEMENT) as number,
    flags: 0,
    showCmd: 0,
    ptMinPosition: { x: 0, y: 0 },
    ptMaxPosition: { x: 0, y: 0 },
    rcNormalPosition: { left: 0, top: 0, right: 0, bottom: 0 },
  };
}

/**
 * ウィンドウ位置の読み取り（260904_1 #3「ウィンドウ位置を記憶」）。
 * GetWindowPlacement の rcNormalPosition（通常時の矩形。最大化・最小化中でも通常時の値が取れる）と
 * 表示状態を返す。最小化中に最大化へ戻る設定（WPF_RESTORETOMAXIMIZED）も「最大化」として扱う。
 */
export function readProjectWindowPlacement(target: ClickTarget, folderName: string): PlacementResult {
  const api = loadApi();
  if (api === null) return { ok: false, message: "Win32 API を利用できません（koffi 未ロード）" };
  try {
    const hwnd = findProjectWindow(api, target, folderName);
    if (hwnd === null) return { ok: false, message: `ウィンドウが見つかりません（${folderName} / ${target}）` };
    const wp = emptyPlacement(api);
    if (!(api.GetWindowPlacement(hwnd, wp) as boolean)) return { ok: false, message: "ウィンドウ配置を取得できませんでした" };
    const rc = wp.rcNormalPosition as { left: number; top: number; right: number; bottom: number };
    const showCmd = wp.showCmd as number;
    const minimized = showCmd === SW_SHOWMINIMIZED;
    const maximized = showCmd === SW_SHOWMAXIMIZED || (minimized && ((wp.flags as number) & WPF_RESTORETOMAXIMIZED) !== 0);
    return {
      ok: true,
      placement: { x: rc.left, y: rc.top, width: rc.right - rc.left, height: rc.bottom - rc.top, maximized, minimized },
    };
  } catch (e) {
    return { ok: false, message: `ウィンドウ配置の取得に失敗しました: ${String(e)}` };
  }
}

/**
 * ウィンドウ位置の適用（260904_1 #3「記憶した位置へ戻す」／「立ち上げる」直後の自動復元）。
 * 記憶した矩形がどのモニタにも掛からない（モニタ構成が変わった等）ときは何もしない（画面外に飛ばさない）。
 * 最小化中でも通常表示（または最大化）へ戻して配置する。
 */
export function applyProjectWindowPlacement(
  target: ClickTarget,
  folderName: string,
  bounds: { x: number; y: number; width: number; height: number; maximized: boolean }
): FocusOutcome {
  const api = loadApi();
  if (api === null) return { ok: false, message: "Win32 API を利用できません（koffi 未ロード）" };
  try {
    const hwnd = findProjectWindow(api, target, folderName);
    if (hwnd === null) return { ok: false, message: `ウィンドウが見つかりません（${folderName} / ${target}）` };
    const rect = { left: bounds.x, top: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height };
    if (api.MonitorFromRect(rect, MONITOR_DEFAULTTONULL) === null) {
      return { ok: false, message: "記憶した位置が画面外のため復元しませんでした（モニタ構成の変更？）" };
    }
    const wp = emptyPlacement(api);
    wp.showCmd = bounds.maximized ? SW_SHOWMAXIMIZED : SW_SHOWNORMAL;
    wp.ptMinPosition = { x: -1, y: -1 };
    wp.ptMaxPosition = { x: -1, y: -1 };
    wp.rcNormalPosition = rect;
    if (!(api.SetWindowPlacement(hwnd, wp) as boolean)) return { ok: false, message: "ウィンドウ配置の適用に失敗しました" };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: `ウィンドウ配置の適用に失敗しました: ${String(e)}` };
  }
}

/** design.md 7.2 の手順: SW_RESTORE → SetForegroundWindow → AttachThreadInput → ALT 送出 */
function bringToForeground(api: Win32Api, hwnd: any): FocusOutcome {
  if (api.IsIconic(hwnd)) {
    api.ShowWindow(hwnd, SW_RESTORE); // 最小化なら復元（AC-09）
  }
  api.SetForegroundWindow(hwnd);
  if (isForeground(api, hwnd)) return { ok: true };

  // フォールバック 1: AttachThreadInput で対象スレッドの入力に接続して再試行
  const pidBuf = new Uint32Array(1);
  const targetThread = api.GetWindowThreadProcessId(hwnd, pidBuf) as number;
  const currentThread = api.GetCurrentThreadId() as number;
  if (targetThread !== 0 && targetThread !== currentThread) {
    api.AttachThreadInput(currentThread, targetThread, true);
    try {
      api.SetForegroundWindow(hwnd);
    } finally {
      api.AttachThreadInput(currentThread, targetThread, false);
    }
    if (isForeground(api, hwnd)) return { ok: true };
  }

  // フォールバック 2: ALT キー送出でフォアグラウンドロックを解除して再試行
  api.KeybdEvent(VK_MENU, 0, 0, 0);
  api.SetForegroundWindow(hwnd);
  api.KeybdEvent(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
  if (isForeground(api, hwnd)) return { ok: true };

  return { ok: false, message: "前面化に失敗しました（フォアグラウンド制約）" };
}
