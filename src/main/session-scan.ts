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

/**
 * ローカルコマンド（/effort /model /clear 等。LLM のターンを起こさない）の痕跡（260909_1）。
 * 2026-09-09 実測: `<local-command-caveat>…` / `<command-name>/effort</command-name>…` / `<local-command-stdout>…` の
 * user レコード 3 件が並んで書かれる。ターン開始ではないので終端分類では読み飛ばす
 * （これを「open」と誤読すると、入力待ちのセッションが実行中扱いになり 15 分後に「切断」へ倒れる）
 */
function isLocalCommandRecord(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<local-command-") || t.startsWith("<command-name>") || t.startsWith("<command-message>");
}

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
      const text = firstTextOf(rec);
      if (text !== undefined && isLocalCommandRecord(text)) continue; // ローカルコマンドの痕跡はターンではない（260909_1）
      if (sawTurnDuration) return "concluded";
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
function tailRecords(filePath: string): Array<Record<string, unknown>> {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const readLen = Math.min(size, TAIL_BYTES);
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
