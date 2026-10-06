/**
 * Orca（stablyai/orca）連携（261005_1）。
 * Orca は 1 枚の窓（タイトル固定 "Orca"）に全フォルダ・全ターミナルを載せるため、Cursor のような
 * 「窓タイトルにフォルダ名」での探索が使えない。代わりに Orca 同梱の CLI（orca.exe）を使う:
 * - 未接続判定: `worktree ps` の path 一覧に登録フォルダがあるか
 * - クリック: Orca の窓を Win32 で前面化（window-control）したうえで、`terminal switch` で該当タブへ切り替える
 *   （terminal switch は Orca 内のタブ切替のみで OS の前面化はしない）
 * - 立ち上げ: `terminal create --worktree path:<dir> --focus`（未登録なら `repo add` してから）
 * 該当タブの特定は Orca の hook 状態ファイル（agent-hooks/last-status.json）の
 * providerSession.id（= Claude の session_id / Codex の thread id）→ paneKey（tabId:leafId）を使い、
 * 引けなければフォルダとエージェントの状態から推定する。
 * CLI の接続情報・トークンは orca.exe 自身が読む。本アプリはトークンを読まない・ログに出さない。
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { ClickTarget, SessionState, SessionView } from "../shared/types";
import { normalizePath } from "./state-store";

export interface OrcaDeps {
  env: Record<string, string | undefined>;
  exists: (p: string) => boolean;
}

const nativeDeps: OrcaDeps = { env: process.env, exists: fs.existsSync };

/** CLI の 1 回の待ち時間。worktree ps / terminal list は実測 0.6 秒前後 */
const CLI_TIMEOUT_MS = 5_000;
/** Orca が閉じていたときの `orca open`（ランタイム起動待ち）用 */
const OPEN_TIMEOUT_MS = 60_000;

/** 表示名（ステータスバー・メニュー用） */
export const TARGET_LABEL: Record<ClickTarget, string> = {
  cursor: "Cursor",
  orca: "Orca",
  terminal: "ターミナル",
};

/**
 * orca.exe（CLI）の解決。既定のインストール先 → PATH の順。
 * Orca.exe（GUI 本体）にもサブコマンドは転送されるが、GUI 側は起動の副作用があるため CLI を使う
 */
export function resolveOrcaCli(deps: OrcaDeps = nativeDeps): string | null {
  const candidates: string[] = [];
  if (deps.env.LOCALAPPDATA !== undefined) {
    candidates.push(path.join(deps.env.LOCALAPPDATA, "Programs", "orca", "resources", "bin", "orca.exe"));
  }
  const rawPath = deps.env.PATH ?? deps.env.Path ?? "";
  for (const dir of rawPath.split(path.delimiter).map((d) => d.trim()).filter((d) => d !== "")) {
    candidates.push(path.join(dir, "orca.exe"));
  }
  return candidates.find(deps.exists) ?? null;
}

/** Orca が Codex に渡す CODEX_HOME（既定アカウント）。無ければ null */
export function orcaCodexHome(deps: OrcaDeps = nativeDeps): string | null {
  if (deps.env.APPDATA === undefined) return null;
  const home = path.join(deps.env.APPDATA, "orca", "codex-runtime-home", "home");
  return deps.exists(home) ? home : null;
}

function orcaStatusFile(env: OrcaDeps["env"]): string | null {
  return env.APPDATA === undefined ? null : path.join(env.APPDATA, "orca", "agent-hooks", "last-status.json");
}

export interface OrcaTerminal {
  handle: string;
  /** git 管理外のフォルダ（Orca の folder-workspace）では空文字。照合は worktreeId でも行う */
  worktreePath: string;
  worktreeId?: string;
  tabId: string;
  leafId: string;
  agentIdentity?: string;
}

export interface OrcaAgent {
  paneKey: string;
  /** working / blocked / waiting / done（Orca の AGENT_STATUS_STATES） */
  state: string;
  agentType?: string;
  /** 実行中・承認待ちのツール名（Orca が 60 字で切る）。承認待ちと質問待ちの区別に使う */
  toolName?: string;
  updatedAt: number;
}

export interface OrcaWorktree {
  path: string;
  worktreeId?: string;
  agents: OrcaAgent[];
  /** 生きているターミナル数（Orca の liveTerminalCount）。項目が無い版は undefined */
  liveTerminals?: number;
}

type CliResult = { ok: true; result: unknown } | { ok: false; code: string; message: string };

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/**
 * CLI の JSON 出力を解釈する。出力全体（プロンプトやターミナル内容のプレビューを含む）はログに出さず、
 * 失敗時は error.code だけを返す
 */
export function parseCliOutput(stdout: string): CliResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, code: "invalid_output", message: "Orca CLI の出力を解釈できません" };
  }
  const root = rec(parsed);
  if (root?.ok === true) return { ok: true, result: root.result };
  const code = str(rec(root?.error)?.code) ?? "unknown_error";
  return { ok: false, code, message: `Orca CLI がエラーを返しました（${code}）` };
}

/** CLI を 1 回実行する（--json 付き・ウィンドウ非表示）。失敗は例外にせず CliResult で返す */
export function runOrcaCli(args: string[], timeoutMs: number = CLI_TIMEOUT_MS, deps: OrcaDeps = nativeDeps): Promise<CliResult> {
  const cli = resolveOrcaCli(deps);
  if (cli === null) {
    return Promise.resolve({ ok: false, code: "cli_not_found", message: "Orca の CLI（orca.exe）が見つかりません" });
  }
  return new Promise((resolve) => {
    execFile(cli, [...args, "--json"], { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      const out = String(stdout ?? "");
      if (out.trim() !== "") {
        resolve(parseCliOutput(out));
        return;
      }
      const killed = error !== null && (error as { killed?: boolean }).killed === true;
      resolve({
        ok: false,
        code: killed ? "timeout" : "no_output",
        message: killed ? "Orca CLI が応答しません（タイムアウト）" : "Orca CLI から応答がありません",
      });
    });
  });
}

export function parseTerminals(result: unknown): OrcaTerminal[] {
  const list = rec(result)?.terminals;
  if (!Array.isArray(list)) return [];
  const out: OrcaTerminal[] = [];
  for (const item of list) {
    const t = rec(item);
    if (t === undefined || t.connected === false || t.orphaned === true) continue;
    const handle = str(t.handle);
    const tabId = str(t.tabId);
    const leafId = str(t.leafId);
    if (handle === undefined || tabId === undefined || leafId === undefined) continue;
    const worktreePath = typeof t.worktreePath === "string" ? t.worktreePath : "";
    out.push({ handle, worktreePath, worktreeId: str(t.worktreeId), tabId, leafId, agentIdentity: str(t.agentIdentity) });
  }
  return out;
}

export function parseWorktrees(result: unknown): OrcaWorktree[] {
  const list = rec(result)?.worktrees;
  if (!Array.isArray(list)) return [];
  const out: OrcaWorktree[] = [];
  for (const item of list) {
    const w = rec(item);
    const p = str(w?.path);
    if (w === undefined || p === undefined || w.isArchived === true) continue;
    const agents: OrcaAgent[] = [];
    for (const a of Array.isArray(w.agents) ? w.agents : []) {
      const r = rec(a);
      const paneKey = str(r?.paneKey);
      const state = str(r?.state);
      if (r === undefined || paneKey === undefined || state === undefined) continue;
      const toolName = str(r.toolName);
      agents.push({
        paneKey, state, agentType: str(r.agentType),
        ...(toolName !== undefined ? { toolName } : {}),
        updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
      });
    }
    const live = w.liveTerminalCount;
    const worktreeId = str(w.worktreeId);
    out.push({
      path: p,
      ...(worktreeId !== undefined ? { worktreeId } : {}),
      agents,
      ...(typeof live === "number" ? { liveTerminals: live } : {}),
    });
  }
  return out;
}

/**
 * Orca でターミナルが開いているフォルダ（正規化済み）。未接続判定に使う。
 * Orca のサイドバーに登録されているだけでターミナルの無いフォルダは含めない
 * （クリックしても切り替え先のタブが無い = 「立ち上げる」で作るべき状態のため）。
 * liveTerminalCount を返さない版はフォルダがあるだけで含める
 */
export function orcaWorktreePathSet(worktrees: readonly OrcaWorktree[]): Set<string> {
  return new Set(worktrees.filter((w) => w.liveTerminals === undefined || w.liveTerminals > 0).map((w) => normalizePath(w.path)));
}

/**
 * Orca でスリープ中のフォルダ（正規化済み。261005_4）。Orca の「スリープ」は専用の記録を持たず、
 * そのワークスペースのターミナルを全部閉じる操作のため、「登録済みで生きているターミナルが 0」をスリープ中とみなす。
 * liveTerminalCount を返さない版は判定できないので含めない
 */
export function orcaSleepingPathSet(worktrees: readonly OrcaWorktree[]): Set<string> {
  return new Set(worktrees.filter((w) => w.liveTerminals === 0).map((w) => normalizePath(w.path)));
}

/**
 * Orca の hook 状態ファイルから「セッション ID → paneKey」を作る。
 * 読むのは providerSession.id と paneKey だけ（プロンプト等の本文は使わない）。
 * Orca 内部の形式のため、読めない・形が違う場合は空 Map（推定へフォールバック）
 */
export function parsePaneKeysBySession(json: string): Map<string, string> {
  const out = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return out;
  }
  const entries = rec(rec(parsed)?.entries);
  if (entries === undefined) return out;
  // 同じセッションが複数のペインに残る（別ペインで resume した等）ときは最新の記録を採り、
  // 同じペインを後から別のセッションが使ったときは、そのペインは最新のセッションだけのものにする
  const latestBySession = new Map<string, { paneKey: string; at: number }>();
  for (const value of Object.values(entries)) {
    const e = rec(value);
    const sessionId = str(rec(e?.providerSession)?.id);
    const paneKey = str(e?.paneKey);
    // 終了を記録したペインはもうそのセッションのものではない
    if (sessionId === undefined || paneKey === undefined || e?.hookEventName === "SessionEnd") continue;
    const at = typeof e?.receivedAt === "number" ? e.receivedAt : 0;
    const prev = latestBySession.get(sessionId);
    if (prev === undefined || at >= prev.at) latestBySession.set(sessionId, { paneKey, at });
  }
  const ownerByPane = new Map<string, { sessionId: string; at: number }>();
  for (const [sessionId, { paneKey, at }] of latestBySession) {
    const prev = ownerByPane.get(paneKey);
    if (prev === undefined || at >= prev.at) ownerByPane.set(paneKey, { sessionId, at });
  }
  for (const [paneKey, { sessionId }] of ownerByPane) out.set(sessionId, paneKey);
  return out;
}

export function readPaneKeysBySession(env: OrcaDeps["env"] = process.env): Map<string, string> {
  const file = orcaStatusFile(env);
  if (file === null) return new Map();
  try {
    return parsePaneKeysBySession(fs.readFileSync(file, "utf8"));
  } catch {
    return new Map();
  }
}

/** 押したタイルのセッション（分かる範囲） */
export interface OrcaSessionHint {
  /** SessionView.sessionId（Codex は "codex:" 接頭辞付き） */
  sessionId?: string;
  provider?: "claude" | "codex";
  state?: SessionState;
}

const paneOf = (t: OrcaTerminal): string => `${t.tabId}:${t.leafId}`;

/** SessionView.sessionId（Codex は "codex:" 接頭辞付き）→ Orca の providerSession.id */
export function rawSessionId(sessionId: string | undefined): string | undefined {
  const raw = sessionId?.replace(/^codex:/, "");
  return raw === undefined || raw === "" ? undefined : raw;
}

/**
 * セッション ID から Orca のターミナルを「正確に」特定する（状態ファイルの session → paneKey が引けたときだけ）。
 * 入力の送信はこれで特定できたターミナルにしか行わない（推定で選んだ別のエージェントへ送る事故を防ぐ）
 */
export function findExactTerminal(
  terminals: readonly OrcaTerminal[],
  paneBySession: ReadonlyMap<string, string>,
  sessionId: string | undefined,
): OrcaTerminal | null {
  const raw = rawSessionId(sessionId);
  const pane = raw === undefined ? undefined : paneBySession.get(raw);
  return (pane === undefined ? undefined : terminals.find((t) => paneOf(t) === pane)) ?? null;
}

/**
 * 入力を送ってよいターミナル: セッション ID で正確に特定でき、かつ今もそのペインで同じ種類のエージェントが
 * 動いている（terminal list の agentIdentity）。エージェントを /exit した後のペインは素のシェルに戻っており、
 * そこへ返信を送るとコマンドとして実行されるため送らない
 */
export function findSendableTerminal(
  terminals: readonly OrcaTerminal[],
  paneBySession: ReadonlyMap<string, string>,
  sessionId: string | undefined,
  provider: "claude" | "codex",
): OrcaTerminal | null {
  const exact = findExactTerminal(terminals, paneBySession, sessionId);
  return exact !== null && exact.agentIdentity === provider ? exact : null;
}

/** 本アプリの状態 → Orca のエージェント状態（working / waiting / done 等）の対応 */
function agentStateMatches(state: SessionState | undefined, agentState: string): boolean {
  if (state === "running") return agentState === "working";
  if (state === "confirm") return agentState === "waiting" || agentState === "permission";
  if (state === "done") return agentState === "done";
  return false;
}

/**
 * 切り替え先のターミナルを選ぶ（純関数）。
 * 1. セッション ID → paneKey が引ければ、そのペインのターミナル（フォルダを問わない）
 * 2. 登録フォルダのターミナルのうち、同じ種類（claude / codex）で状態が一致するエージェントのペイン
 * 3. 同じ種類のエージェントが居るペイン（更新が新しい順）→ 同じ種類のターミナル → フォルダの先頭
 * フォルダのターミナルが無ければ null
 */
export function pickOrcaTerminal(input: {
  terminals: readonly OrcaTerminal[];
  worktrees: readonly OrcaWorktree[];
  paneBySession: ReadonlyMap<string, string>;
  projectPath: string;
  hint?: OrcaSessionHint;
}): OrcaTerminal | null {
  const { terminals, worktrees, paneBySession, projectPath, hint } = input;
  const exact = findExactTerminal(terminals, paneBySession, hint?.sessionId);
  if (exact !== null) return exact;
  const projN = normalizePath(projectPath);
  const folderWorktrees = worktrees.filter((w) => normalizePath(w.path) === projN);
  // git 管理外のフォルダ（folder-workspace）はターミナル側の worktreePath が空のため worktreeId でも照合する
  const folderIds = new Set(folderWorktrees.flatMap((w) => (w.worktreeId !== undefined ? [w.worktreeId] : [])));
  const inFolder = terminals.filter((t) =>
    (t.worktreePath !== "" && normalizePath(t.worktreePath) === projN) || (t.worktreeId !== undefined && folderIds.has(t.worktreeId)));
  if (inFolder.length === 0) return null;
  const agents = folderWorktrees.flatMap((w) => w.agents);
  const provider = hint?.provider ?? "claude";
  const sameKind = agents
    .filter((a) => a.agentType === undefined || a.agentType === provider)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const byPane = (a: OrcaAgent): OrcaTerminal | undefined => inFolder.find((t) => paneOf(t) === a.paneKey);
  for (const a of sameKind.filter((x) => agentStateMatches(hint?.state, x.state))) {
    const t = byPane(a);
    if (t !== undefined) return t;
  }
  for (const a of sameKind) {
    const t = byPane(a);
    if (t !== undefined) return t;
  }
  return inFolder.find((t) => t.agentIdentity === provider) ?? inFolder[0];
}

/** 一覧の取得上限。CLI は既定で件数を打ち切ることがあるため明示する */
const LIST_LIMIT = "1000";

/** CLI の一覧が打ち切られていたら true（欠けた一覧で未接続と判定しない） */
export function isTruncated(result: unknown): boolean {
  return rec(result)?.truncated === true;
}

/** Orca で開いているフォルダ一覧。CLI 失敗時・一覧が打ち切られたときは null（呼び出し側で「判定不能」扱い） */
export async function fetchOrcaWorktrees(): Promise<OrcaWorktree[] | null> {
  const r = await runOrcaCli(["worktree", "ps", "--limit", LIST_LIMIT]);
  return r.ok && !isTruncated(r.result) ? parseWorktrees(r.result) : null;
}

export interface OrcaOutcome {
  ok: boolean;
  message?: string;
}

/**
 * 押したタイルのセッションが動いている Orca 内のタブへ切り替える。
 * 窓の前面化は呼び出し側（window-control）が先に済ませる（クリック直後でないと前面化権限が無いため）
 */
export async function switchOrcaTerminal(
  projectPath: string,
  hint?: OrcaSessionHint,
  /** 後から別のタイルが押されたら false（古い要求で最後の選択を上書きしない） */
  isCurrent: () => boolean = () => true,
): Promise<OrcaOutcome & { superseded?: boolean }> {
  const [terms, wts] = await Promise.all([
    runOrcaCli(["terminal", "list", "--limit", LIST_LIMIT]),
    runOrcaCli(["worktree", "ps", "--limit", LIST_LIMIT]),
  ]);
  if (!isCurrent()) return { ok: false, superseded: true };
  if (!terms.ok) return { ok: false, message: terms.message };
  const target = pickOrcaTerminal({
    terminals: parseTerminals(terms.result),
    worktrees: wts.ok ? parseWorktrees(wts.result) : [],
    paneBySession: readPaneKeysBySession(),
    projectPath,
    hint,
  });
  if (target === null) return { ok: false, message: "Orca にこのフォルダのターミナルがありません" };
  const r = await runOrcaCli(["terminal", "switch", "--terminal", target.handle]);
  return r.ok ? { ok: true } : { ok: false, message: r.message };
}

/** Orca の selector 用パス（Orca は C:/dev/app 形式で保持している） */
function orcaPath(projectPath: string): string {
  return projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * 立ち上げ: このフォルダで Orca のターミナルを作り、そのタブを表示する。
 * Orca が閉じていれば `orca open` で起動を待ち、フォルダが Orca 未登録なら `repo add` してから作る
 */
export async function launchInOrca(projectPath: string): Promise<OrcaOutcome> {
  const selector = `path:${orcaPath(projectPath)}`;
  const create = (): Promise<CliResult> => runOrcaCli(["terminal", "create", "--worktree", selector, "--focus"], 20_000);
  const status = await runOrcaCli(["status"]);
  const running = status.ok && rec(rec(status.result)?.runtime)?.reachable === true;
  if (!running) {
    const opened = await runOrcaCli(["open"], OPEN_TIMEOUT_MS);
    if (!opened.ok) return { ok: false, message: `Orca を起動できませんでした（${opened.code}）` };
  }
  let r = await create();
  if (!r.ok && r.code === "selector_not_found") {
    const added = await runOrcaCli(["repo", "add", "--path", projectPath], 20_000);
    if (!added.ok) return { ok: false, message: `Orca にこのフォルダを追加できませんでした（${added.code}）` };
    r = await create();
  }
  return r.ok ? { ok: true } : { ok: false, message: `Orca でターミナルを開けませんでした（${r.code}）` };
}

/* ---------------- 画面プレビュー・返信・中断・承認待ち（261005_2） ---------------- */

/** プレビューの最大行数（Orca の画面は 60 行前後。末尾の入力欄・ステータス行まで含めて見せる） */
export const SCREEN_MAX_LINES = 40;
/** 1 回の返信の最大文字数 */
const REPLY_MAX_CHARS = 4000;

/** `terminal read --screen` の結果から行を取り出す（行末の空白と末尾の空行は除く） */
export function parseScreenLines(result: unknown, maxLines: number = SCREEN_MAX_LINES): string[] {
  const tail = rec(rec(result)?.terminal)?.tail;
  if (!Array.isArray(tail)) return [];
  const lines = tail.map((l) => (typeof l === "string" ? l.replace(/\s+$/, "") : ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-maxLines);
}

export interface OrcaScreen {
  ok: boolean;
  message?: string;
  lines?: string[];
  /**
   * セッション ID でターミナルを正確に特定できたか。false はフォルダと状態から推定したターミナル
   * （表示はするが、返信・中断は送らない）
   */
  exact?: boolean;
}

/** 押したタイルのセッションが動いている Orca ターミナルの画面を読む（読み取りのみ） */
/** 一覧の使い回し時間。プレビューとパネルの更新が重なっても CLI を 1 組しか起動しない */
const LISTS_CACHE_MS = 1_500;
let listsCache: { at: number; value: Promise<[CliResult, CliResult]> } | null = null;

function terminalAndWorktreeLists(now: number = Date.now()): Promise<[CliResult, CliResult]> {
  if (listsCache !== null && now - listsCache.at < LISTS_CACHE_MS) return listsCache.value;
  const value = Promise.all([
    runOrcaCli(["terminal", "list", "--limit", LIST_LIMIT]),
    runOrcaCli(["worktree", "ps", "--limit", LIST_LIMIT]),
  ]);
  listsCache = { at: now, value };
  return value;
}

export async function readOrcaScreen(projectPath: string, hint?: OrcaSessionHint): Promise<OrcaScreen> {
  const [terms, wts] = await terminalAndWorktreeLists();
  if (!terms.ok) return { ok: false, message: terms.message };
  const terminals = parseTerminals(terms.result);
  const paneBySession = readPaneKeysBySession();
  const exact = findExactTerminal(terminals, paneBySession, hint?.sessionId);
  const target = exact ?? pickOrcaTerminal({
    terminals, worktrees: wts.ok ? parseWorktrees(wts.result) : [], paneBySession, projectPath, hint,
  });
  if (target === null) return { ok: false, message: "Orca にこのフォルダのターミナルがありません" };
  const r = await runOrcaCli(["terminal", "read", "--terminal", target.handle, "--screen"]);
  if (!r.ok) return { ok: false, message: r.message };
  // 送信できるか（= sendToOrcaSession と同じ判定）を返し、パネルの入力欄の有効・無効に使う
  const sendable = findSendableTerminal(terminals, paneBySession, hint?.sessionId, hint?.provider ?? "claude");
  return { ok: true, lines: parseScreenLines(r.result), exact: sendable !== null && sendable.handle === target.handle };
}

/** 返信テキストの整形。1 行にまとめ（改行は TUI で途中送信になるため）、制御文字を除く。空なら null */
export function sanitizeReplyText(text: string): string | null {
  // eslint-disable-next-line no-control-regex
  const one = text.replace(/[\r\n]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return one === "" ? null : one.slice(0, REPLY_MAX_CHARS);
}

export type OrcaInput = { kind: "text"; text: string } | { kind: "escape" };

/**
 * セッションのターミナルへ入力を送る（返信・中断）。セッション ID で正確に特定できたときだけ送る。
 * 中断は Esc（Claude Code / Codex の中断キー）。`terminal send --interrupt` は Ctrl+C で、
 * 2 回でエージェント自体が終了するため使わない
 */
export async function sendToOrcaSession(
  sessionId: string | undefined,
  input: OrcaInput,
  provider: "claude" | "codex" = "claude",
): Promise<OrcaOutcome> {
  if (rawSessionId(sessionId) === undefined) return { ok: false, message: "送信先のセッションがありません" };
  let args: string[];
  if (input.kind === "text") {
    const text = sanitizeReplyText(input.text);
    if (text === null) return { ok: false, message: "送信する内容が空です" };
    // `--text=値` の形で渡す。`--text 値` だと、値が "--" で始まる返信（例: 「--no-verify で」）を
    // Orca の CLI がフラグとして解釈し、最悪 --interrupt（Ctrl+C）が立つ
    args = [`--text=${text}`, "--enter", "--wait-submit", "5"];
  } else {
    args = ["--text=\x1b"];
  }
  const terms = await runOrcaCli(["terminal", "list", "--limit", LIST_LIMIT]);
  if (!terms.ok) return { ok: false, message: terms.message };
  const target = findSendableTerminal(parseTerminals(terms.result), readPaneKeysBySession(), sessionId, provider);
  if (target === null) {
    return { ok: false, message: "このセッションの Orca ターミナルを特定できないため送信しません（Orca で直接入力してください）" };
  }
  const r = await runOrcaCli(["terminal", "send", "--terminal", target.handle, ...args], 15_000);
  return r.ok ? { ok: true } : { ok: false, message: r.message };
}

/** 変更ファイルを Orca で差分表示する（Orca の表示はそのフォルダへ切り替わる） */
export async function openChangedInOrca(projectPath: string): Promise<OrcaOutcome> {
  const r = await runOrcaCli(["file", "open-changed", "--mode", "diff", "--worktree", `path:${orcaPath(projectPath)}`, "--focus"], 15_000);
  return r.ok ? { ok: true } : { ok: false, message: `Orca で変更ファイルを開けませんでした（${r.code}）` };
}

/** Orca のエージェント状態（paneKey → 状態）。worktree ps の一覧から作る */
export function agentsByPane(worktrees: readonly OrcaWorktree[]): Map<string, OrcaAgent> {
  return new Map(worktrees.flatMap((w) => w.agents.map((a) => [a.paneKey, a] as const)));
}

/**
 * Codex の承認待ち・質問待ちを Orca の状態で補う。Codex の履歴 DB では「実行中」のままでも、
 * Orca は承認要求（PermissionRequest hook）でペインを waiting にする。実行中の Codex セッションで、
 * Orca の同じペインが waiting / blocked なら「確認待ち」にする（それ以外は変えない）
 */
export function applyOrcaCodexConfirm(
  views: readonly SessionView[],
  paneBySession: ReadonlyMap<string, string>,
  agents: ReadonlyMap<string, OrcaAgent>,
): SessionView[] {
  return views.map((v) => {
    if (v.provider !== "codex" || v.state !== "running") return v;
    const raw = rawSessionId(v.sessionId);
    const pane = raw === undefined ? undefined : paneBySession.get(raw);
    const agent = pane === undefined ? undefined : agents.get(pane);
    if (agent === undefined || (agent.state !== "waiting" && agent.state !== "blocked")) return v;
    const question = agent.toolName !== undefined && /question|ask|request_user_input/i.test(agent.toolName);
    const next: SessionView = { ...v, state: "confirm", confirmKind: question ? "question" : "permission" };
    delete next.runningSince;
    return next;
  });
}
