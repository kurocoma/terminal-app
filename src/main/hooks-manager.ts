/**
 * ④ hooks 設定マネージャ（design.md 4.1〜4.2 / REQ-02, REQ-11, NFR-03）。
 *
 * 方針（design.md 4.2）:
 * - `.claude/settings.json` が無ければ `{}` から開始（`.claude/` は作成する）
 * - パース失敗時は何も書かずに中断（壊れたファイルを上書きしない）
 * - 書き込み前に `settings.json.terminal-app.bak` へバックアップ（操作ごとに上書き）
 * - マーカー（command に URL パス `/terminal-app/event` を含む）が無い場合のみ append（冪等）。
 *   既存エントリは順序含め変更しない
 * - 一時ファイル → rename のアトミック書き込み
 * - 除去は自アプリのマーカー付きエントリのみ。空になった配列・hooks キーは削除
 * - 起動時追補（design.md 4.2）: 登録済みプロジェクトにも本マージを冪等適用し、
 *   不足イベント（旧 2 イベント構成 → UserPromptSubmit）だけを再登録なしで append する
 */
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_PORT, EVENT_PATH, HOOK_MARKER, STATUSLINE_MARKER, STATUSLINE_PATH } from "./constants";

/**
 * 追記対象イベント。Stop / Notification に加え UserPromptSubmit を追記する
 * （OPEN-04 案 A 採用 — 2026-07-11 ユーザー実測により確定。design.md 4.1 / 4.5）。
 * UserPromptSubmit がプロンプト送信＝実行開始の検知経路になり、タイルを「実行中」へ遷移させる。
 */
export const HOOK_EVENTS = ["Stop", "Notification", "UserPromptSubmit"] as const;

/**
 * 追加の追記対象イベント（260712_3）: TaskCreated → task_subject（タスクの作業タイトル）を
 * タイルの作業テキストに使う。実在・payload 形（session_id / cwd / task_subject 等）は
 * 2026-07-12 に実 claude 2.1.207 セッションの hook stdin ダンプで確認済み。
 * HOOK_EVENTS と分けているのは互換のため（mergeHooks/removeHooks の既定挙動を変えない）。
 */
export const TASK_HOOK_EVENTS = ["TaskCreated"] as const;

/**
 * セッション開始の検知（260909_1）: SessionStart → 同じプロジェクトの「切断」「終了済み」表示を消し、タイルを待機へ戻す。
 * payload は session_id / cwd / source（startup / resume / clear / compact / fork。公式 hooks reference）。
 * 起動時追補で既存プロジェクトにも冪等に行き渡る
 */
export const SESSION_HOOK_EVENTS = ["SessionStart"] as const;

/** 実運用で追記する全イベント（index.ts の登録・起動時追補・除去はこちらを渡す） */
export const ALL_HOOK_EVENTS = [...HOOK_EVENTS, ...TASK_HOOK_EVENTS, ...SESSION_HOOK_EVENTS] as const;

export interface HookOpResult {
  ok: boolean;
  /** 実際にファイルへ書き込んだか（冪等 no-op のとき false） */
  changed: boolean;
  error?: string;
  backupPath?: string;
}

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
  [k: string]: unknown;
}

interface HookEntry {
  hooks?: HookCommand[];
  [k: string]: unknown;
}

type SettingsObject = Record<string, unknown>;

/** design.md 4.1 の hook コマンド文字列を組み立てる */
export function buildHookCommand(port: number = DEFAULT_PORT): string {
  return (
    `curl.exe -s -m 2 -o NUL -X POST http://127.0.0.1:${port}${EVENT_PATH}` +
    ` -H "Content-Type: application/json" --data-binary @-`
  );
}

/**
 * statusLine 転送コマンド（260712_3 案A）。stdin の statusLine JSON を本アプリへ POST し、
 * レスポンス本文（整形済み「↓ 70.5k tokens · thinking xhigh」）を stdout に流す —
 * statusline は stdout をそのまま表示するため、転送とターミナル表示が 1 コマンドで両立する。
 * アプリ停止中は -m 1 で 1 秒以内に諦め、何も表示しない（セッションを阻害しない）。
 */
export function buildStatusLineCommand(port: number = DEFAULT_PORT): string {
  return (
    `curl.exe -s -m 1 -X POST http://127.0.0.1:${port}${STATUSLINE_PATH}` +
    ` -H "Content-Type: application/json" --data-binary @-`
  );
}

function buildHookEntry(port: number): HookEntry {
  return {
    hooks: [{ type: "command", command: buildHookCommand(port), timeout: 5 }],
  };
}

export function settingsPathFor(projectPath: string): string {
  return path.join(projectPath, ".claude", "settings.json");
}

export function backupPathFor(projectPath: string): string {
  return settingsPathFor(projectPath) + ".terminal-app.bak";
}

/**
 * エントリが自アプリのもの（command に URL パス `/terminal-app/event` を含む）か判定（design.md 4.1）。
 * 2026-07-11 厳格化: 旧 `terminal-app` 部分一致だと、ユーザー自身の hook コマンドが
 * terminal-app をパスに含むだけで誤って自アプリ扱い（除去・置換）されるため。
 */
export function entryHasMarker(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const hooks = (entry as HookEntry).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (h) =>
      h !== null &&
      typeof h === "object" &&
      typeof (h as HookCommand).command === "string" &&
      (h as HookCommand).command.includes(HOOK_MARKER)
  );
}

/** マーカー付きエントリの command が現在の設定（ポート）と一致するか */
function entryMatchesCommand(entry: unknown, command: string): boolean {
  if (!entryHasMarker(entry)) return false;
  const hooks = (entry as HookEntry).hooks as HookCommand[];
  return hooks.some((h) => h.command === command);
}

interface LoadResult {
  ok: boolean;
  settings?: SettingsObject;
  raw?: string;
  exists: boolean;
  error?: string;
}

function loadSettings(settingsPath: string): LoadResult {
  if (!fs.existsSync(settingsPath)) return { ok: true, settings: {}, exists: false };
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch (e) {
    return { ok: false, exists: true, error: `settings.json を読み込めません: ${String(e)}` };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, exists: true, raw, error: "settings.json のルートがオブジェクトではありません" };
    }
    return { ok: true, settings: parsed as SettingsObject, raw, exists: true };
  } catch {
    // design.md 4.2: パース失敗時は何も書かずに中断（壊れたファイルを上書きしない）
    return { ok: false, exists: true, raw, error: "settings.json の JSON パースに失敗しました（手動確認が必要です）" };
  }
}

/** 一時ファイル → rename のアトミック書き込み（design.md 4.2 / NFR-03） */
export function writeFileAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, "utf8");
  try {
    fs.renameSync(tmp, filePath); // Windows でも既存ファイルを置換する
  } catch (e) {
    // rename に失敗した一時ファイルを残さない（ゴミファイル堆積の防止）
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 掃除失敗は無視（本来のエラーを優先して伝える） */
    }
    throw e;
  }
}

function backupIfExists(projectPath: string, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined; // 元ファイルが無い場合はバックアップ不要
  const bak = backupPathFor(projectPath);
  fs.writeFileSync(bak, raw, "utf8");
  return bak;
}

/**
 * バックアップ → アトミック書き込みの共通処理（design.md 4.2 手順 5〜6）。
 * mergeHooks / removeHooks の書き込み末尾を一本化する。
 */
function backupAndWrite(projectPath: string, settingsPath: string, raw: string | undefined, settings: SettingsObject): HookOpResult {
  let backupPath: string | undefined;
  try {
    backupPath = backupIfExists(projectPath, raw);
    writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    return { ok: true, changed: true, backupPath };
  } catch (e) {
    return { ok: false, changed: false, error: `settings.json の書き込みに失敗しました: ${String(e)}`, backupPath };
  }
}

/**
 * 登録時のマージ（design.md 4.2 マージ手順）。
 * 冪等: マーカー付きエントリが現在のコマンドと一致して存在する場合は何も書かない。
 * ポート変更時（design.md 3.3）: 旧ポートのマーカー付きエントリを現在のコマンドへ置き換える。
 */
export function mergeHooks(
  projectPath: string,
  port: number = DEFAULT_PORT,
  // 既定は従来の 3 イベント（design.md 4.1 の凍結仕様と既存検証に合わせる）。
  // 実運用の呼び出し（index.ts）は ALL_HOOK_EVENTS を渡して TaskCreated も追記する（260712_3）
  events: readonly string[] = HOOK_EVENTS
): HookOpResult {
  const settingsPath = settingsPathFor(projectPath);
  const loaded = loadSettings(settingsPath);
  if (!loaded.ok || loaded.settings === undefined) {
    return { ok: false, changed: false, error: loaded.error };
  }
  const settings = loaded.settings;
  const command = buildHookCommand(port);

  // hooks コンテナの検証（想定外の型なら壊さず中断）
  if ("hooks" in settings && (settings.hooks === null || typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) {
    return { ok: false, changed: false, error: "settings.json の hooks キーがオブジェクトではありません" };
  }
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  for (const evt of events) {
    if (evt in hooks && !Array.isArray(hooks[evt])) {
      return { ok: false, changed: false, error: `settings.json の hooks.${evt} が配列ではありません` };
    }
  }

  // 変更が必要か判定（冪等性: design.md 4.2 手順 4）
  let changed = false;
  const nextHooks: Record<string, unknown> = { ...hooks };
  for (const evt of events) {
    const arr = Array.isArray(nextHooks[evt]) ? ([...(nextHooks[evt] as unknown[])] as unknown[]) : [];
    const markerEntries = arr.filter((e) => entryHasMarker(e));
    const upToDate = markerEntries.length === 1 && entryMatchesCommand(markerEntries[0], command);
    if (!upToDate) {
      // 自アプリ分（旧ポート・重複含む）を除去し、現在のエントリを末尾へ append。
      // 既存（他者）のエントリは順序含めそのまま維持する。
      const others = arr.filter((e) => !entryHasMarker(e));
      others.push(buildHookEntry(port));
      nextHooks[evt] = others;
      changed = true;
    }
  }

  if (!changed && loaded.exists) {
    return { ok: true, changed: false };
  }

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  } catch (e) {
    return { ok: false, changed: false, error: `.claude ディレクトリを作成できません: ${String(e)}` };
  }
  settings.hooks = nextHooks;
  return backupAndWrite(projectPath, settingsPath, loaded.raw, settings);
}

/** settings.json の statusLine が自アプリの転送コマンドか（URL パス一致。260712_3） */
export function statusLineIsOurs(statusLine: unknown): boolean {
  if (statusLine === null || typeof statusLine !== "object") return false;
  const command = (statusLine as Record<string, unknown>).command;
  return typeof command === "string" && command.includes(STATUSLINE_MARKER);
}

export interface StatusLineOpResult extends HookOpResult {
  /** ユーザー自身の statusLine が既にあるため設定しなかったとき true（上書き事故防止） */
  skipped?: boolean;
}

/**
 * statusLine 転送設定のマージ（260712_3 案A）。hooks と同じ安全方針:
 * - ユーザー自身の statusLine が既にある場合は一切触らない（skipped: true）。
 *   statusLine は hooks と違い単一値のため、追記共存ができない — 上書きは事故になる
 * - 自アプリ分が現在のポートと一致していれば no-op（冪等）
 * - 自アプリ分が旧ポートなら現在のコマンドへ置換（ポート変更の追従）
 */
export function mergeStatusLine(projectPath: string, port: number = DEFAULT_PORT): StatusLineOpResult {
  const settingsPath = settingsPathFor(projectPath);
  const loaded = loadSettings(settingsPath);
  if (!loaded.ok || loaded.settings === undefined) {
    return { ok: false, changed: false, error: loaded.error };
  }
  const settings = loaded.settings;
  const command = buildStatusLineCommand(port);

  if ("statusLine" in settings && settings.statusLine !== undefined && settings.statusLine !== null) {
    if (!statusLineIsOurs(settings.statusLine)) {
      return { ok: true, changed: false, skipped: true }; // ユーザー自身の statusLine を尊重
    }
    if ((settings.statusLine as Record<string, unknown>).command === command) {
      return { ok: true, changed: false }; // 冪等
    }
  }
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  } catch (e) {
    return { ok: false, changed: false, error: `.claude ディレクトリを作成できません: ${String(e)}` };
  }
  settings.statusLine = { type: "command", command };
  return backupAndWrite(projectPath, settingsPath, loaded.raw, settings);
}

/** statusLine 転送設定の除去（260712_3）。自アプリ分のみ削除し、ユーザー自身の設定は残す */
export function removeStatusLine(projectPath: string): HookOpResult {
  const settingsPath = settingsPathFor(projectPath);
  if (!fs.existsSync(settingsPath)) return { ok: true, changed: false };
  const loaded = loadSettings(settingsPath);
  if (!loaded.ok || loaded.settings === undefined) {
    return { ok: false, changed: false, error: loaded.error };
  }
  const settings = loaded.settings;
  if (!statusLineIsOurs(settings.statusLine)) return { ok: true, changed: false };
  delete settings.statusLine;
  return backupAndWrite(projectPath, settingsPath, loaded.raw, settings);
}

/**
 * 登録解除時の除去（design.md 4.2 除去手順）。
 * 自アプリのマーカー付きエントリのみを取り除き、空になった配列・空になった hooks キーは削除する。
 */
export function removeHooks(
  projectPath: string,
  // mergeHooks と同じ理由で既定は従来 3 イベント。実運用（index.ts）は ALL_HOOK_EVENTS を渡す
  events: readonly string[] = HOOK_EVENTS
): HookOpResult {
  const settingsPath = settingsPathFor(projectPath);
  if (!fs.existsSync(settingsPath)) {
    return { ok: true, changed: false }; // 元々何もない → 除去不要
  }
  const loaded = loadSettings(settingsPath);
  if (!loaded.ok || loaded.settings === undefined) {
    return { ok: false, changed: false, error: loaded.error };
  }
  const settings = loaded.settings;
  if (settings.hooks === undefined || settings.hooks === null || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    return { ok: true, changed: false }; // hooks が無い/想定外 → 触らない
  }
  const hooks = settings.hooks as Record<string, unknown>;

  let changed = false;
  for (const evt of events) {
    const arr = hooks[evt];
    if (!Array.isArray(arr)) continue;
    const filtered = arr.filter((e) => !entryHasMarker(e));
    if (filtered.length !== arr.length) {
      changed = true;
      if (filtered.length === 0) {
        delete hooks[evt]; // 空になった配列は削除（痕跡を残さない）
      } else {
        hooks[evt] = filtered;
      }
    }
  }
  if (!changed) return { ok: true, changed: false };

  if (Object.keys(hooks).length === 0) {
    delete settings.hooks; // 空になった hooks キーも削除
  }

  return backupAndWrite(projectPath, settingsPath, loaded.raw, settings);
}
