/**
 * 切断検知（260712_2）: 「実行中」セッションの生死を transcript の更新時刻とウィンドウ存在で判定する。
 *
 * 背景: claude が異常終了・ターミナルごと閉じられた場合、SessionEnd hook は届かず
 * タイルが「実行中」のまま残り続ける（260712 課題A で確認済みの既知の限界）。
 * hook イベントの途絶は判定に使わない — 実行中は hook が来ないのが正常であるため。
 *
 * 判定規則（両シグナルの併用。ユーザー合意 2026-07-12）:
 * - transcript 無更新が TRANSCRIPT_STALE_MS 以上 かつ プロジェクトのウィンドウが見つからない → 切断
 * - transcript 無更新が TRANSCRIPT_STALE_HARD_MS 以上 → ウィンドウが残っていても切断
 *   （claude だけ落ちてシェルのウィンドウが残るケース。ウィンドウ存在は生存の証明にならない）
 * - transcript パス不明・mtime 取得不可・ウィンドウ判定不能（koffi なし）は安全側 = 切断にしない。
 *   ウィンドウ判定はタイトル一致のヒューリスティックで偽陰性がある（タブ切替等）ため、
 *   短い閾値側は「両方成立」を要求して誤検知を抑える。
 * - 登録簿 status が busy のセッションは切断しない（260907_1 R4。同期 fork・codex 待ちで本体 transcript が
 *   長く止まっても Claude Code 自身は「作業中」と申告している）。
 * - 作業継続中の保持（260908_1）: 呼び出し側が「品質ループ進行中」「バックグラウンド作業の完了待ち」と判定した
 *   セッション（heldReason が文字列を返す）は、終了検知・切断検知の対象外にし、完了・切断・確認待ち（許可要求以外）から
 *   実行中へ戻す。判定の根拠は index.ts 側（eval-loop の state.json / task-notification 起床＋登録簿 status）。
 */

/**
 * 作業継続中の保持判定（260908_1）。文字列 = 保持する理由（ログ・作業テキスト用）、undefined = 保持しない。
 * 省略時は従来どおり（保持なし）
 */
export type HeldReasonFn = (sessionId: string) => string | undefined;

export interface SweepTarget {
  sessionId: string;
  projectId: string;
  transcriptPath?: string;
}

export interface SweepDeps {
  now(): number;
  /** transcript の最終活動時刻（epoch ms）。取得不可（不存在・権限）は null。呼び出し側は subagent 記録も含めた値を渡す（260907_1） */
  mtimeMs(path: string): number | null;
  /** プロジェクトのウィンドウが存在するか。null = 判定不能（koffi 未ロード等） */
  windowPresent(projectId: string): boolean | null;
  /** Claude Code の登録簿 status（busy / waiting / idle）。省略・undefined なら従来どおり transcript のみで判定（260907_1 R4） */
  registryStatus?(sessionId: string): string | undefined;
  /** 作業継続中の保持（260908_1）。保持中は切断しない */
  heldReason?: HeldReasonFn;
}

/** 検証用の env 上書き（--demo / TERMINAL_APP_DATA_DIR と同系の検証フラグ。実運用では未設定 = 既定値） */
function envMs(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * 掃引間隔（既定 15 秒。260904_1 #2 で 30 秒から短縮 — 終了検知・切断検知・確認待ちからの復帰を早める）。
 * index.ts の setInterval で使用
 */
export const DISCONNECT_CHECK_INTERVAL_MS = envMs("TERMINAL_APP_LIVENESS_INTERVAL_MS", 15_000);
/** transcript 無更新がこの時間を超え、かつウィンドウ消失で「切断」（応答生成中は transcript が更新され続ける前提。既定 3 分） */
export const TRANSCRIPT_STALE_MS = envMs("TERMINAL_APP_TRANSCRIPT_STALE_MS", 180_000);
/** transcript 無更新がこの時間を超えたら、ウィンドウが残っていても「切断」（長時間ツール実行の誤検知を避ける余裕。既定 15 分） */
export const TRANSCRIPT_STALE_HARD_MS = envMs("TERMINAL_APP_TRANSCRIPT_STALE_HARD_MS", 15 * 60_000);
/** 終了検知（260712_4）: transcript 無更新がこの時間以上のものだけ終端分類する（ターン境界・Stop 配送中との競合回避。既定 10 秒） */
export const CONCLUDED_MIN_AGE_MS = envMs("TERMINAL_APP_CONCLUDED_MIN_AGE_MS", 10_000);
/**
 * 確認待ちからの復帰（260904_1 #2）: 確認待ちイベントからこの時間以上経った transcript 更新だけを
 * 「許可後の作業再開」とみなす（通知直後に transcript が書き終わる競合を除外。既定 3 秒）
 */
export const CONFIRM_RESUME_MARGIN_MS = envMs("TERMINAL_APP_CONFIRM_RESUME_MARGIN_MS", 3_000);
/** 確認待ちからの復帰: 確認待ちになってからこの時間未満は判定しない（登録簿 status の更新競合を避ける。既定 5 秒） */
export const CONFIRM_RESUME_MIN_AGE_MS = envMs("TERMINAL_APP_CONFIRM_RESUME_MIN_AGE_MS", 5_000);
/**
 * 完了・切断からの復帰（260907_1 R1）: Stop（最終イベント）からこの時間未満は登録簿 busy を信じない。
 * 登録簿は Stop と同じ秒に idle へ切り替わる（2026-09-07 実測）ため、この猶予を過ぎても busy なら
 * 「Stop hook が block して続行中」か「別の作業が続いている」。既定 3 秒
 */
export const STOPPED_RESUME_MIN_AGE_MS = envMs("TERMINAL_APP_STOPPED_RESUME_MIN_AGE_MS", 3_000);
/**
 * block 痕跡の許容ずれ（260907_1 R2）: stop_hook_summary の timestamp は hook 完了後に書かれるため本来は
 * Stop 受信より新しいが、時計・書き込み順のずれに備えて最終イベントよりこの時間だけ前まで許容する
 */
export const BLOCKED_STOP_MARGIN_MS = 2_000;

export interface ConfirmTarget extends SweepTarget {
  /** 確認待ちへ遷移したイベントの時刻（epoch ms） */
  lastEventAt: number;
  /** 確認待ちの種別（Notification の分類。260908_1: permission = 本当に人の許可が要る。無指定は other 扱い） */
  kind?: "permission" | "idle" | "other";
}

export interface ConfirmResumeDeps {
  now(): number;
  /** transcript ファイルの mtime（epoch ms）。取得不可は null */
  mtimeMs(path: string): number | null;
  /** Claude Code の登録簿 status（busy / waiting / idle）。無ければ undefined（session-registry.registryStatusOf を注入） */
  registryStatus(sessionId: string): string | undefined;
  /** 作業継続中の保持（260908_1）。許可要求（permission）以外の確認待ちは保持中なら実行中へ戻す */
  heldReason?: HeldReasonFn;
  /**
   * transcript 終端の分類（session-scan.turnEndOf を注入。260909_1）。渡した場合、transcript 更新による復帰は
   * 終端が open（本当にターンが始まった）のときだけにする。メタ・ローカルコマンドの書き込みで復帰しないため
   */
  turnEnd?(path: string): "concluded" | "open" | "unknown";
}

export interface ConfirmResumeHit {
  target: ConfirmTarget;
  /** 何を根拠に復帰させたか（ログ用）: 登録簿が busy / transcript が通知後に更新 / 作業継続中の保持 */
  reason: "registry" | "transcript" | "held";
  /** reason=held のとき: 保持の理由 */
  heldReason?: string;
}

/**
 * 確認待ち → 実行中の復帰検知（260904_1 #2）。
 *
 * 背景: 権限確認（Notification）→ ユーザーが許可 → Claude が作業再開、の「許可」には hook が無く、
 * 次の Stop / Notification が来るまでタイルが「確認待ち」のまま残っていた
 * （実ログ 2026-09-03 20:27〜20:41 UTC: 商品登録アプリで permission → confirm が 4 回続き、間に running なし）。
 * 根拠は 2 系統（どちらかで復帰）:
 * - 登録簿 status が busy（Claude Code 自身の申告。cli 起動のみ載る）
 * - transcript の mtime が確認待ちイベント時刻 ＋ 余裕（CONFIRM_RESUME_MARGIN_MS）以降
 *   （許可後のツール実行結果が書き込まれる。アイドル通知（入力待ち）では transcript は動かない）
 * 確認待ちになった直後（CONFIRM_RESUME_MIN_AGE_MS 未満）は判定しない。
 */
export function findResumedFromConfirm(targets: readonly ConfirmTarget[], deps: ConfirmResumeDeps): ConfirmResumeHit[] {
  const out: ConfirmResumeHit[] = [];
  const now = deps.now();
  for (const t of targets) {
    // 保持中（260908_1）: 入力待ち通知（idle）等はループ・バックグラウンド作業の最中にも来るので確認待ちにしない。
    // 許可要求は人が応えるまで確認待ちのまま（猶予も待たない = 通知の直後でも戻す）
    if (t.kind !== "permission") {
      const held = deps.heldReason?.(t.sessionId);
      if (held !== undefined) {
        out.push({ target: t, reason: "held", heldReason: held });
        continue;
      }
    }
    if (now - t.lastEventAt < CONFIRM_RESUME_MIN_AGE_MS) continue;
    if (deps.registryStatus(t.sessionId) === "busy") {
      out.push({ target: t, reason: "registry" });
      continue;
    }
    if (t.transcriptPath === undefined) continue;
    const mtime = deps.mtimeMs(t.transcriptPath);
    if (mtime === null) continue;
    if (mtime < t.lastEventAt + CONFIRM_RESUME_MARGIN_MS) continue;
    // 260909_1: 更新がターン開始（許可後のツール結果・プロンプト）でなければ復帰しない。2026-09-09 実測: 入力待ちのまま
    // /effort /model を打つと transcript が動き、実行中へ戻って 15 分後に「切断」になった
    if (deps.turnEnd !== undefined && deps.turnEnd(t.transcriptPath) !== "open") continue;
    out.push({ target: t, reason: "transcript" });
  }
  return out;
}

export interface IdleConcludedDeps {
  now(): number;
  /** 最終活動時刻（session-scan.activityMtimeMs を注入）。取得不可は null */
  mtimeMs(path: string): number | null;
  /** Claude Code の登録簿 status */
  registryStatus(sessionId: string): string | undefined;
  /** 作業継続中の保持（260908_1）。保持中は対象外 */
  heldReason?: HeldReasonFn;
}

/**
 * 待機中の取り残し検知（260909_1）: 「実行中」なのに Claude Code の登録簿が idle と申告し、transcript が
 * TRANSCRIPT_STALE_MS 以上動いていないセッション。プロセスは生きて入力待ちなので「切断」ではなく「完了」へ倒す。
 * 背景: 終端分類が open のまま（メタ・ローカルコマンド等）だと終了検知が効かず、15 分後に切断へ誤って倒れていた。
 * 登録簿 status が無い（Cursor 起動）・busy / shell / waiting は対象外（従来の判定に任せる）
 */
export function findIdleConcluded(targets: readonly SweepTarget[], deps: IdleConcludedDeps): SweepTarget[] {
  const out: SweepTarget[] = [];
  for (const t of targets) {
    if (t.transcriptPath === undefined) continue;
    if (deps.registryStatus(t.sessionId) !== "idle") continue;
    if (deps.heldReason?.(t.sessionId) !== undefined) continue;
    const mtime = deps.mtimeMs(t.transcriptPath);
    if (mtime === null) continue;
    if (deps.now() - mtime >= TRANSCRIPT_STALE_MS) out.push(t);
  }
  return out;
}

/** block された Stop の痕跡（session-scan.findBlockedStop の戻り値。260907_1 R2） */
export interface BlockedStop {
  /** stop_hook_summary の timestamp（epoch ms） */
  at: number;
  /** block 理由（hook の reason。空のこともある） */
  reason: string;
}

export interface StoppedTarget extends SweepTarget {
  state: "done" | "disconnected";
  /** 完了（Stop 受信）または切断判定の時刻（epoch ms） */
  lastEventAt: number;
}

export interface StoppedResumeDeps {
  now(): number;
  /** Claude Code の登録簿 status（busy / waiting / idle）。無ければ undefined */
  registryStatus(sessionId: string): string | undefined;
  /** transcript 終端の分類（session-scan.turnEndOf を注入） */
  turnEnd(path: string): "concluded" | "open" | "unknown";
  /** sinceMs 以降の block 痕跡（session-scan.blockedStopOf を注入） */
  blockedStop(path: string, sinceMs: number): BlockedStop | null;
  /** 本体 transcript と subagent 記録の新しい方の mtime（session-scan.activityMtimeMs を注入）。取得不可は null */
  activityMtimeMs(path: string): number | null;
  /** 作業継続中の保持（260908_1）。保持中の完了・切断は実行中へ戻す */
  heldReason?: HeldReasonFn;
}

export interface StoppedResumeHit {
  target: StoppedTarget;
  /** 何を根拠に復帰させたか（ログ用）: 登録簿が busy / Stop hook が続行を指示 / 切断後に transcript 更新 / 作業継続中の保持 */
  reason: "registry" | "blocked-stop" | "transcript" | "held";
  /** reason=blocked-stop のとき: block 理由（作業テキストのラベルに使う） */
  blockReason?: string;
  /** reason=held のとき: 保持の理由 */
  heldReason?: string;
}

/**
 * 完了・切断 → 実行中の復帰検知（260907_1 R1〜R3）。
 *
 * 背景: 品質ループ（eval-loop）中に (a) 司令塔が途中で応答を終える → eval-loop の Stop hook が block して続行、
 * でも本アプリの Stop hook は同時に「完了」を送る、(b) 同期 fork や codex 待ちで本体 transcript が止まり
 * 「切断」になる、の 2 経路で「まだ作業中なのに完了・切断のまま」になっていた（2026-09-07 実測）。
 * 完了・切断から実行中へ戻す経路は次のプロンプト（UserPromptSubmit）しか無かった。
 *
 * 根拠は 3 系統（上から順に評価し、最初に成立したものを理由にする）:
 * - R1 登録簿 status が busy、かつ transcript 終端が concluded でない（busy が古いまま残る事故への保険。
 *   transcript 不明・unknown は busy を信じる）。最終イベントから STOPPED_RESUME_MIN_AGE_MS 未満は判定しない
 * - R2 transcript に最終イベント−BLOCKED_STOP_MARGIN_MS 以降の block 痕跡（preventedContinuation=true）がある。
 *   登録簿 status の無い Cursor 起動でも使える
 * - R3 切断中のセッションで、本体または subagent 記録が切断判定より後に更新された。
 *   完了（done）には適用しない — Stop の後にも stop_hook_summary / turn_duration / メタが書かれるため
 */
export function findResumedFromStopped(targets: readonly StoppedTarget[], deps: StoppedResumeDeps): StoppedResumeHit[] {
  const out: StoppedResumeHit[] = [];
  const now = deps.now();
  for (const t of targets) {
    // 保持中（260908_1）: ループ進行中・バックグラウンド作業の完了待ちなら猶予を待たず実行中へ戻す
    const held = deps.heldReason?.(t.sessionId);
    if (held !== undefined) {
      out.push({ target: t, reason: "held", heldReason: held });
      continue;
    }
    if (now - t.lastEventAt < STOPPED_RESUME_MIN_AGE_MS) continue;
    if (deps.registryStatus(t.sessionId) === "busy") {
      if (t.transcriptPath === undefined || deps.turnEnd(t.transcriptPath) !== "concluded") {
        out.push({ target: t, reason: "registry" });
        continue;
      }
    }
    if (t.transcriptPath === undefined) continue;
    const blocked = deps.blockedStop(t.transcriptPath, t.lastEventAt - BLOCKED_STOP_MARGIN_MS);
    if (blocked !== null) {
      out.push({ target: t, reason: "blocked-stop", blockReason: blocked.reason });
      continue;
    }
    if (t.state === "disconnected") {
      const m = deps.activityMtimeMs(t.transcriptPath);
      if (m !== null && m > t.lastEventAt) out.push({ target: t, reason: "transcript" });
    }
  }
  return out;
}

export interface ConcludedSweepDeps {
  now(): number;
  /** transcript ファイルの mtime（epoch ms）。取得不可（不存在・権限）は null */
  mtimeMs(path: string): number | null;
  /** transcript 終端の分類（session-scan.turnEndOf を注入。concluded 以外は対象外） */
  turnEnd(path: string): "concluded" | "open" | "unknown";
  /** 作業継続中の保持（260908_1）。保持中は終了検知しない（Monitor 起床のたびにターンが閉じるため） */
  heldReason?: HeldReasonFn;
}

/**
 * 終了検知（260712_4）: 「実行中」のうち、transcript 終端がターン完了を示すものを返す。
 *
 * 背景: 割り込み（Esc）では Stop hook が発火しない（2026-07-11 実測 — transcript に
 * stop_hook_summary が無く "[Request interrupted by user for tool use]" のみ残る）。
 * その場合「実行中」から抜ける経路が無く、ウィンドウが生きている限り
 * 切断検知（HARD 15 分）までスピナーが回り続けた。呼び出し側はヒットを「完了」へ遷移させる。
 * 切断判定より先に適用する — 終了済みセッションを「切断」と誤表示しないため。
 */
export function findConcluded(targets: readonly SweepTarget[], deps: ConcludedSweepDeps): SweepTarget[] {
  const out: SweepTarget[] = [];
  for (const t of targets) {
    if (t.transcriptPath === undefined) continue; // 実データが無ければ判定しない（安全側）
    if (deps.heldReason?.(t.sessionId) !== undefined) continue; // 作業継続中の保持（260908_1）
    const mtime = deps.mtimeMs(t.transcriptPath);
    if (mtime === null) continue;
    if (deps.now() - mtime < CONCLUDED_MIN_AGE_MS) continue; // 直後は Stop が配送中かもしれない
    if (deps.turnEnd(t.transcriptPath) === "concluded") out.push(t);
  }
  return out;
}

/**
 * 1 回の掃引: 対象（実行中セッション）のうち切断と判定されたものを返す。
 * 純関数（依存は deps で注入）— 単体テスト対象。
 */
export function findDisconnected(targets: readonly SweepTarget[], deps: SweepDeps): SweepTarget[] {
  const out: SweepTarget[] = [];
  for (const t of targets) {
    if (t.transcriptPath === undefined) continue; // 実データが無ければ判定しない（安全側）
    const status = deps.registryStatus?.(t.sessionId);
    if (status === "busy") continue; // 登録簿が作業中と申告している間は切断しない（260907_1 R4）
    if (status === "idle") continue; // 生きて入力待ち = 切断ではない（260909_1。findIdleConcluded が「完了」へ倒す）
    if (deps.heldReason?.(t.sessionId) !== undefined) continue; // 作業継続中の保持（260908_1）
    const mtime = deps.mtimeMs(t.transcriptPath);
    if (mtime === null) continue; // stat 失敗（消失・権限）も安全側 — 一時的な失敗で切断を誤宣言しない
    const age = deps.now() - mtime;
    if (age >= TRANSCRIPT_STALE_HARD_MS) {
      out.push(t);
    } else if (age >= TRANSCRIPT_STALE_MS && deps.windowPresent(t.projectId) === false) {
      out.push(t);
    }
  }
  return out;
}
