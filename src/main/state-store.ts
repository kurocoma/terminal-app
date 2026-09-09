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
export const ACCEPTED_EVENT_NAMES = ["Stop", "Notification", "UserPromptSubmit", "SessionEnd", "TaskCreated", "SessionStart"] as const;
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
  /** SessionStart のみ: startup / resume / clear / compact / fork（公式 hooks reference。260909_1。ログ用） */
  source?: string;
  /** TaskCreated のみ: 作成されたタスクの件名（作業テキストの実データ源。260712_3） */
  task_subject?: string;
  /**
   * Notification のみ: 通知種別（公式 hooks reference。permission_prompt / idle_prompt / elicitation_dialog /
   * elicitation_url_dialog / agent_needs_input / agent_completed / quota_auto_resume_* 等。260908_2 で受理）
   */
  notification_type?: string;
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
  if (typeof p.source === "string") event.source = p.source;
  if (typeof p.task_subject === "string") event.task_subject = p.task_subject;
  if (typeof p.notification_type === "string") event.notification_type = p.notification_type;
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
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  if (collapsed === "") return undefined;
  return collapsed.length > WORK_TEXT_MAX ? collapsed.slice(0, WORK_TEXT_MAX) + "…" : collapsed;
}

/**
 * UserPromptSubmit の prompt がバックグラウンドタスク（Monitor / run_in_background の Bash 等）の完了・進捗通知による
 * 自動起床か（260908_1）。Claude Code は `<task-notification>…</task-notification>` を user メッセージとして注入し、
 * そのたびに UserPromptSubmit hook を発火する（2026-09-08 実測: transcript の origin.kind="task-notification"）。
 * 人の依頼文ではないので作業テキストに使わず、「バックグラウンド作業に駆動されている」印にだけ使う
 */
export function isTaskNotificationPrompt(prompt: string | undefined): boolean {
  return prompt !== undefined && /^\s*<task-notification>/.test(prompt);
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
 * Notification の種別分類（design.md 4.3。260908_2 で公式 `notification_type` を優先）。
 * - permission = 人の応答が要る（permission_prompt / elicitation_dialog / elicitation_url_dialog / agent_needs_input）。
 *   ループ中・バックグラウンド作業中でも「確認待ち」にする
 * - idle = 応答完了から約 60 秒無操作（idle_prompt）。作業継続中の保持の対象
 * - other = それ以外（auth_success / agent_completed / quota_auto_resume_* / 不明）
 * notification_type が無い（旧版・擬似注入）ときは message の文言で推定する（従来どおり）。
 */
export type NotificationKind = "permission" | "idle" | "other";

const PERMISSION_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  "permission_prompt",
  "elicitation_dialog",
  "elicitation_url_dialog",
  "agent_needs_input",
]);

export function classifyNotification(message: string | undefined, notificationType?: string): NotificationKind {
  if (notificationType !== undefined && notificationType !== "") {
    if (PERMISSION_NOTIFICATION_TYPES.has(notificationType)) return "permission";
    if (notificationType === "idle_prompt") return "idle";
    return "other";
  }
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
 * - SessionStart → null（状態は作らない。同じプロジェクトの終了済み・切断の表示を消す。applyEvent 参照。260909_1）
 */
export function mapEventToState(evt: HookEvent): SessionState | null {
  switch (evt.hook_event_name) {
    case "SessionStart":
      return null;
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
  /** eval-loop の進捗バッジ文言（260907_2。eval-loop-status.loopStatusForSessions 由来。無ければ非表示） */
  loopText?: string;
  /** hook payload の cwd（260908_1: `<cwd>/.mso` のループ state を探す基点。再接続復元だけのセッションには無い） */
  cwd?: string;
  /**
   * 直近のプロンプトがバックグラウンドタスクの通知（task-notification）だった（260908_1）。
   * 人のプロンプトで解除。Stop の後も登録簿が idle でなければ「バックグラウンド作業の完了待ち」として実行中に保つ根拠
   */
  backgroundDriven?: boolean;
  /** 確認待ちの種別（Notification の分類。260908_1: permission 以外はループ中・バックグラウンド作業中なら確認待ちにしない） */
  confirmKind?: NotificationKind;
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

/** 内部記録 → 配信用ビュー（dead は内部専用。firstSeenAt は分割タイルの並び順用に載せる） */
function toView(rec: SessionRec): SessionView {
  const view: SessionView = {
    sessionId: rec.sessionId,
    projectId: rec.projectId,
    state: rec.state,
    lastEventAt: rec.lastEventAt,
    firstSeenAt: rec.firstSeenAt,
  };
  if (rec.runningSince !== undefined) view.runningSince = rec.runningSince;
  if (rec.lastMessage !== undefined) view.lastMessage = rec.lastMessage;
  if (rec.workText !== undefined) view.workText = rec.workText;
  if (rec.statsText !== undefined) view.statsText = rec.statsText;
  if (rec.loopText !== undefined) view.loopText = rec.loopText;
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
  /** SessionStart で消した同一プロジェクトの終了済み・切断セッション（260909_1。state は "waiting"） */
  prunedSessions?: string[];
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
  applyEvent(evt: HookEvent, projects: readonly Project[], opts?: { holdRunning?: boolean }): ApplyResult | null {
    const project = matchProjectByCwd(evt.cwd, projects);
    if (project === null) return null; // 破棄してログのみ（design.md 10 章）

    if (evt.hook_event_name === "SessionStart") {
      // 新しいセッションの開始（260909_1）: 表示は作らない（最初のプロンプトで実行中になる）。
      // 同じプロジェクトの「終了済み」「切断」の記録は、もう見る意味が無いので消してタイルを待機へ戻す
      // （2026-09-09 実測: Claude Code を再起動した後、前のセッションの「切断・8 分前」が最初のプロンプトまで残った）。
      // 生存中の他セッション（実行中・完了・確認待ち）には触れない
      const pruned: string[] = [];
      for (const rec of this.sessions.values()) {
        if (rec.projectId !== project.id) continue;
        if (rec.dead === true || rec.state === "disconnected" || rec.sessionId === evt.session_id) pruned.push(rec.sessionId);
      }
      for (const sid of pruned) this.sessions.delete(sid);
      if (pruned.length > 0) this.emit("changed");
      return { projectId: project.id, sessionId: evt.session_id, state: "waiting", prunedSessions: pruned };
    }

    let mapped = mapEventToState(evt);
    // 作業継続中の保持（260908_1）: 呼び出し側がループ進行中・バックグラウンド作業中と判定した Stop / Notification は
    // 「完了」「確認待ち」にせず「実行中」を保つ（イベントの受信自体は lastEventAt・transcript パスに反映する）
    if (opts?.holdRunning === true && (mapped === "done" || mapped === "confirm")) mapped = "running";
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
    rec.cwd = evt.cwd;
    if (evt.hook_event_name === "Notification") {
      rec.lastMessage = evt.message;
      rec.confirmKind = classifyNotification(evt.message, evt.notification_type);
    }
    if (evt.hook_event_name === "UserPromptSubmit") {
      if (isTaskNotificationPrompt(evt.prompt)) {
        // バックグラウンドタスクの通知による起床（260908_1）: 作業テキストは人の依頼文のまま維持し、駆動中の印だけ立てる
        rec.backgroundDriven = true;
      } else {
        delete rec.backgroundDriven;
        // 現在の作業テキスト（260712 課題B）: prompt が取れたときのみ更新（空は既存値を維持）
        const work = extractWorkText(evt.prompt);
        if (work !== undefined) rec.workText = work;
      }
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
  confirmSessions(): Array<{ sessionId: string; projectId: string; transcriptPath?: string; lastEventAt: number; kind?: NotificationKind }> {
    const out: Array<{ sessionId: string; projectId: string; transcriptPath?: string; lastEventAt: number; kind?: NotificationKind }> = [];
    for (const rec of this.sessions.values()) {
      if (rec.state === "confirm" && rec.dead !== true) {
        out.push({ sessionId: rec.sessionId, projectId: rec.projectId, transcriptPath: rec.transcriptPath, lastEventAt: rec.lastEventAt, kind: rec.confirmKind });
      }
    }
    return out;
  }

  /** transcript の実パス（260908_1: 保持判定の停滞ガード用。未知・未取得は undefined） */
  transcriptPathOf(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.transcriptPath;
  }

  /** 直近のプロンプトがバックグラウンドタスクの通知だったか（260908_1。未知のセッションは false） */
  isBackgroundDriven(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.backgroundDriven === true;
  }

  /**
   * ループ state の探索に要る情報（260908_1）: 終了済みでない全セッションの id・cwd・プロジェクトのパス。
   * cwd が無い（再接続復元のみ）セッションはプロジェクトのパスだけで探す
   */
  loopLookupSessions(projects: readonly Project[]): Array<{ sessionId: string; cwd?: string; projectPath: string }> {
    const out: Array<{ sessionId: string; cwd?: string; projectPath: string }> = [];
    for (const rec of this.sessions.values()) {
      if (rec.dead === true) continue;
      const project = projects.find((p) => p.id === rec.projectId);
      if (project === undefined) continue;
      out.push({ sessionId: rec.sessionId, cwd: rec.cwd, projectPath: project.path });
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
    this.sessions.set(rec.sessionId, { ...rec, firstSeenAt: rec.firstSeenAt ?? rec.runningSince ?? rec.lastEventAt });
    this.emit("changed");
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
