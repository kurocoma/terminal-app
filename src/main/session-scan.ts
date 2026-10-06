/**
 * 再接続（260712_2）: プロジェクトの Claude Code transcript ディレクトリを走査し、
 * 「直近まで動いていた」セッションを見つけて復元候補として返す。
 *
 * transcript の場所: %USERPROFILE%\.claude\projects\<munge(プロジェクトパス)>\<sessionId>.jsonl
 * munge 規則 = 英数字以外を "-" へ置換（実ディレクトリ 2026-07-12 実測:
 * C:\Users\hppym\dev\terminal-app → C--Users-hppym-dev-terminal-app）。
 * munge は情報を落とす（日本語名は全て "-" になる）ため、JSONL 内の cwd フィールドで
 * 「本当にこのプロジェクトのセッションか」を必ず裏取りする。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TRANSCRIPT_STALE_HARD_MS, type BlockedStop } from "./liveness-monitor";
import { extractWorkText, normalizePath } from "./state-store";

/**
 * transcript がこの時間以内に更新されていれば「動作中」として復元対象にする（260712_7）。
 * 切断検知の HARD 閾値（ウィンドウが残っていても切断とみなす基準。liveness-monitor.ts）に
 * バッファを足した値にする。旧実装は切断検知の TRANSCRIPT_STALE_MS（3分）と対称にしていたが、
 * ウィンドウが残っている限り実際の切断判定は HARD 側の 15 分ルートを通るため、
 * 「切断」と表示された時点で transcript は必ず HARD 閾値ぶん無更新済みで、再接続の窓が
 * 常に手遅れになっていた（実測: product-register, 2026-07-12 08:06 切断 → 08:07 再接続失敗）。
 */
export const RECONNECT_ACTIVE_MS = TRANSCRIPT_STALE_HARD_MS + 5 * 60_000;

/** transcript 末尾の走査量。直近のレコードから cwd 検証と workText 抽出ができれば足りる */
const TAIL_BYTES = 256 * 1024;

export interface LiveSessionInfo {
  sessionId: string;
  transcriptPath: string;
  mtimeMs: number;
  workText?: string;
  /** transcript 終端の分類（260712_4）。concluded なら「実行中」ではなく「完了」で復元する */
  turnEnd: TurnEndState;
}

/**
 * transcript 終端の分類（260712_4）:
 * - concluded = 直近のターンは終わっている（正常完了またはユーザー割り込み）
 * - open      = ターン進行中（または開始直後）
 * - unknown   = 判定材料なし（安全側 = 完了扱いしない）
 */
export type TurnEndState = "concluded" | "open" | "unknown";

/** 割り込み時に transcript へ記録されるマーカー（2026-07-12 実測: "[Request interrupted by user for tool use]" 等） */
const INTERRUPT_MARKER = "[Request interrupted";

/** レコード先頭の text（string content または最初の text ブロック）。無ければ undefined */
function firstTextOf(rec: Record<string, unknown>): string | undefined {
  const message = rec.message as Record<string, unknown> | undefined;
  if (message === undefined || message === null || typeof message !== "object") return undefined;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const block = content.find(
      (b: unknown): b is { type: string; text: string } =>
        b !== null && typeof b === "object" && (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string"
    );
    return block?.text;
  }
  return undefined;
}

/**
 * 終端分類の本体。入力は「新しい順」のレコード列（tailRecords の返却順）。
 *
 * 判定は user / assistant / system{stop_hook_summary, turn_duration} のみで行い、他はスキップする —
 * 末尾には attachment・queue-operation・permission-mode・mode・ai-title・last-prompt・
 * system{local_command} 等のメタレコードが混ざる（2026-07-12 実測）。未知の型のスキップは安全:
 * 誤って concluded を返す方向には倒れない（決定はレコードの意味が確定している型のみで行う）。
 * - 正常完了: 最終 assistant の直後に system{stop_hook_summary}→{turn_duration} が書かれる（実測）
 * - 割り込み（Esc）: Stop hook は発火せず user("[Request interrupted…]") が終端に残る（実測）
 * - 進行中: user(tool_result) / assistant が終端側に来る
 */
export function classifyTurnEnd(records: ReadonlyArray<Record<string, unknown>>): TurnEndState {
  let sawTurnDuration = false;
  for (const rec of records) {
    const type = rec.type;
    if (type === "system") {
      const sub = (rec as { subtype?: unknown }).subtype;
      if (sub === "stop_hook_summary") {
        // 260907_1 R5: Stop hook が {"decision":"block"} を返した（preventedContinuation=true。2026-09-07 実測の
        // フィールド）なら Claude はこの直後に続行する = ターン継続。通常の Stop（false・旧形状で欠落）は完了
        return (rec as { preventedContinuation?: unknown }).preventedContinuation === true ? "open" : "concluded";
      }
      if (sub === "turn_duration") {
        // turn_duration 単独では決めない — 直後（古い側）の stop_hook_summary が block かどうかで結果が変わる。
        // summary が書かれない環境（Stop hook 未設定）向けに、次の user/assistant で concluded に倒す
        sawTurnDuration = true;
      }
      continue; // local_command 等の system メタはスキップ
    }
    if (type === "user") {
      if (sawTurnDuration) return "concluded";
      const text = firstTextOf(rec);
      if (text !== undefined && text.trim().startsWith(INTERRUPT_MARKER)) return "concluded";
      return "open"; // プロンプト・tool_result はターン開始直後/進行中
    }
    if (type === "assistant") return sawTurnDuration ? "concluded" : "open"; // 生成直後・ツール実行直前（完了なら直後に system が続く）
  }
  return sawTurnDuration ? "concluded" : "unknown";
}

/** ファイルパスから終端分類する（掃引用。読めなければ unknown = 安全側） */
export function turnEndOf(filePath: string): TurnEndState {
  return classifyTurnEnd(tailRecords(filePath));
}

/**
 * block された Stop の痕跡（260907_1 R2）。入力は「新しい順」のレコード列。
 * 最新の stop_hook_summary が preventedContinuation=true かつ timestamp が sinceMs 以降なら、その時刻と
 * stopReason（block 理由 = 例「[Eval-loop iteration 1/4 | RESUME 1/3] …」）を返す。
 * 最新の summary が通常の Stop なら、それより古い block があっても null（前のターンの痕跡を拾わない）。
 * timestamp が無い・読めない block も null（安全側 = 復帰させない）。
 */
export function findBlockedStop(records: ReadonlyArray<Record<string, unknown>>, sinceMs: number): BlockedStop | null {
  for (const rec of records) {
    if (rec.type !== "system" || (rec as { subtype?: unknown }).subtype !== "stop_hook_summary") continue;
    if ((rec as { preventedContinuation?: unknown }).preventedContinuation !== true) return null;
    const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : Number.NaN;
    if (!Number.isFinite(ts) || ts < sinceMs) return null;
    const reason = (rec as { stopReason?: unknown }).stopReason;
    return { at: ts, reason: typeof reason === "string" ? reason : "" };
  }
  return null;
}

/** ファイルパスから block 痕跡を探す（掃引・Stop 後の前倒し判定用。読めなければ null） */
export function blockedStopOf(filePath: string, sinceMs: number): BlockedStop | null {
  return findBlockedStop(tailRecords(filePath), sinceMs);
}

/**
 * セッションの「最後に活動した時刻」（260907_1 R3/R4）= 本体 transcript と subagent 記録の新しい方の mtime。
 * 同期 fork（background:false の Skill）の間、本体 <sessionId>.jsonl は更新されず
 * <dir>/<sessionId>/subagents/agent-*.jsonl だけが書かれる（2026-09-07 Monthly-report で実測）ため、
 * 本体 mtime だけで無更新を判定すると「切断」に誤判定する。
 * 本体が無い（stat 失敗）ときは null（従来どおり判定しない）。subagents の .jsonl 以外（meta.json）は見ない。
 */
export function activityMtimeMs(transcriptPath: string): number | null {
  let latest: number;
  try {
    latest = fs.statSync(transcriptPath).mtimeMs;
  } catch {
    return null;
  }
  const base = transcriptPath.endsWith(".jsonl") ? transcriptPath.slice(0, -".jsonl".length) : transcriptPath;
  const subDir = path.join(base, "subagents");
  let names: string[];
  try {
    names = fs.readdirSync(subDir);
  } catch {
    return latest; // subagent 記録なし
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const m = fs.statSync(path.join(subDir, name)).mtimeMs;
      if (m > latest) latest = m;
    } catch {
      /* 個別の stat 失敗は無視 */
    }
  }
  return latest;
}

export function mungeProjectPath(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, "-");
}

export function transcriptDirFor(projectPath: string, homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".claude", "projects", mungeProjectPath(projectPath));
}

/** cwd がプロジェクト配下か（サブディレクトリ起動も同一プロジェクト扱い。matchProjectByCwd と同じ規則） */
function cwdBelongsTo(cwd: string, projectPath: string): boolean {
  const cwdN = normalizePath(cwd);
  const projN = normalizePath(projectPath);
  return cwdN === projN || cwdN.startsWith(projN + "\\");
}

/** JSONL 末尾チャンクを行単位でパースし、新しい順に返す（先頭行はチャンク境界で欠けうるため parse 失敗は捨てる） */
export function tailRecords(filePath: string, tailBytes: number = TAIL_BYTES): Array<Record<string, unknown>> {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const readLen = Math.min(size, tailBytes);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, size - readLen);
    const lines = buf.toString("utf8").split("\n");
    const records: Array<Record<string, unknown>> = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          records.push(parsed as Record<string, unknown>);
        }
      } catch {
        /* チャンク境界の欠け行・破損行はスキップ */
      }
    }
    return records;
  } catch {
    return [];
  } finally {
    fs.closeSync(fd);
  }
}

/** user レコードから表示用テキストを取り出す（tool_result・メタ・コマンド枠 <...> は対象外） */
function userTextOf(rec: Record<string, unknown>): string | undefined {
  if (rec.type !== "user" || rec.isMeta === true) return undefined;
  const message = rec.message as Record<string, unknown> | undefined;
  if (message === undefined || message === null || typeof message !== "object") return undefined;
  const content = message.content;
  let text: string | undefined;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const block = content.find(
      (b: unknown): b is { type: string; text: string } =>
        b !== null && typeof b === "object" && (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string"
    );
    text = block?.text;
  }
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  // <command-name> 等のシステム枠・キャベット文はユーザーの依頼文ではないため除外
  if (trimmed === "" || trimmed.startsWith("<") || trimmed.startsWith("Caveat:")) return undefined;
  return trimmed;
}

/**
 * プロジェクトの transcript ディレクトリから「直近 activeMs 以内に更新された」セッションを列挙する。
 * - agent-*.jsonl（サブエージェント記録）とサブディレクトリは対象外
 * - JSONL 内の cwd がプロジェクト配下であることを検証できたものだけ返す（munge の衝突対策）
 * - 更新が新しい順に返す
 */
export function scanLiveSessions(
  projectPath: string,
  opts?: { homeDir?: string; now?: number; activeMs?: number }
): LiveSessionInfo[] {
  const dir = transcriptDirFor(projectPath, opts?.homeDir);
  const now = opts?.now ?? Date.now();
  const activeMs = opts?.activeMs ?? RECONNECT_ACTIVE_MS;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // ディレクトリ無し = このプロジェクトの transcript がまだ無い
  }

  const found: LiveSessionInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.startsWith("agent-")) continue;
    const filePath = path.join(dir, entry.name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs > activeMs) continue; // 更新が止まって久しい = 動作中とみなさない

    const records = tailRecords(filePath);
    // cwd の裏取り: 末尾側の直近レコードに cwd があり、プロジェクト配下であること
    const cwdRec = records.find((r) => typeof r.cwd === "string");
    if (cwdRec === undefined || !cwdBelongsTo(cwdRec.cwd as string, projectPath)) continue;

    let workText: string | undefined;
    for (const rec of records) {
      const text = userTextOf(rec);
      if (text !== undefined) {
        workText = extractWorkText(text);
        break;
      }
    }
    found.push({
      sessionId: entry.name.slice(0, -".jsonl".length),
      transcriptPath: filePath,
      mtimeMs,
      workText,
      turnEnd: classifyTurnEnd(records),
    });
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/* ---------------- Jev 判定の材料（260922_2） ---------------- */

/** レコードの message.content をブロック配列として返す（string content は text ブロック 1 つに正規化） */
function contentBlocksOf(rec: Record<string, unknown>): Array<Record<string, unknown>> {
  const message = rec.message as Record<string, unknown> | undefined;
  if (message === undefined || message === null || typeof message !== "object") return [];
  const content = message.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Record<string, unknown> => b !== null && typeof b === "object");
}

/** tool_result の content（string または text ブロック配列）を 1 本の文字列に */
function toolResultTextOf(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: unknown) => (b !== null && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
      .filter((t) => t !== "")
      .join("\n");
  }
  return "";
}

/**
 * 最後の assistant 返答の本文（新しい順に見て最初に text ブロックを持つ assistant レコード）。
 * 1 ターンの最後の返答は複数レコードに分かれることがあるため、同じ message.id の text を古い順に連結する。
 * 返答待ち判定（jev-judge.pendingQuestion）の材料。読めなければ undefined
 */
export function lastAssistantTextOf(filePath: string): string | undefined {
  return lastAssistantTextFrom(tailRecords(filePath));
}

/** lastAssistantTextOf の本体（入力は「新しい順」のレコード列。テスト用に分離） */
export function lastAssistantTextFrom(recordsNewestFirst: ReadonlyArray<Record<string, unknown>>): string | undefined {
  let messageId: string | undefined;
  const parts: string[] = [];
  for (const rec of recordsNewestFirst) {
    if (rec.type !== "assistant") {
      if (messageId !== undefined) break; // 対象メッセージの前に別種のレコードが来たら終わり
      // 直近が user（新しいプロンプト・tool_result）なら「最後の返答」はもう古い材料。呼び出し側の時刻判定に委ねる
      continue;
    }
    const id = ((rec.message as Record<string, unknown> | undefined)?.id as string | undefined) ?? "";
    if (messageId === undefined) messageId = id;
    else if (id !== messageId) break;
    const texts = contentBlocksOf(rec)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string);
    if (texts.length > 0) parts.unshift(texts.join("\n"));
  }
  const joined = parts.join("\n").trim();
  return joined === "" ? undefined : joined;
}

export interface ToolUseRecord {
  name: string;
  /** JSON.stringify(input)。長い引数は maxChars で切り詰める */
  input: string;
}

/**
 * 最後の assistant tool_use（許可待ちのツール呼び出し。新しい順に見て最初に見つかるもの）。
 * 危険度判定（jev-judge.danger）の材料。無ければ undefined
 */
export function lastToolUseOf(filePath: string, maxChars = 3_000): ToolUseRecord | undefined {
  return lastToolUseFrom(tailRecords(filePath), maxChars);
}

export function lastToolUseFrom(recordsNewestFirst: ReadonlyArray<Record<string, unknown>>, maxChars = 3_000): ToolUseRecord | undefined {
  for (const rec of recordsNewestFirst) {
    if (rec.type !== "assistant") continue;
    const blocks = contentBlocksOf(rec);
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.type !== "tool_use" || typeof b.name !== "string") continue;
      let input: string;
      try {
        input = JSON.stringify(b.input ?? {});
      } catch {
        input = "{}";
      }
      return { name: b.name, input: input.length > maxChars ? `${input.slice(0, maxChars)}…` : input };
    }
  }
  return undefined;
}

export interface TranscriptStep {
  kind: "tool_use" | "tool_result" | "text";
  text: string;
  error?: boolean;
}

/**
 * 直近の手順（tool_use / tool_result / assistant text）を古い順に最大 maxSteps 件。
 * 停滞判定（jev-judge.stall）の材料。tool_use は「名前 + 主要引数」、tool_result は先頭の抜粋、
 * text は返答の抜粋。thinking・メタレコードは含めない
 */
export function recentStepsOf(filePath: string, maxSteps = 16, excerptChars = 300): TranscriptStep[] {
  return recentStepsFrom(tailRecords(filePath), maxSteps, excerptChars);
}

export function recentStepsFrom(recordsNewestFirst: ReadonlyArray<Record<string, unknown>>, maxSteps = 16, excerptChars = 300): TranscriptStep[] {
  const out: TranscriptStep[] = []; // 新しい順に積んで最後に反転
  const clip = (s: string): string => {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > excerptChars ? `${t.slice(0, excerptChars)}…` : t;
  };
  for (const rec of recordsNewestFirst) {
    if (out.length >= maxSteps) break;
    if (rec.type === "assistant") {
      const blocks = contentBlocksOf(rec);
      for (let i = blocks.length - 1; i >= 0 && out.length < maxSteps; i--) {
        const b = blocks[i];
        if (b.type === "tool_use" && typeof b.name === "string") {
          let input = "";
          try {
            input = JSON.stringify(b.input ?? {});
          } catch {
            input = "";
          }
          out.push({ kind: "tool_use", text: clip(`${b.name} ${input}`) });
        } else if (b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") {
          out.push({ kind: "text", text: clip(b.text) });
        }
      }
    } else if (rec.type === "user" && rec.isMeta !== true) {
      const blocks = contentBlocksOf(rec);
      for (let i = blocks.length - 1; i >= 0 && out.length < maxSteps; i--) {
        const b = blocks[i];
        if (b.type !== "tool_result") continue;
        out.push({ kind: "tool_result", text: clip(toolResultTextOf(b)), error: b.is_error === true });
      }
    }
  }
  return out.reverse();
}

/* ---------------- 起動時復元の対象選定（260922_3） ---------------- */

/**
 * 走査で見つかったセッションのうち復元するものを選ぶ（起動時復元・再接続で共通）。
 * - 登録簿でプロセスが生きている（alive）セッションは、transcript の更新が古くても復元する
 *   （質問して止まったまま何時間も待っているセッションを拾うため）
 * - 登録簿に無い（dead）セッションは復元しない（ターミナルを閉じた古い transcript）
 * - 登録簿が読めない（unknown）ときだけ、従来どおり更新が fallbackActiveMs 以内のものを復元する
 */
export function selectRestorable<T extends { sessionId: string; mtimeMs: number }>(
  found: readonly T[],
  liveness: (sessionId: string) => "alive" | "dead" | "unknown",
  now: number,
  fallbackActiveMs: number = RECONNECT_ACTIVE_MS
): T[] {
  return found.filter((s) => {
    const l = liveness(s.sessionId);
    if (l === "alive") return true;
    if (l === "dead") return false;
    return now - s.mtimeMs <= fallbackActiveMs;
  });
}

/**
 * subagent 記録（`<transcript のベース名>/subagents/agent-*.jsonl`）だけの最終更新時刻（260922_8）。
 * 本体 transcript は見ない — Stop の直後にも本体には後片付け（stop_hook_summary・turn_duration・メタ）が
 * 書かれるため、「完了したのに裏で作業が続いている」の判定材料には使えない。
 * 記録が無い・読めないときは null
 */
export function subagentMtimeMs(transcriptPath: string): number | null {
  const base = transcriptPath.endsWith(".jsonl") ? transcriptPath.slice(0, -".jsonl".length) : transcriptPath;
  const subDir = path.join(base, "subagents");
  let names: string[];
  try {
    names = fs.readdirSync(subDir);
  } catch {
    return null;
  }
  let latest: number | null = null;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const m = fs.statSync(path.join(subDir, name)).mtimeMs;
      if (latest === null || m > latest) latest = m;
    } catch {
      /* 個別の stat 失敗は無視 */
    }
  }
  return latest;
}

/**
 * Claude Code 自身が transcript に書く「このセッションのタスク名」（260922_10）。
 * `{"type":"ai-title","aiTitle":"確認待ち左上配置","sessionId":"…"}` の形で会話が進むたび追記される
 * （2026-09-22 実測: 1 セッションに 118 件。最新のものが現在のタスク）。
 * 生成コストゼロでセッション単位に出せるため、分割タイルでも「どのタイルが何をしているか」が分かる。
 * 見つからない・読めないときは undefined
 */
export function aiTitleOf(filePath: string): string | undefined {
  return aiTitleFrom(tailRecords(filePath));
}

/** aiTitleOf の本体（入力は「新しい順」のレコード列） */
export function aiTitleFrom(recordsNewestFirst: ReadonlyArray<Record<string, unknown>>): string | undefined {
  for (const rec of recordsNewestFirst) {
    if (rec.type !== "ai-title") continue;
    const title = rec.aiTitle;
    if (typeof title !== "string") continue;
    const trimmed = title.replace(/\s+/g, " ").trim();
    if (trimmed !== "") return trimmed;
  }
  return undefined;
}
