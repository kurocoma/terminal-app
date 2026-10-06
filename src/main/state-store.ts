/**
 * ② 状態ストア（design.md 5 章 / REQ-03, REQ-04, REQ-08, REQ-10）。
 * - イベント受信スキーマ検証（design.md 4.8）
 * - イベント → 4 状態マッピング（design.md 4.3 / 4.8）
 * - 状態遷移（design.md 5.1）・複数セッションの表示選定は「実行中」優先＋直近イベント
 *   （design.md 5.2 を 260712 課題A で改訂。preferForDisplay 参照）
 * - cwd → プロジェクト対応付け: 最長一致プレフィックス（design.md 4.7）
 * - セッション状態は揮発（アプリ再起動で全タイル「待機」へ。design.md 5.1）
 */
import { EventEmitter } from "events";
import type { Project, SessionState, SessionView, StatusCounts } from "../shared/types";

/**
 * 受理するイベント名（design.md 4.8）。UserPromptSubmit は自動追記対象（OPEN-04 案 A 採用）、
 * SessionEnd は受信側のみ対応（OPEN-03）。TaskCreated はタスク作成タイトルの取得経路（260712_3 —
 * 実 claude 2.1.207 の hook stdin ダンプで payload を実測確認済み）。
 */
export const ACCEPTED_EVENT_NAMES = ["Stop", "Notification", "UserPromptSubmit", "SessionEnd", "TaskCreated"] as const;
export type HookEventName = (typeof ACCEPTED_EVENT_NAMES)[number];

export interface HookEvent {
  hook_event_name: HookEventName;
  session_id: string;
  cwd: string;
  message?: string;
  reason?: string;
  transcript_path?: string;
  /** UserPromptSubmit のみ: 送信されたプロンプト本文（現在の作業テキストの実データ源。260712 課題B） */
  prompt?: string;
  /** TaskCreated のみ: 作成されたタスクの件名（作業テキストの実データ源。260712_3） */
  task_subject?: string;
}

/** SessionEnd の正常終了 reason（design.md 4.8。これ以外・欠落は「エラー相当」と判定する） */
export const NORMAL_END_REASONS = new Set(["clear", "logout", "prompt_input_exit", "exit"]);

export type ValidationResult = { ok: true; event: HookEvent } | { ok: false; error: string };

/**
 * 受信ペイロードの検証（design.md 4.8: 必須 = hook_event_name / session_id / cwd がいずれも非空文字列。
 * 未知の hook_event_name は「未知イベント」として不正扱い → 呼び出し側で破棄＋ログ）
 */
export function validateEvent(payload: unknown): ValidationResult {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "payload はオブジェクトである必要があります" };
  }
  const p = payload as Record<string, unknown>;
  for (const field of ["hook_event_name", "session_id", "cwd"] as const) {
    if (typeof p[field] !== "string" || (p[field] as string).trim() === "") {
      return { ok: false, error: `必須フィールド ${field} が欠落または不正です` };
    }
  }
  const name = p.hook_event_name as string;
  if (!(ACCEPTED_EVENT_NAMES as readonly string[]).includes(name)) {
    return { ok: false, error: `未知の hook_event_name: ${name}` };
  }
  const event: HookEvent = {
    hook_event_name: name as HookEventName,
    session_id: p.session_id as string,
    cwd: p.cwd as string,
  };
  if (typeof p.message === "string") event.message = p.message;
  if (typeof p.reason === "string") event.reason = p.reason;
  if (typeof p.transcript_path === "string") event.transcript_path = p.transcript_path;
  if (typeof p.prompt === "string") event.prompt = p.prompt;
  if (typeof p.task_subject === "string") event.task_subject = p.task_subject;
  return { ok: true, event };
}

/** タイルに表示する作業テキストの最大文字数（超過分は「…」で省略。260712 課題B） */
export const WORK_TEXT_MAX = 80;

/**
 * prompt → タイル表示用の作業テキスト整形（260712 課題B）。
 * 改行・連続空白を単一スペースへ畳み、WORK_TEXT_MAX 文字で省略する。
 * 空・空白のみは undefined（呼び出し側は既存値を維持、UI 側は非表示フォールバック）。
 */
export function extractWorkText(prompt: string | undefined): string | undefined {
  if (prompt === undefined) return undefined;
  const collapsed = stripSystemBlocks(prompt).replace(/\s+/g, " ").trim();
  if (collapsed === "") return undefined;
  return collapsed.length > WORK_TEXT_MAX ? collapsed.slice(0, WORK_TEXT_MAX) + "…" : collapsed;
}

/**
 * Claude Code が prompt に自動で差し込む枠（260922_5）。ユーザーが書いた依頼文ではないため作業テキストに出さない。
 * 実データ（2026-09-22 実測）: バックグラウンド作業の完了通知がタイルに `<task-notification> <…` と出ていた。
 */
const SYSTEM_BLOCK_TAGS =
  "task-notification|system-reminder|pasted_content|local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook";
/** 開始タグ〜対応する終了タグ（貼り付け本文の前後にユーザーの指示があれば、そちらは残す） */
const PAIRED_BLOCK = new RegExp(`<(${SYSTEM_BLOCK_TAGS})(\\s[^>]*)?>[\\s\\S]*?</\\1>`, "gi");
/** 終了タグが無い（途中で切れた）開始タグ: そこから末尾まで捨てる */
const UNCLOSED_BLOCK = new RegExp(`<(${SYSTEM_BLOCK_TAGS})(\\s[^>]*)?>[\\s\\S]*$`, "i");
/** 取り残された単独タグ */
const LONE_TAG = new RegExp(`</?(${SYSTEM_BLOCK_TAGS})(\\s[^>]*)?>`, "gi");

/**
 * システムが差し込んだ枠を落として、ユーザーが書いた部分だけを残す（260922_5）。
 * 全部が枠だった場合は空文字を返す（呼び出し側は既存の作業テキストを維持する）
 */
export function stripSystemBlocks(text: string): string {
  return text.replace(PAIRED_BLOCK, " ").replace(UNCLOSED_BLOCK, " ").replace(LONE_TAG, " ");
}

/**
 * Stop hook の block 理由 → タイルの作業テキスト（260907_1 R2）。
 * eval-loop の理由文は「[Eval-loop iteration 1/4 | RESUME 1/3] The loop is mid-iteration …」の形なので、
 * 先頭の `[...]` ラベル（78 文字以内）だけを出す。ラベルが無い・長すぎるときは 1 行目を WORK_TEXT_MAX で省略。
 * 空・空白のみは undefined（呼び出し側は既存の作業テキストを維持）。
 */
export function blockReasonToWorkText(reason: string): string | undefined {
  const label = /^\s*(\[[^\]\n]{1,78}\])/.exec(reason);
  if (label !== null) return label[1];
  const firstLine = reason.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  return extractWorkText(firstLine);
}

/**
 * Notification message の種別分類（design.md 4.3）。
 * いずれの種別でも遷移先は「確認待ち」（安全側）。分類はログ・将来の出し分け用。
 */
export function classifyNotification(message: string | undefined): "permission" | "idle" | "other" {
  if (!message) return "other";
  const m = message.toLowerCase();
  if (m.includes("permission") || m.includes("許可")) return "permission";
  if (m.includes("waiting for") || m.includes("idle") || m.includes("入力待ち")) return "idle";
  return "other";
}

/**
 * イベント → 遷移先状態（design.md 4.3 / 4.8）。
 * - Stop → 完了（無条件）
 * - Notification → 確認待ち（message 種別によらず安全側に倒す）
 * - UserPromptSubmit → 実行中（OPEN-04 案 A 採用 — 2026-07-11。hooks へ自動追記される。design.md 4.1 / 4.5）
 * - TaskCreated → 実行中（タスク作成は作業中にしか起きない。260712_3）
 * - SessionEnd → 正常終了 reason なら null（状態を変えず破棄・ログのみ）、それ以外は「エラー」（OPEN-03 の検知できた範囲）
 */
export function mapEventToState(evt: HookEvent): SessionState | null {
  switch (evt.hook_event_name) {
    case "Stop":
      return "done";
    case "Notification":
      return "confirm";
    case "UserPromptSubmit":
    case "TaskCreated":
      return "running";
    case "SessionEnd":
      return evt.reason !== undefined && NORMAL_END_REASONS.has(evt.reason) ? null : "error";
  }
}

/** パス正規化（design.md 4.7: 大文字小文字非区別・区切り正規化） */
export function normalizePath(p: string): string {
  return p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/**
 * cwd → プロジェクトの対応付け（design.md 4.7: 最長一致プレフィックス）。
 * サブディレクトリ起動は親プロジェクトに割り当てる。一致しなければ null（呼び出し側で破棄＋ログ）。
 */
export function matchProjectByCwd(cwd: string, projects: readonly Project[]): Project | null {
  const cwdN = normalizePath(cwd);
  let best: Project | null = null;
  let bestLen = -1;
  for (const p of projects) {
    const pN = normalizePath(p.path);
    if (cwdN === pN || cwdN.startsWith(pN + "\\")) {
      if (pN.length > bestLen) {
        best = p;
        bestLen = pN.length;
      }
    }
  }
  return best;
}

/**
 * 再起動をまたいで持ち越すセッション記録（260922_7）。
 * 表示に必要な値に加えて、判定を続けるための内部項目（transcriptPath・questionSince）を含む
 */
export interface PersistedSession {
  sessionId: string;
  projectId: string;
  state: SessionState;
  lastEventAt: number;
  firstSeenAt: number;
  runningSince?: number;
  lastMessage?: string;
  workText?: string;
  transcriptPath?: string;
  confirmKind?: "permission" | "question";
  dangerText?: string;
  stallText?: string;
  nameHint?: string;
  bgText?: string;
  taskTitle?: string;
  questionSince?: number;
}

interface SessionRec {
  sessionId: string;
  projectId: string;
  state: SessionState;
  lastEventAt: number;
  runningSince?: number;
  lastMessage?: string;
  workText?: string;
  /** transcript JSONL の実パス（hook payload 由来）。切断検知（liveness-monitor）の監視対象（260712_2） */
  transcriptPath?: string;
  /** statusLine 転送由来の作業メトリクス表示（例「↓ 70.5k tokens · thinking xhigh」。260712_3 案A） */
  statsText?: string;
  /** 最初に観測した時刻（260904_1 #3: 分割タイルの並び順 = 起動順） */
  firstSeenAt: number;
  /**
   * 終了済み（260904_1 #3）: Claude Code の登録簿で「プロセスが居ない」と確認された、または正常 SessionEnd を受けた。
   * 表示状態（完了・確認待ち等）は残すが、分割タイルの対象から外れ、表示選定では生存セッションに劣後する
   */
  dead?: boolean;
  /** eval-loop の進捗バッジ文言（260907_2。eval-loop-status.loopTextForSessions 由来。無ければ非表示） */
  loopText?: string;
  /** 確認待ちの種別（260922_2）。confirm 以外では持たない */
  confirmKind?: "permission" | "question";
  /** 危険度の印（260922_2）。confirm 以外では持たない */
  dangerText?: string;
  /** 停滞の疑いの印（260922_2）。running 以外では持たない */
  stallText?: string;
  /** タイル名と作業内容の不一致の印（260922_6）。状態には依存しない（表示名を直すまで残る） */
  nameHint?: string;
  /** サブエージェント待ちの印（260922_8）。running 以外では持たない */
  bgText?: string;
  /** 今やっているタスク（260922_10。transcript の ai-title 由来。状態には依存しない） */
  taskTitle?: string;
  /**
   * 「返答待ち」にした時刻（260922_4）。confirmKind="question" のときだけ持つ。
   * 復帰判定（findResumedFromQuestion）の基準時刻で、lastEventAt（Stop を受けた時刻＝表示の起点）とは別
   */
  questionSince?: number;
}

/** 状態遷移に伴う Jev 由来の印の整理（260922_2）: 確認待ち以外では種別・危険度を、実行中以外では停滞を落とす */
function clearJudgeMarks(rec: SessionRec): void {
  if (rec.state !== "confirm") {
    delete rec.confirmKind;
    delete rec.dangerText;
    delete rec.questionSince;
  }
  if (rec.state !== "running") {
    delete rec.stallText;
    delete rec.bgText;
  }
}

/**
 * 表示セッションの優先判定（260712 課題A、260904_1 #3 で生存優先を追加）: candidate を current より優先するか。
 * 生存 ＞ 終了済み ＞（同順位内）「実行中」＞ 非実行中 ＞（同順位内）最終イベント時刻が新しい（同時刻含む）方。
 */
function preferForDisplay(candidate: SessionRec, current: SessionRec): boolean {
  const candidateDead = candidate.dead === true;
  const currentDead = current.dead === true;
  if (candidateDead !== currentDead) return !candidateDead;
  const candidateRunning = candidate.state === "running";
  const currentRunning = current.state === "running";
  if (candidateRunning !== currentRunning) return candidateRunning;
  return candidate.lastEventAt >= current.lastEventAt;
}

/** 分割タイル（260904_1 #3）の対象になる状態。切断は「もう居ない」の表示なので対象外 */
const SPLIT_STATES: ReadonlySet<SessionState> = new Set(["running", "done", "confirm", "error"]);

/**
 * ステータスバー件数（design.md 5.2 / 260904_1 #3 で表示タイル基準に一般化）。
 * views = 画面に出るタイルのセッション一覧（分割タイルはそれぞれ 1 件）。待機タイルは含まれない。
 */
export function countTiles(views: readonly SessionView[]): StatusCounts {
  const c: StatusCounts = { running: 0, done: 0, confirm: 0, error: 0, total: 0 };
  let disconnected = 0;
  for (const v of views) {
    c.total += 1;
    if (v.state === "waiting") continue; // 表示セッションはイベント由来のため waiting は来ない
    if (v.state === "disconnected") {
      disconnected += 1;
      continue;
    }
    c[v.state] += 1;
  }
  // disconnected キーは 1 件以上のときだけ付ける（0 件時の形を従来と同一に保ち、既存の期待値と互換にする）
  if (disconnected > 0) c.disconnected = disconnected;
  return c;
}

/** 内部記録 → 配信用ビュー（終了確認は terminalClosed、firstSeenAt は分割タイルの並び順用に載せる） */
function toView(rec: SessionRec): SessionView {
  const view: SessionView = {
    sessionId: rec.sessionId,
    projectId: rec.projectId,
    state: rec.state,
    lastEventAt: rec.lastEventAt,
    firstSeenAt: rec.firstSeenAt,
  };
  if (rec.dead === true) view.terminalClosed = true;
  if (rec.runningSince !== undefined) view.runningSince = rec.runningSince;
  if (rec.lastMessage !== undefined) view.lastMessage = rec.lastMessage;
  if (rec.workText !== undefined) view.workText = rec.workText;
  if (rec.statsText !== undefined) view.statsText = rec.statsText;
  if (rec.loopText !== undefined) view.loopText = rec.loopText;
  if (rec.confirmKind !== undefined) view.confirmKind = rec.confirmKind;
  if (rec.dangerText !== undefined) view.dangerText = rec.dangerText;
  if (rec.stallText !== undefined) view.stallText = rec.stallText;
  if (rec.nameHint !== undefined) view.nameHint = rec.nameHint;
  if (rec.bgText !== undefined) view.bgText = rec.bgText;
  if (rec.taskTitle !== undefined) view.taskTitle = rec.taskTitle;
  return view;
}

export interface ApplyResult {
  projectId: string;
  sessionId: string;
  state: SessionState;
  /**
   * 正常 SessionEnd により「実行中」のまま終了したセッションの記録を破棄したとき true（260712 課題A）。
   * 破棄しないと、実行中優先表示（displaySessions）が終了済みセッションを「実行中」として固定し続ける。
   */
  discardedRunning?: boolean;
}

/**
 * セッション状態ストア本体。EventEmitter("changed") で UI 更新をトリガする。
 * now はテストから時刻を注入できるようにしてある。
 */
export class StateStore extends EventEmitter {
  private sessions = new Map<string, SessionRec>();

  constructor(private readonly now: () => number = () => Date.now()) {
    super();
  }

  /**
   * 検証済みイベントを適用する（design.md 5.1 の遷移表）。
   * 戻り値 null = 破棄（未登録 cwd / 正常 SessionEnd）。
   */
  applyEvent(evt: HookEvent, projects: readonly Project[]): ApplyResult | null {
    const project = matchProjectByCwd(evt.cwd, projects);
    if (project === null) return null; // 破棄してログのみ（design.md 10 章）

    const mapped = mapEventToState(evt);
    if (mapped === null) {
      // 正常 SessionEnd: 表示状態は変えない（design.md 4.8）。ただし「実行中」のまま
      // 終了したセッション（中断→終了で Stop が来ないケース）の記録は破棄する。
      // 保持し続けると、実行中優先表示（260712 課題A の修正）が実在しない
      // 「実行中」を表示し続けてしまうため（幽霊実行中の防止）。
      const existing = this.sessions.get(evt.session_id);
      if (existing !== undefined && existing.state === "running") {
        this.sessions.delete(evt.session_id);
        this.emit("changed");
        return { projectId: existing.projectId, sessionId: evt.session_id, state: existing.state, discardedRunning: true };
      }
      if (existing !== undefined && existing.dead !== true) {
        // 完了・確認待ち等のまま正常終了: 表示は残すが終了済みにする（260904_1 #3: 分割タイルの対象外へ）
        existing.dead = true;
        this.emit("changed");
      }
      return null;
    }

    const t = this.now();
    const existing = this.sessions.get(evt.session_id);
    const rec: SessionRec = existing ?? {
      sessionId: evt.session_id,
      projectId: project.id,
      state: "waiting",
      lastEventAt: t,
      firstSeenAt: t,
    };
    // イベントが届く = プロセスは生きている（登録簿の一時的な誤判定を上書き。260904_1 #3）
    delete rec.dead;

    if (mapped === "running") {
      // 実行中への遷移: 経過時間の起点を記録（既に実行中なら継続 = 起点維持。design.md 5.1）
      if (rec.state !== "running" || rec.runningSince === undefined) rec.runningSince = t;
    } else {
      rec.runningSince = undefined;
    }
    rec.state = mapped;
    rec.lastEventAt = t;
    rec.projectId = project.id;
    // 切断検知（260712_2）用: transcript の実パスを保持（イベントに載っていれば常に最新へ更新）
    if (evt.transcript_path !== undefined) rec.transcriptPath = evt.transcript_path;
    // イベントによる遷移では Jev 由来の印を一旦落とす（260922_2）。Notification は権限確認として種別を付け直す
    clearJudgeMarks(rec);
    if (evt.hook_event_name === "Notification") {
      rec.lastMessage = evt.message;
      rec.confirmKind = "permission";
    }
    if (evt.hook_event_name === "UserPromptSubmit") {
      // 現在の作業テキスト（260712 課題B）: prompt が取れたときのみ更新（空は既存値を維持）
      const work = extractWorkText(evt.prompt);
      if (work !== undefined) rec.workText = work;
    }
    if (evt.hook_event_name === "TaskCreated") {
      // 作業テキストの更新（260712_3）: タスク件名はプロンプト全文より「いま何をやっているか」に近い
      const work = extractWorkText(evt.task_subject);
      if (work !== undefined) rec.workText = work;
    }

    this.sessions.set(evt.session_id, rec);
    this.emit("changed");
    return { projectId: project.id, sessionId: evt.session_id, state: mapped };
  }

  /**
   * プロジェクトごとの表示セッション。
   * 選定規則（design.md 5.2 改訂 — 260712 課題A）: 「実行中」セッションを最優先し、
   * 同順位の中では最終イベント時刻が最新のものを表示する。
   *
   * 旧規則（無条件で最終イベント優先）では、同一プロジェクトで複数セッションが並行する場合
   * （サブエージェント・ヘッドレス claude -p・検証スクリプト等が同じ cwd で走るケース）に、
   * 短命セッションの Stop（完了）が、まだ動作継続中のセッションを覆い隠して
   * 「完了なのに実際は動いている」誤表示になっていた（実ログ 2026-07-11T14:26 の再現痕跡あり）。
   * イベント未受信のプロジェクトは含まれない（= UI 側で「待機」タイル表示）。
   */
  displaySessions(projects: readonly Project[]): Record<string, SessionView> {
    const best = new Map<string, SessionRec>();
    for (const rec of this.sessions.values()) {
      const cur = best.get(rec.projectId);
      if (cur === undefined || preferForDisplay(rec, cur)) best.set(rec.projectId, rec);
    }
    // 登録解除済みプロジェクトのセッションは表示対象から外す
    const ids = new Set(projects.map((p) => p.id));
    const result: Record<string, SessionView> = {};
    for (const [pid, rec] of best) {
      if (ids.has(pid)) result[pid] = toView(rec);
    }
    return result;
  }

  /**
   * 分割タイル（260904_1 #3）: プロジェクトごとに「生きているセッション」が 2 本以上あるときだけ、
   * その一覧（起動順 = firstSeenAt 昇順、同時刻は sessionId 順）を返す。1 本以下のプロジェクトはキー無し
   * （= 従来の 1 タイル表示）。終了済み（dead）・切断は対象外。
   */
  splitSessions(projects: readonly Project[]): Record<string, SessionView[]> {
    const groups = new Map<string, SessionRec[]>();
    for (const rec of this.sessions.values()) {
      if (rec.dead === true || !SPLIT_STATES.has(rec.state)) continue;
      const list = groups.get(rec.projectId) ?? [];
      list.push(rec);
      groups.set(rec.projectId, list);
    }
    const ids = new Set(projects.map((p) => p.id));
    const result: Record<string, SessionView[]> = {};
    for (const [pid, list] of groups) {
      if (!ids.has(pid) || list.length < 2) continue;
      list.sort((a, b) => a.firstSeenAt - b.firstSeenAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
      result[pid] = list.map(toView);
    }
    return result;
  }

  /** ステータスバー件数（design.md 5.2: プロジェクトごとの表示セッションを数える。待機タイルは数えない） */
  counts(projects: readonly Project[]): StatusCounts {
    return countTiles(Object.values(this.displaySessions(projects)));
  }

  /**
   * 登録簿による生死の反映（260904_1 #3）。戻り値: 値が実際に変わったか。
   * dead=true は表示状態を変えない（完了・確認待ちの表示は残る）が、分割タイルの対象から外れ、
   * 表示選定で生存セッションに劣後する。
   */
  setDead(sessionId: string, dead: boolean): boolean {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined || (rec.dead === true) === dead) return false;
    if (dead) rec.dead = true;
    else delete rec.dead;
    this.emit("changed");
    return true;
  }

  /**
   * 終了済み（dead）セッションのうち、同じプロジェクトに生存セッションがあるものを破棄する（260904_1 #3）。
   * 生存セッションが無いプロジェクトの終了済み記録は残す（従来どおり「完了・N分前」の表示を保つ）。
   * 戻り値: 破棄した sessionId
   */
  pruneDeadSessions(): string[] {
    const aliveProjects = new Set<string>();
    for (const rec of this.sessions.values()) {
      if (rec.dead !== true) aliveProjects.add(rec.projectId);
    }
    const removed: string[] = [];
    for (const [sid, rec] of this.sessions) {
      if (rec.dead === true && aliveProjects.has(rec.projectId)) {
        this.sessions.delete(sid);
        removed.push(sid);
      }
    }
    if (removed.length > 0) this.emit("changed");
    return removed;
  }

  /** 1 セッションの表示を消す（分割タイルの「この枠を消す」。260904_1 #3） */
  removeSession(sessionId: string): boolean {
    if (!this.sessions.delete(sessionId)) return false;
    this.emit("changed");
    return true;
  }

  /** 保持している全セッション ID（登録簿との突合用。260904_1 #3） */
  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** 確認待ちからの復帰検知の対象 = 「確認待ち」かつ終了済みでないセッション（260904_1 #2） */
  confirmSessions(): Array<{ sessionId: string; projectId: string; transcriptPath?: string; lastEventAt: number }> {
    const out: Array<{ sessionId: string; projectId: string; transcriptPath?: string; lastEventAt: number }> = [];
    for (const rec of this.sessions.values()) {
      if (rec.state === "confirm" && rec.dead !== true) {
        out.push({ sessionId: rec.sessionId, projectId: rec.projectId, transcriptPath: rec.transcriptPath, lastEventAt: rec.lastEventAt });
      }
    }
    return out;
  }

  /**
   * 確認待ち → 実行中（260904_1 #2）: 許可後に作業が再開された（transcript 更新／登録簿 busy）ときの遷移。
   * 確認待ち以外には適用しない。経過時間の起点は検知時刻。
   */
  resumeFromConfirm(sessionId: string): boolean {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined || rec.state !== "confirm") return false;
    const t = this.now();
    rec.state = "running";
    rec.runningSince = t;
    rec.lastEventAt = t;
    clearJudgeMarks(rec);
    this.emit("changed");
    return true;
  }

  /** 完了・切断からの復帰検知の対象 = 「完了」または「切断」かつ終了済みでないセッション（260907_1） */
  stoppedSessions(): Array<{ sessionId: string; projectId: string; state: "done" | "disconnected"; transcriptPath?: string; lastEventAt: number }> {
    const out: Array<{ sessionId: string; projectId: string; state: "done" | "disconnected"; transcriptPath?: string; lastEventAt: number }> = [];
    for (const rec of this.sessions.values()) {
      if ((rec.state === "done" || rec.state === "disconnected") && rec.dead !== true) {
        out.push({ sessionId: rec.sessionId, projectId: rec.projectId, state: rec.state, transcriptPath: rec.transcriptPath, lastEventAt: rec.lastEventAt });
      }
    }
    return out;
  }

  /**
   * 完了・切断 → 実行中（260907_1 R1〜R3）: Stop hook が block して続行した／登録簿が作業中と申告している／
   * 切断後に transcript が動いた、ときの遷移。完了・切断以外には適用しない。経過時間の起点は検知時刻。
   * workText を渡せば作業テキストを置き換える（block 理由のラベル。省略時は維持）。
   */
  resumeFromStopped(sessionId: string, workText?: string): boolean {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined || (rec.state !== "done" && rec.state !== "disconnected")) return false;
    const t = this.now();
    rec.state = "running";
    rec.runningSince = t;
    rec.lastEventAt = t;
    if (workText !== undefined) rec.workText = workText;
    clearJudgeMarks(rec);
    this.emit("changed");
    return true;
  }

  /**
   * 「実行中」セッションが実際に切断（transcript 更新途絶＋ウィンドウ消失）していたときの遷移（260712_2）。
   * 呼び出し元は liveness-monitor の掃引。running 以外には適用しない（イベント由来の確定状態を上書きしない）。
   * lastEventAt は検知時刻に更新する（タイルの「切断・N分前」の起点 = 検知時点）。
   */
  markDisconnected(sessionId: string): boolean {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined || rec.state !== "running") return false;
    rec.state = "disconnected";
    rec.runningSince = undefined;
    rec.lastEventAt = this.now();
    clearJudgeMarks(rec);
    this.emit("changed");
    return true;
  }

  /**
   * 再接続（260712_2、260712_4 で終端分類対応）: transcript 走査で見つかったセッションを復元する。
   *
   * 復元状態は transcript 終端の分類（turnEnd）で決める:
   * - concluded（ターン終了済み）→「完了」。従来は無条件に「実行中」で復元しており、
   *   done 済みセッションでも transcript mtime が Stop イベント時刻より新しいため
   *   ガードをすり抜けてスピナーに戻っていた（2026-07-11T21:57 実測バグ）。
   * - open / unknown → 従来どおり「実行中」（切断からの復帰・再起動後の復元）。
   *   ただし実行中セッションには触らない（runningSince を transcript mtime で巻き戻さない）。
   * - 終了系状態（done/confirm/error）は、イベントの方が新しい場合と concluded の見立ての場合は
   *   動かさない（イベント由来の状態が優先）。
   */
  reviveSession(info: {
    sessionId: string;
    projectId: string;
    lastEventAt: number;
    transcriptPath: string;
    workText?: string;
    turnEnd?: "concluded" | "open" | "unknown";
  }): boolean {
    const concluded = info.turnEnd === "concluded";
    const existing = this.sessions.get(info.sessionId);
    if (existing !== undefined && existing.state !== "disconnected") {
      if (existing.state === "running") {
        if (!concluded) return false; // 進行中の見立て → 現状維持
        // 実行中 + ターン終了済み → 「完了」へ（Stop 欠落スタックの手動ヒール）
        existing.state = "done";
        clearJudgeMarks(existing);
        existing.runningSince = undefined;
        existing.lastEventAt = Math.max(existing.lastEventAt, info.lastEventAt);
        existing.transcriptPath = info.transcriptPath;
        this.emit("changed");
        return true;
      }
      if (existing.lastEventAt >= info.lastEventAt) return false; // イベントの方が新しい（従来ガード）
      if (concluded) return false; // 終了済みの見立てで終了系状態を動かさない
      // transcript の方が新しく、ターンも開いている → 開始イベント欠落とみなし「実行中」へ（従来動作）
    }
    this.sessions.set(info.sessionId, {
      sessionId: info.sessionId,
      projectId: info.projectId,
      state: concluded ? "done" : "running",
      lastEventAt: info.lastEventAt,
      runningSince: concluded ? undefined : info.lastEventAt,
      transcriptPath: info.transcriptPath,
      workText: info.workText ?? existing?.workText,
      firstSeenAt: existing?.firstSeenAt ?? info.lastEventAt,
    });
    this.emit("changed");
    return true;
  }

  /**
   * 終了検知（260712_4）: Stop 欠落の「実行中」セッションを「完了」へ降格する（掃引から呼ばれる）。
   * markDisconnected と対称 — 実行中のみ対象、イベント由来の確定状態は上書きしない。
   */
  markConcluded(sessionId: string): boolean {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined || rec.state !== "running") return false;
    rec.state = "done";
    rec.runningSince = undefined;
    rec.lastEventAt = this.now();
    clearJudgeMarks(rec);
    this.emit("changed");
    return true;
  }

  /**
   * statusLine 転送のメトリクス表示を更新する（260712_3 案A）。
   * 状態遷移・lastEventAt には一切触れない — statusline はアイドル中（入力待ち）にも
   * 発火するため、「実行中」への遷移根拠にすると誤表示になる。
   * 未知のセッションは破棄（hook イベントでタイルが確立してから載る）。
   * 戻り値: 表示値が実際に変わったとき true（呼び出し側の broadcast 抑制用。
   * statusline は最大 300ms 間隔で来るため、値が同じ間は再描画しない）。
   */
  applyStatusStats(sessionId: string, statsText: string | undefined): boolean {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined || statsText === undefined) return false;
    if (rec.statsText === statsText) return false;
    rec.statsText = statsText;
    this.emit("changed");
    return true;
  }

  /**
   * ループ進捗バッジの文言を更新する（260907_2）。applyStatusStats と同じく状態遷移・lastEventAt には触れない。
   * undefined で消す（ループ終了から 30 分で消えるため）。未知のセッションは破棄。
   * 戻り値: 表示値が実際に変わったとき true（呼び出し側の broadcast 抑制用）
   */
  applyLoopText(sessionId: string, text: string | undefined): boolean {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined || rec.loopText === text) return false;
    if (text === undefined) delete rec.loopText;
    else rec.loopText = text;
    this.emit("changed");
    return true;
  }

  /* ---------------- Jev 判定の反映（260922_2） ---------------- */

  /** 現在の作業テキスト（作業テキストの上書き防止の precheck 用） */
  workTextOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.workText;
  }

  /** 現在の状態と最終イベント時刻（非同期判定の「その後イベントが来ていないか」確認用） */
  snapshotOf(sessionId: string): { state: SessionState; lastEventAt: number; transcriptPath?: string; lastMessage?: string } | undefined {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined) return undefined;
    return { state: rec.state, lastEventAt: rec.lastEventAt, transcriptPath: rec.transcriptPath, lastMessage: rec.lastMessage };
  }

  /**
   * 作業テキストを後から確定する（上書き防止の判定後）。prompt は extractWorkText で整形する。
   * 状態・時刻には触れない。空・取得不能なら無変化
   */
  setWorkText(sessionId: string, prompt: string | undefined): boolean {
    const rec = this.sessions.get(sessionId);
    const work = extractWorkText(prompt);
    if (rec === undefined || work === undefined || rec.workText === work) return false;
    rec.workText = work;
    this.emit("changed");
    return true;
  }

  /**
   * 完了 → 返答待ち（Stop 後に Jev が「最後の返答が質問・判断依頼で終わっている」と判定。260922_2）。
   * その後にイベントが届いていたら（lastEventAt が進んでいたら）適用しない。
   * 表示は確認待ち（confirm）と同じで confirmKind="question"。経過時間の起点は持たない（確認待ちと同じ）
   */
  markQuestionPending(sessionId: string, sinceEventAt: number): boolean {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined || rec.state !== "done" || rec.lastEventAt !== sinceEventAt || rec.dead === true) return false;
    rec.state = "confirm";
    rec.confirmKind = "question";
    rec.lastMessage = "Claude が返答を待っています";
    rec.runningSince = undefined;
    rec.questionSince = this.now(); // 復帰判定の基準（260922_4）。表示の起点 lastEventAt は Stop のまま
    this.emit("changed");
    return true;
  }

  /**
   * 返答待ち（Jev 判定）セッションの一覧（260922_4）。完了・切断と同じ復帰規則
   * （findResumedFromQuestion）にかけるための掃引対象。権限確認（permission）は含まない
   */
  questionPendingSessions(): Array<{ sessionId: string; projectId: string; transcriptPath?: string; stoppedAt: number; pendingSince: number }> {
    const out: Array<{ sessionId: string; projectId: string; transcriptPath?: string; stoppedAt: number; pendingSince: number }> = [];
    for (const rec of this.sessions.values()) {
      if (rec.state !== "confirm" || rec.confirmKind !== "question" || rec.dead === true) continue;
      out.push({
        sessionId: rec.sessionId,
        projectId: rec.projectId,
        transcriptPath: rec.transcriptPath,
        stoppedAt: rec.lastEventAt,
        pendingSince: rec.questionSince ?? rec.lastEventAt,
      });
    }
    return out;
  }

  /** 危険度の印（260922_2）。確認待ち以外には付けない。値が変わったときだけ changed */
  applyDangerText(sessionId: string, text: string | undefined): boolean {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined || rec.state !== "confirm" || rec.dangerText === text) return false;
    if (text === undefined) delete rec.dangerText;
    else rec.dangerText = text;
    this.emit("changed");
    return true;
  }

  /**
   * 今やっているタスク（260922_10）。状態を問わず付け外しでき、値が変わったときだけ changed。
   * 情報源は Claude Code が書く ai-title なので、こちらからは生成しない
   */
  applyTaskTitle(sessionId: string, title: string | undefined): boolean {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined || rec.taskTitle === title) return false;
    if (title === undefined) delete rec.taskTitle;
    else rec.taskTitle = title;
    this.emit("changed");
    return true;
  }

  /**
   * サブエージェント待ちの印（260922_8）。実行中にだけ付ける（他の状態では意味が無い）。
   * 値が変わったときだけ changed
   */
  applyBgText(sessionId: string, text: string | undefined): boolean {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined || rec.state !== "running" || rec.bgText === text) return false;
    if (text === undefined) delete rec.bgText;
    else rec.bgText = text;
    this.emit("changed");
    return true;
  }

  /** 停滞の疑いの印（260922_2）。実行中以外には付けない。値が変わったときだけ changed */
  applyStallText(sessionId: string, text: string | undefined): boolean {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined || rec.state !== "running" || rec.stallText === text) return false;
    if (text === undefined) delete rec.stallText;
    else rec.stallText = text;
    this.emit("changed");
    return true;
  }

  /**
   * タイル名と作業内容の不一致の印（260922_6）。状態を問わず付け外しでき、値が変わったときだけ changed。
   * 表示名を直したら呼び出し側が clearNameHints で消す
   */
  applyNameHint(sessionId: string, text: string | undefined): boolean {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined || rec.nameHint === text) return false;
    if (text === undefined) delete rec.nameHint;
    else rec.nameHint = text;
    this.emit("changed");
    return true;
  }

  /** 指定プロジェクトの全セッションから名前の印を消す（260922_6。表示名を変えた直後に呼ぶ） */
  clearNameHints(projectId: string): boolean {
    let changed = false;
    for (const rec of this.sessions.values()) {
      if (rec.projectId !== projectId || rec.nameHint === undefined) continue;
      delete rec.nameHint;
      changed = true;
    }
    if (changed) this.emit("changed");
    return changed;
  }

  /** transcript を持つ生存セッション（260922_10。タスク名の読み取り対象） */
  transcriptSessions(): Array<{ sessionId: string; projectId: string; transcriptPath: string }> {
    const out: Array<{ sessionId: string; projectId: string; transcriptPath: string }> = [];
    for (const rec of this.sessions.values()) {
      if (rec.dead === true || rec.transcriptPath === undefined) continue;
      out.push({ sessionId: rec.sessionId, projectId: rec.projectId, transcriptPath: rec.transcriptPath });
    }
    return out;
  }

  /** タスク名を持つセッション（260922_10。自動リネームの材料） */
  taskTitles(): Array<{ sessionId: string; projectId: string; taskTitle: string }> {
    const out: Array<{ sessionId: string; projectId: string; taskTitle: string }> = [];
    for (const rec of this.sessions.values()) {
      if (rec.dead === true || rec.taskTitle === undefined) continue;
      out.push({ sessionId: rec.sessionId, projectId: rec.projectId, taskTitle: rec.taskTitle });
    }
    return out;
  }

  /** 名前の整合判定に使う「セッションごとの作業テキスト」（260922_6） */
  workTextSessions(): Array<{ sessionId: string; projectId: string; workText: string }> {
    const out: Array<{ sessionId: string; projectId: string; workText: string }> = [];
    for (const rec of this.sessions.values()) {
      if (rec.dead === true || rec.workText === undefined || rec.workText === "") continue;
      out.push({ sessionId: rec.sessionId, projectId: rec.projectId, workText: rec.workText });
    }
    return out;
  }

  /** 切断検知の掃引対象 = 「実行中」セッション一覧（liveness-monitor 用。260712_2） */
  runningSessions(): Array<{ sessionId: string; projectId: string; transcriptPath?: string }> {
    const out: Array<{ sessionId: string; projectId: string; transcriptPath?: string }> = [];
    for (const rec of this.sessions.values()) {
      if (rec.state === "running") {
        out.push({ sessionId: rec.sessionId, projectId: rec.projectId, transcriptPath: rec.transcriptPath });
      }
    }
    return out;
  }

  /**
   * 指定プロジェクトのセッションを破棄する（登録解除時のメモリ整理）。
   * displaySessions は登録済みプロジェクトのみ返すため表示には影響しないが、
   * 内部 Map に残り続けると長期稼働でメモリが単調増加するため明示的に消す。
   */
  removeProjectSessions(projectId: string): void {
    let removed = false;
    for (const [sid, rec] of this.sessions) {
      if (rec.projectId === projectId) {
        this.sessions.delete(sid);
        removed = true;
      }
    }
    if (removed) this.emit("changed");
  }

  /** デモ用シード（--demo 実行時のみ使用。hooks 追記・永続化は一切行わない） */
  seedSession(rec: SessionView): void {
    const { terminalClosed, ...view } = rec;
    const seeded: SessionRec = { ...view, firstSeenAt: rec.firstSeenAt ?? rec.runningSince ?? rec.lastEventAt };
    if (terminalClosed === true) seeded.dead = true;
    this.sessions.set(rec.sessionId, seeded);
    this.emit("changed");
  }

  /* ---------------- 再起動をまたぐ保存・復元（260922_7） ---------------- */

  /**
   * 保存用のセッション一覧（260922_7）。終了済み（dead）は除く。
   * SessionView には載らない内部項目（transcriptPath・questionSince）も含めて、再起動後に判定を続けられるようにする
   */
  exportSessions(): PersistedSession[] {
    const out: PersistedSession[] = [];
    for (const rec of this.sessions.values()) {
      if (rec.dead === true) continue;
      const item: PersistedSession = {
        sessionId: rec.sessionId,
        projectId: rec.projectId,
        state: rec.state,
        lastEventAt: rec.lastEventAt,
        firstSeenAt: rec.firstSeenAt,
      };
      if (rec.runningSince !== undefined) item.runningSince = rec.runningSince;
      if (rec.lastMessage !== undefined) item.lastMessage = rec.lastMessage;
      if (rec.workText !== undefined) item.workText = rec.workText;
      if (rec.transcriptPath !== undefined) item.transcriptPath = rec.transcriptPath;
      if (rec.confirmKind !== undefined) item.confirmKind = rec.confirmKind;
      if (rec.dangerText !== undefined) item.dangerText = rec.dangerText;
      if (rec.stallText !== undefined) item.stallText = rec.stallText;
      if (rec.nameHint !== undefined) item.nameHint = rec.nameHint;
      if (rec.bgText !== undefined) item.bgText = rec.bgText;
      if (rec.taskTitle !== undefined) item.taskTitle = rec.taskTitle;
      if (rec.questionSince !== undefined) item.questionSince = rec.questionSince;
      out.push(item);
    }
    return out;
  }

  /**
   * 保存しておいたセッションを取り込む（260922_7。起動直後に 1 回だけ呼ぶ想定）。
   * 既にイベントで確立している同じ id は上書きしない（実データの方が新しい）。戻り値: 取り込んだ件数
   */
  importSessions(list: readonly PersistedSession[]): number {
    let added = 0;
    for (const item of list) {
      if (this.sessions.has(item.sessionId)) continue;
      const rec: SessionRec = {
        sessionId: item.sessionId,
        projectId: item.projectId,
        state: item.state,
        lastEventAt: item.lastEventAt,
        firstSeenAt: item.firstSeenAt,
      };
      if (item.runningSince !== undefined) rec.runningSince = item.runningSince;
      if (item.lastMessage !== undefined) rec.lastMessage = item.lastMessage;
      if (item.workText !== undefined) rec.workText = item.workText;
      if (item.transcriptPath !== undefined) rec.transcriptPath = item.transcriptPath;
      if (item.confirmKind !== undefined) rec.confirmKind = item.confirmKind;
      if (item.dangerText !== undefined) rec.dangerText = item.dangerText;
      if (item.stallText !== undefined) rec.stallText = item.stallText;
      if (item.nameHint !== undefined) rec.nameHint = item.nameHint;
      if (item.bgText !== undefined) rec.bgText = item.bgText;
      if (item.taskTitle !== undefined) rec.taskTitle = item.taskTitle;
      if (item.questionSince !== undefined) rec.questionSince = item.questionSince;
      this.sessions.set(rec.sessionId, rec);
      added += 1;
    }
    if (added > 0) this.emit("changed");
    return added;
  }

  /** 全消去（揮発仕様の明示。T-10: 再起動で全タイル「待機」へ） */
  resetAll(): void {
    this.sessions.clear();
    this.emit("changed");
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
}
