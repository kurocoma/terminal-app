/**
 * main プロセスのエントリ（design.md 3 章の結線 / REQ-01〜REQ-11）。
 * モジュール分割: ①event-server ②state-store/project-store ③renderer(UI)
 * ④hooks-manager ⑤window-control（design.md 3.1）。
 *
 * 起動フラグ（検証・証跡用）:
 *   --demo               モック 1b 相当のデモデータで起動（一時データディレクトリ使用・hooks 追記なし）
 *   --demo-count=16      デモを 16 タイルに拡張（NFR-05 / V-15 用）
 *   --capture=<path>     指定パスへウィンドウのスクリーンショット PNG を保存して終了（FL2 証跡用）
 *   --capture-delay=<ms> キャプチャまでの待ち時間（既定 1600ms。擬似イベント注入の時間を確保する用途）
 *   --theme=<t>          テーマの一時上書き（light / dark / auto。ライトモード証跡用）
 *   --view=settings      設定画面を初期表示で開く（面 1d / 1f の証跡用）
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ClickTarget, DropPayload, OpResult, Project, RegisterResult, SessionState, SessionView, Snapshot, ThemeSetting, WindowAction, WindowBounds } from "../shared/types";
import { launchProjectApp } from "./app-launcher";
import { createAppRestarter } from "./app-restart";
import { seedDemo } from "./demo";
import { detectDevScript, DevServerManager } from "./dev-server";
import { extractDropPaths } from "./drop-paths";
import { loopStatusForSessions, type LoopStatus } from "./eval-loop-status";
import { buildListenErrorText, createEventServer, resolveAttemptedPort, type EventServer } from "./event-server";
import { ALL_HOOK_EVENTS, mergeHooks, mergeStatusLine, removeHooks, removeStatusLine } from "./hooks-manager";
import {
  DISCONNECT_CHECK_INTERVAL_MS,
  STOPPED_RESUME_MIN_AGE_MS,
  findConcluded,
  findDisconnected,
  findIdleConcluded,
  findResumedFromConfirm,
  findResumedFromStopped,
  type StoppedResumeDeps,
  type StoppedResumeHit,
} from "./liveness-monitor";
import { Logger } from "./logger";
import { shouldNotify } from "./notify-policy";
import { getDataDir } from "./paths";
import { resolveProjectRoot } from "./project-root";
import { ProjectStore, validateProjectDir } from "./project-store";
import { classifyLiveness, readSessionRegistry, registryStatusOf, type RegistryEntry } from "./session-registry";
import { activityMtimeMs, blockedStopOf, scanLiveSessions, turnEndOf } from "./session-scan";
import { fmtStats, parseStatusLinePayload } from "./statusline";
import { blockReasonToWorkText, classifyNotification, countTiles, matchProjectByCwd, StateStore } from "./state-store";
import { fmtWindowBounds } from "./window-bounds";
import {
  applyProjectWindowPlacement,
  focusProjectWindow,
  hasWindowFor,
  isAvailable as windowApiAvailable,
  listTopLevelWindows,
  readProjectWindowPlacement,
  type TopLevelWindow,
} from "./window-control";
import { computeWindowPresence, presenceDiff, presenceEquals, WINDOW_POLL_INTERVAL_MS, type WindowPresence } from "./window-presence";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found?.slice(prefix.length);
}

const demoMode = process.argv.includes("--demo") || argValue("demo-count") !== undefined;
const demoCount: 12 | 16 = argValue("demo-count") === "16" ? 16 : 12;
const capturePath = argValue("capture");
const captureDelayArg = Number(argValue("capture-delay") ?? "1600");
const captureDelay = Number.isFinite(captureDelayArg) && captureDelayArg >= 0 ? captureDelayArg : 1600;
const themeOverride = argValue("theme") as ThemeSetting | undefined;

// デモ・キャプチャ実行では実ユーザーの %APPDATA% を汚さない（一時ディレクトリへ差し替え）
if (demoMode && !process.env.TERMINAL_APP_DATA_DIR) {
  process.env.TERMINAL_APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-app-demo-"));
}

const dataDir = getDataDir();

// データディレクトリを差し替えた実行（検証・デモ）では Chromium プロファイル（userData）も隔離する。
// 実稼働インスタンスとプロファイルを共有すると、2 個目以降の起動がプロファイルロックの競合で
// ハング・大幅遅延しうる（検証スクリプトを実稼働アプリと並走させたときに顕在化）
if (process.env.TERMINAL_APP_DATA_DIR) {
  app.setPath("userData", path.join(dataDir, "electron-user-data"));
}
const logger = new Logger(dataDir);
const projectStore = new ProjectStore(dataDir, logger);
const stateStore = new StateStore();

let win: BrowserWindow | null = null;
let revision = 0;
let statusMessage = "";
let pinned = false;
/** 未接続タイル（260903_1）: projectId → 対象アプリのウィンドウ有無。pollWindowPresence が更新（デモはシード固定値） */
let windowPresence: WindowPresence = {};

/** NFR-01 計測: revision → イベント受信時刻。renderer の描画完了通知でログ差分を出す（verification.md 3.2） */
const pendingRender = new Map<number, number>();

function buildSnapshot(): Snapshot {
  const config = { ...projectStore.config };
  if (themeOverride !== undefined) config.theme = themeOverride;
  const projects = projectStore.projects;
  const sessions = stateStore.displaySessions(projects);
  const splitSessions = stateStore.splitSessions(projects);
  // 件数は「画面に出るタイル」基準（260904_1 #3: 分割タイルはそれぞれ 1 件）。renderer は表示整形のみ行う
  const tiles: SessionView[] = [];
  for (const p of projects) {
    const members = splitSessions[p.id];
    if (members !== undefined) tiles.push(...members);
    else if (sessions[p.id] !== undefined) tiles.push(sessions[p.id]);
  }
  return {
    revision,
    projects: [...projects],
    sessions,
    splitSessions,
    counts: countTiles(tiles),
    config,
    pinned,
    statusMessage,
    windowPresence: { ...windowPresence },
  };
}

function broadcast(receivedAt?: number): void {
  revision += 1;
  const canDeliver = win !== null && !win.isDestroyed();
  // 配信できない revision の計測開始点は記録しない（notify-rendered が来ず Map が育ち続けるのを防ぐ）
  if (receivedAt !== undefined && canDeliver) pendingRender.set(revision, receivedAt);
  if (canDeliver) {
    win?.webContents.send("snapshot", buildSnapshot());
  }
}

function setStatus(message: string): void {
  statusMessage = message;
  broadcast();
}

// 多重起動は禁止（design.md 8 章）。デモ・キャプチャ実行は通常インスタンスと共存可とする
let secondInstance = false;
if (!demoMode && capturePath === undefined) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    // quit は非同期のため、whenReady 側でも secondInstance を見て初期化を打ち切る
    // （2 個目のインスタンスが受信サーバの listen を試みて「ポート使用中」ダイアログを出す競合の防止）
    secondInstance = true;
    app.quit();
  } else {
    app.on("second-instance", () => {
      if (win !== null) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    });
  }
}

// 受信サーバは projectStore.load() 後（whenReady 内）に生成する。
// トップレベルで生成すると config.json 読み込み前の既定ポートを捕捉してしまい、
// 「config.json の port 変更が反映されない」バグになる（2026-07-11 検証で発見・修正）
let eventServer: EventServer | null = null;

/** セッションごとに最後に通知を出した状態（260712_5）。同一状態への再遷移で通知が連発するのを防ぐ */
const lastNotifiedState = new Map<string, SessionState>();

/* ---------------- 作業継続中の保持（260908_1） ---------------- */

/**
 * 進行中ループの停滞ガード: ループ側（state.json・codex 進捗ログ）と transcript のどちらも
 * この時間以上動いていなければ「進行中」の申告を信じない（司令塔が死んだまま active=true が残る残骸対策。30 分）
 */
const LOOP_HOLD_STALE_MS = 30 * 60_000;

/**
 * 直近に読んだループ状況（sessionId → 状況）。掃引で全セッション分を読み直し、Stop / Notification 受信時は
 * そのセッション分だけ読み直す（state.json の読み取り 1 回＋進捗ログの stat なので受信経路でも安い）
 */
const loopStatusCache = new Map<string, LoopStatus>();

/** ループ状況を読み直す（sessions 省略時は保持中の全セッション）。読み取り失敗は警告ログのみで前回値を維持 */
function refreshLoopStatus(sessions?: ReadonlyArray<{ sessionId: string; cwd?: string; projectPath: string }>): void {
  const targets = sessions ?? stateStore.loopLookupSessions(projectStore.projects);
  if (targets.length === 0) return;
  let statuses: Map<string, LoopStatus>;
  try {
    statuses = loopStatusForSessions(targets, Date.now());
  } catch (e) {
    logger.warn(`ループ進捗の読み取りに失敗（前回値を維持）: ${String(e)}`);
    return;
  }
  for (const t of targets) {
    const st = statuses.get(t.sessionId);
    if (st === undefined) loopStatusCache.delete(t.sessionId);
    else loopStatusCache.set(t.sessionId, st);
  }
}

/** 受信イベントのセッション分だけループ状況を読み直す（まだ StateStore に無いセッションでも cwd から探せる） */
function refreshLoopStatusForEvent(sessionId: string, cwd: string): void {
  const project = matchProjectByCwd(cwd, projectStore.projects);
  if (project === null) return;
  refreshLoopStatus([{ sessionId, cwd, projectPath: project.path }]);
}

/**
 * 品質ループ進行中による保持理由。active=true で codex ジョブが走っていれば無条件、そうでなければ停滞ガード付き。
 * 戻り値: 保持する理由（undefined = 保持しない）
 */
function loopHoldReason(sessionId: string): string | undefined {
  const st = loopStatusCache.get(sessionId);
  if (st === undefined || !st.active) return undefined;
  const label = st.text !== undefined ? `（${st.text}）` : "";
  if (st.job !== null) return `ループ進行中${label}`;
  let last = st.lastActivityMs;
  const transcriptPath = stateStore.transcriptPathOf(sessionId);
  if (transcriptPath !== undefined) {
    const m = activityMtimeMs(transcriptPath);
    if (m !== null && (last === undefined || m > last)) last = m;
  }
  if (last !== undefined && Date.now() - last > LOOP_HOLD_STALE_MS) return undefined; // 停滞: 申告を信じない
  return `ループ進行中${label}`;
}

/**
 * バックグラウンド作業の完了待ちによる保持理由（260908_1）: 直近のプロンプトが task-notification（Monitor /
 * バックグラウンド Bash の通知による起床）で、かつ Claude Code の登録簿 status が idle / waiting でない
 * （2026-09-08 実測: バックグラウンドの shell と Monitor が残ったまま応答を終えると status="shell" になる）
 */
function backgroundHoldReason(sessionId: string, registry: RegistryEntry[] | null): string | undefined {
  if (!stateStore.isBackgroundDriven(sessionId)) return undefined;
  const status = registryStatusOf(registry, sessionId);
  if (status === undefined || status === "idle" || status === "waiting") return undefined;
  return `バックグラウンド作業の完了待ち（登録簿 status=${status}）`;
}

/** 作業継続中の保持理由（ループ → バックグラウンドの順。undefined = 保持しない） */
function heldReasonFor(sessionId: string, registry: RegistryEntry[] | null): string | undefined {
  return loopHoldReason(sessionId) ?? backgroundHoldReason(sessionId, registry);
}

/** 現在「保持」でタイルを実行中に保っているセッション（sessionId → 理由。保持開始・解除のログ用） */
const heldSessions = new Map<string, string>();
/** 保持が解けたが、まだ完了へ倒れていない（次の掃引で終了検知されたら完了トーストを出す）セッション */
const releasedPendingToast = new Set<string>();

/** 保持の記録を更新し、保持開始・解除をログに残す */
function trackHeld(sessionIds: readonly string[], held: (sid: string) => string | undefined): void {
  for (const sid of sessionIds) {
    const reason = held(sid);
    const prev = heldSessions.get(sid);
    if (reason !== undefined) {
      if (prev === undefined) {
        heldSessions.set(sid, reason);
        releasedPendingToast.delete(sid);
        logger.info(`作業継続中として保持: ${projectNameOfSession(sid)} (session=${sid}) — ${reason}`);
      } else if (prev !== reason) {
        heldSessions.set(sid, reason);
      }
    } else if (prev !== undefined) {
      heldSessions.delete(sid);
      releasedPendingToast.add(sid);
      logger.info(`保持を解除: ${projectNameOfSession(sid)} (session=${sid}) — 直前の理由: ${prev}`);
    }
  }
}

function projectNameOfSession(sessionId: string): string {
  const view = stateStore.displaySessions(projectStore.projects);
  const pid = Object.keys(view).find((k) => view[k].sessionId === sessionId);
  return pid !== undefined ? (projectStore.getProject(pid)?.name ?? pid) : sessionId;
}

/** 保持が解けて完了になったときのトースト（ループが終わっていればその結果を本文にする） */
function showReleasedToast(sessionId: string, project: Project | null): void {
  releasedPendingToast.delete(sessionId);
  if (project === null) return;
  const loopText = loopStatusCache.get(sessionId)?.text;
  const body = loopText !== undefined && loopText.startsWith("ループ終了") ? `${loopText}。応答が完了しました。` : "応答が完了しました。";
  showSessionToast(project, `${project.name}: セッションが完了しました`, body);
  lastNotifiedState.set(sessionId, "done");
}

/**
 * Stop 受信後の前倒し判定（260907_1 R6）: sessionId → タイマー。
 * Stop hook が block されて続行した場合、本アプリの Stop hook は同時に「完了」を送ってくる。
 * 「完了」への遷移は即時に行い、STOP_RECHECK_DELAY_MS 後に登録簿・transcript を見て
 * まだ作業中なら「実行中」へ戻す。完了トーストはこの判定の後に出す（誤通知の防止）
 */
const pendingStopChecks = new Map<string, NodeJS.Timeout>();
/** Stop 受信 → 前倒し判定までの待ち = 登録簿が idle へ切り替わる猶予（STOPPED_RESUME_MIN_AGE_MS）＋余裕 */
const STOP_RECHECK_DELAY_MS = STOPPED_RESUME_MIN_AGE_MS + 500;

function cancelPendingStopCheck(sessionId: string): void {
  const timer = pendingStopChecks.get(sessionId);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingStopChecks.delete(sessionId);
}

function cancelAllPendingStopChecks(): void {
  for (const timer of pendingStopChecks.values()) clearTimeout(timer);
  pendingStopChecks.clear();
}

/** 完了・切断 → 実行中の復帰判定に渡す依存（掃引・前倒し判定で共通。260907_1） */
function stoppedResumeDeps(registry: RegistryEntry[] | null): StoppedResumeDeps {
  return {
    now: () => Date.now(),
    registryStatus: (sid) => registryStatusOf(registry, sid),
    turnEnd: turnEndOf,
    blockedStop: blockedStopOf,
    activityMtimeMs,
    heldReason: (sid) => heldReasonFor(sid, registry),
  };
}

/** 復帰ヒットの適用（掃引・前倒し判定の共通処理）。戻り値: 実際に「実行中」へ戻したか */
function applyStoppedResume(hit: StoppedResumeHit): boolean {
  const sid = hit.target.sessionId;
  const label = hit.blockReason !== undefined ? blockReasonToWorkText(hit.blockReason) : undefined;
  if (!stateStore.resumeFromStopped(sid, label)) return false;
  lastNotifiedState.set(sid, "running"); // 本当の完了で再び通知できるように
  const project = projectStore.getProject(hit.target.projectId);
  const from = hit.target.state === "done" ? "完了" : "切断";
  const why =
    hit.reason === "registry"
      ? "登録簿 status=busy（Claude Code は作業中と申告）"
      : hit.reason === "blocked-stop"
        ? `Stop hook が続行を指示${label !== undefined ? ` ${label}` : ""}`
        : hit.reason === "held"
          ? (hit.heldReason ?? "作業継続中")
          : "切断後に transcript（本体または subagent 記録）が更新";
  logger.info(`${from}から実行中へ復帰: ${project?.name ?? hit.target.projectId} (session=${sid}) — ${why}`);
  return true;
}

/**
 * Stop 受信の STOP_RECHECK_DELAY_MS 後: まだ作業中（登録簿 busy／block 痕跡）なら完了を取り消して実行中へ戻し、
 * そうでなければここで完了トーストを出す（260907_1 R6）。同じセッションの次のイベントで取り消される
 */
function scheduleStopRecheck(sessionId: string, notify: boolean, project: Project | null, cwd: string, held: boolean): void {
  cancelPendingStopCheck(sessionId);
  const timer = setTimeout(() => {
    pendingStopChecks.delete(sessionId);
    const registry = readSessionRegistry();
    refreshLoopStatusForEvent(sessionId, cwd);
    if (held) {
      // 保持したまま Stop を受けた（260908_1）: ループ終了（Stop hook の中で active=false になる）や
      // バックグラウンド作業の終了で保持が解けていれば、ここで「完了」にしてトーストを出す。まだ保持中なら掃引に任せる
      if (heldReasonFor(sessionId, registry) !== undefined) return;
      const running = stateStore.runningSessions().find((t) => t.sessionId === sessionId);
      if (running === undefined) return; // その後のイベント・掃引で状態が変わった
      if (running.transcriptPath !== undefined && turnEndOf(running.transcriptPath) === "open") return; // 続行中（block 等）
      if (!stateStore.markConcluded(sessionId)) return;
      heldSessions.delete(sessionId);
      logger.info(`保持を解除 → 完了: ${project?.name ?? sessionId} (session=${sessionId})`);
      if (notify) showReleasedToast(sessionId, project);
      else releasedPendingToast.delete(sessionId);
      broadcast();
      return;
    }
    const target = stateStore.stoppedSessions().find((t) => t.sessionId === sessionId && t.state === "done");
    if (target === undefined) return; // その後のイベント・掃引で状態が変わった
    const hits = findResumedFromStopped([target], stoppedResumeDeps(registry));
    if (hits.length > 0 && applyStoppedResume(hits[0])) {
      broadcast();
      return;
    }
    if (notify && project !== null) {
      showSessionToast(project, `${project.name}: セッションが完了しました`, "応答が完了しました。");
    }
  }, STOP_RECHECK_DELAY_MS);
  pendingStopChecks.set(sessionId, timer);
}

function createAppEventServer(): EventServer {
  return createEventServer({
    // デモ実行は hooks を書かず受信も不要のため空きポート（0）で listen し、
    // 実稼働インスタンス（既定 41321）と並走しても EADDRINUSE を起こさない（260712 課題C）
    port: demoMode ? 0 : projectStore.config.port,
    onEvent: (evt, receivedAt) => {
      cancelPendingStopCheck(evt.session_id); // 新しいイベントが来たら Stop 後の前倒し判定は取り消す（260907_1 R6）
      releasedPendingToast.delete(evt.session_id);
      // 作業継続中の保持（260908_1）: Stop と許可要求以外の Notification は、ループ進行中・バックグラウンド作業の
      // 完了待ちなら「完了」「確認待ち」にせず実行中を保つ（Monitor 起床のたびに Stop が来る司令塔セッション向け）
      const holdCandidate =
        evt.hook_event_name === "Stop" ||
        (evt.hook_event_name === "Notification" && classifyNotification(evt.message, evt.notification_type) !== "permission");
      let hold: string | undefined;
      if (holdCandidate) {
        refreshLoopStatusForEvent(evt.session_id, evt.cwd);
        hold = heldReasonFor(evt.session_id, readSessionRegistry());
      }
      const result = stateStore.applyEvent(evt, projectStore.projects, { holdRunning: hold !== undefined });
      if (result === null) {
        // design.md 10 章: 未登録 cwd・正常 SessionEnd は破棄してログのみ（UI は変えない）
        logger.info(`event 破棄: ${evt.hook_event_name} cwd=${evt.cwd}`);
        return;
      }
      if (evt.hook_event_name === "SessionStart") {
        // 新しいセッションの開始（260909_1）: 同じプロジェクトの終了済み・切断の記録を消した。表示は待機へ戻る
        for (const sid of result.prunedSessions ?? []) {
          cancelPendingStopCheck(sid);
          lastNotifiedState.delete(sid);
          heldSessions.delete(sid);
          releasedPendingToast.delete(sid);
          loopStatusCache.delete(sid);
        }
        logger.info(
          `event 受信: SessionStart（source=${evt.source ?? "?"}）→ 終了済み・切断の記録を ${result.prunedSessions?.length ?? 0} 件消去 (project=${result.projectId}, session=${result.sessionId})`
        );
        broadcast(receivedAt);
        return;
      }
      if (result.discardedRunning === true) {
        // 正常 SessionEnd: 実行中のまま終了したセッションの記録を破棄（260712 課題A の幽霊実行中防止）
        logger.info(`event 受信: SessionEnd（正常終了）→ 実行中セッションの記録を破棄 (project=${result.projectId}, session=${result.sessionId})`);
      } else {
        const detail =
          evt.hook_event_name === "Notification"
            ? ` 種別=${classifyNotification(evt.message, evt.notification_type)}${evt.notification_type !== undefined ? `(${evt.notification_type})` : ""}`
            : "";
        const heldNote = hold !== undefined ? `（実行中を維持: ${hold}）` : "";
        logger.info(
          `event 受信: ${evt.hook_event_name}${detail} → ${result.state}${heldNote} (project=${result.projectId}, session=${result.sessionId})`
        );
      }
      if (hold !== undefined) heldSessions.set(result.sessionId, hold);
      // 完了・確認待ちのトースト通知（260712_5）。状態が実際に変化したときのみ通知する
      // （同一状態への再遷移では通知しない = 過剰通知の抑制）
      const project = projectStore.getProject(result.projectId);
      if (evt.hook_event_name === "Stop") {
        // 保持中の Stop は「完了」にしていないので、通知要否は「完了になったとしたら」で判定する
        const notify = shouldNotify(lastNotifiedState.get(result.sessionId), "done");
        // 完了トーストは前倒し判定の後（最大 STOP_RECHECK_DELAY_MS 遅れ）— block された Stop で誤通知しないため（260907_1 R6）
        scheduleStopRecheck(result.sessionId, notify, project, evt.cwd, hold !== undefined);
      } else if (result.state === "confirm" && project !== null && shouldNotify(lastNotifiedState.get(result.sessionId), "confirm")) {
        showSessionToast(project, `${project.name}: 確認が必要です`, "権限確認や入力待ちが発生しています。");
      }
      lastNotifiedState.set(result.sessionId, result.state);
      broadcast(receivedAt);
    },
    // statusLine 転送（260712_3 案A）: メトリクスをタイルへ反映し、整形テキストを
    // レスポンス本文として返す（curl 経由でそのままターミナルの statusline 表示になる）。
    // 高頻度（最大 300ms 間隔）のため、表示値が変わったときだけ broadcast する。
    onStatusLine: (payload) => {
      const metrics = parseStatusLinePayload(payload);
      if (metrics === null) return null;
      const text = fmtStats(metrics);
      if (stateStore.applyStatusStats(metrics.sessionId, text)) broadcast();
      return text ?? null;
    },
    logger,
  });
}

/* ---------------- 切断検知（260712_2） ---------------- */

let livenessTimer: NodeJS.Timeout | null = null;
/** 未接続タイル（260903_1）のウィンドウ有無ポーリング */
let windowPollTimer: NodeJS.Timeout | null = null;
/** 初回判定済みか（初回ログの要約用） */
let windowPollDone = false;

const appRestarter = createAppRestarter({
  cleanup: async () => {
    // app.exit() は will-quit を発火しないため、再起動経路では定期処理とサーバを明示的に止める。
    if (livenessTimer !== null) {
      clearInterval(livenessTimer);
      livenessTimer = null;
    }
    if (windowPollTimer !== null) {
      clearInterval(windowPollTimer);
      windowPollTimer = null;
    }
    cancelAllPendingRestores();
    cancelAllPendingStopChecks(); // Stop 後の前倒し判定（260907_1）を残さない
    await devServers.stopAll(); // 起動した開発サーバーを残さない（260722_1）
    await (eventServer?.close() ?? Promise.resolve());
  },
  relaunch: () => {
    // 引数なしの relaunch は argv/cwd（--demo 等を含む）を引き継ぐ。
    // 旧プロセスの終了後に新プロセスを起動するため、requestSingleInstanceLock と競合しない。
    app.relaunch();
  },
  // app.quit() と異なり終了イベントで阻止されない。必要な後始末は cleanup で完了させる。
  exit: (code) => app.exit(code),
  // Logger は同期追記のため、exit 直前の記録もファイルへ残る。
  log: (message) => logger.info(message),
});

function statMtimeMs(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/** terminal-app 自体のウィンドウを前面化する（通知クリックのフォールバック・従来のクリック挙動） */
function focusOwnWindow(): void {
  if (win === null) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Windows トースト通知の共通発火処理（260712_2 で導入、260712_5 で汎用化、260712_6 でクリック時の
 * 前面化先を対象プロジェクトへ変更）。
 * `Notification.isSupported()` ガード・`silent: true`、を 1 箇所に集約する。
 * クリック時: project が特定できればタイルクリックと同じ `focusProjectWindow` で対象アプリを
 * 前面化する（design.md 7.2 の手順。本アプリがフォアグラウンド＝クリック直後のため
 * SetForegroundWindow の権限内）。対象が見つからない・project が無い場合は terminal-app 自体を
 * 前面化するフォールバックにする（何も起きないより、タイル一覧からの手動操作に繋げられる方がよい）。
 * 通知音は REQ-12（次期）まで鳴らさない = silent 固定。
 */
function showSessionToast(project: Project | null, title: string, body: string): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: true });
  n.on("click", () => {
    if (project === null) {
      focusOwnWindow();
      return;
    }
    const outcome = focusProjectWindow(project.clickTarget, path.basename(project.path));
    logger.info(`通知クリックで前面化 ${outcome.ok ? "成功" : "失敗"}: ${project.name} → ${project.clickTarget}${outcome.message ? ` (${outcome.message})` : ""}`);
    if (!outcome.ok) focusOwnWindow();
  });
  n.show();
}

/** 切断トースト（260712_2） */
function showDisconnectToast(project: Project | null, projectName: string): void {
  showSessionToast(
    project,
    `${projectName}: セッションが切断されました`,
    "終了の合図が届かないまま更新が止まりました。タイル右クリック →「再接続」で拾い直せます。"
  );
}

/** ループ進捗バッジを出しているセッション（260907_2。出現・消滅のログ用） */
const loopBadgeShown = new Set<string>();

/**
 * ループ進捗バッジ（260907_2）: eval-loop の registry / state.json / codex ジョブから各セッションの文言を作り
 * StateStore に載せる。戻り値: 表示が変わったか。読み取りの失敗は警告ログのみで掃引を止めない
 */
function updateLoopTexts(): boolean {
  const ids = stateStore.sessionIds();
  if (ids.length === 0) return false;
  let changed = false;
  for (const sid of ids) {
    const text = loopStatusCache.get(sid)?.text;
    if (!stateStore.applyLoopText(sid, text)) continue;
    changed = true;
    const shown = loopBadgeShown.has(sid);
    if (text !== undefined && !shown) {
      loopBadgeShown.add(sid);
      const view = stateStore.displaySessions(projectStore.projects);
      const pid = Object.keys(view).find((k) => view[k].sessionId === sid);
      const name = pid !== undefined ? (projectStore.getProject(pid)?.name ?? pid) : sid;
      logger.info(`ループ進捗バッジ 表示: ${name} (session=${sid}) — ${text}`);
    } else if (text === undefined && shown) {
      loopBadgeShown.delete(sid);
      const view = stateStore.displaySessions(projectStore.projects);
      const pid = Object.keys(view).find((k) => view[k].sessionId === sid);
      const name = pid !== undefined ? (projectStore.getProject(pid)?.name ?? pid) : sid;
      logger.info(`ループ進捗バッジ 消滅: ${name} (session=${sid})`);
    }
  }
  return changed;
}

/**
 * 登録簿で「終了」を何回連続で観測したら確定させるか（260904_1 #3）。
 * 登録簿ファイルは status 変化のたびに書き換わるため、書き込み途中を読むと 1 回だけ「無い」に見える
 */
const DEAD_STRIKES_REQUIRED = 2;
/** sessionId → 連続で終了と観測した回数 */
const deadStrikes = new Map<string, number>();

/**
 * 1 掃引（15 秒ごと）:
 * (0) 生死判定（260904_1 #3）: Claude Code の登録簿（~/.claude/sessions）と PID 存在で各セッションの
 *     生死を反映する。終了したセッションは分割タイルから外れ、同じプロジェクトに生存があれば記録ごと破棄。
 *     実行中のまま終了していれば「切断」へ（transcript の無更新を待たずに確定）。
 * (1) 確認待ちからの復帰（260904_1 #2）: 許可後に作業が再開された（transcript 更新／登録簿 busy）
 *     確認待ちセッションを「実行中」へ戻す。
 * 以下は実行中セッションについて
 * (2) 終了検知（260712_4）: transcript 終端がターン完了を示すものを「完了」へ —
 *     割り込み（Esc）では Stop hook が発火せず、実行中のまま取り残されるため。
 *     切断判定より先に行う（終了済みセッションを「切断」と誤表示しない）。
 * (3) 切断検知: transcript 更新時刻とウィンドウ存在で「切断」へ遷移 ＋ トースト通知。
 * ウィンドウ列挙（EnumWindows）は 1 掃引につき最大 1 回に抑える（遅延取得）。
 */
function sweepLiveness(): void {
  let changed = false;

  const registry = readSessionRegistry();
  // ループ状況の読み直し（260908_1）: 以降の保持判定・バッジ更新はこの掃引で読んだ値を使う
  refreshLoopStatus();
  const held = (sid: string): string | undefined => heldReasonFor(sid, registry);
  if (registry !== null) {
    for (const sid of stateStore.sessionIds()) {
      if (classifyLiveness(registry, sid) === "alive") {
        deadStrikes.delete(sid);
        if (stateStore.setDead(sid, false)) changed = true;
        continue;
      }
      const strikes = (deadStrikes.get(sid) ?? 0) + 1;
      deadStrikes.set(sid, strikes);
      if (strikes < DEAD_STRIKES_REQUIRED) continue;
      if (stateStore.setDead(sid, true)) {
        changed = true;
        logger.info(`セッション終了を確認（登録簿にプロセスなし）: session=${sid}`);
      }
      if (stateStore.markDisconnected(sid)) {
        changed = true;
        logger.info(`実行中のまま終了 → 切断表示: session=${sid}`);
      }
    }
    const pruned = stateStore.pruneDeadSessions();
    for (const sid of pruned) {
      deadStrikes.delete(sid);
      lastNotifiedState.delete(sid);
    }
    if (pruned.length > 0) {
      changed = true;
      logger.info(`終了済みセッションの記録を破棄（同じプロジェクトに生存あり）: ${pruned.join(", ")}`);
    }
  }

  const confirmTargets = stateStore.confirmSessions();
  if (confirmTargets.length > 0) {
    const resumed = findResumedFromConfirm(confirmTargets, {
      now: () => Date.now(),
      mtimeMs: statMtimeMs,
      registryStatus: (sid) => registryStatusOf(registry, sid),
      heldReason: held,
      turnEnd: turnEndOf,
    });
    for (const hit of resumed) {
      if (!stateStore.resumeFromConfirm(hit.target.sessionId)) continue;
      changed = true;
      lastNotifiedState.set(hit.target.sessionId, "running"); // 次の確認待ちで再び通知できるように
      const project = projectStore.getProject(hit.target.projectId);
      const why =
        hit.reason === "registry" ? "登録簿 status=busy" : hit.reason === "held" ? (hit.heldReason ?? "作業継続中") : "許可後に transcript が更新";
      logger.info(`確認待ちから復帰: ${project?.name ?? hit.target.projectId} (session=${hit.target.sessionId}) — ${why}`);
    }
  }

  // (1') 完了・切断からの復帰（260907_1 R1〜R3）: Stop hook が block されて続行した／登録簿が作業中と申告している／
  //      切断後に transcript（本体・subagent 記録）が動いた セッションを「実行中」へ戻す
  const stoppedTargets = stateStore.stoppedSessions();
  if (stoppedTargets.length > 0) {
    for (const hit of findResumedFromStopped(stoppedTargets, stoppedResumeDeps(registry))) {
      cancelPendingStopCheck(hit.target.sessionId); // 掃引が先に戻したので前倒し判定（とそのトースト）は不要
      if (applyStoppedResume(hit)) changed = true;
    }
  }

  // (1'') ループ進捗バッジ（260907_2）: eval-loop の registry / state.json から各セッションの進捗文言を更新する。
  //       状態遷移には触れない（statusLine 転送と同じ扱い）。出現・消滅だけログに残す（経過分の変化は残さない）
  if (updateLoopTexts()) changed = true;

  const targets = stateStore.runningSessions();
  // 保持の開始・解除を記録（260908_1）。実行中でなくなったセッションの記録は消す
  trackHeld(targets.map((t) => t.sessionId), held);
  for (const sid of [...heldSessions.keys()]) {
    if (!targets.some((t) => t.sessionId === sid)) heldSessions.delete(sid);
  }
  if (targets.length === 0) {
    if (changed) broadcast();
    return;
  }

  const concludedHits = findConcluded(targets, { now: () => Date.now(), mtimeMs: statMtimeMs, turnEnd: turnEndOf, heldReason: held });
  const concludedIds = new Set<string>();
  for (const t of concludedHits) {
    if (!stateStore.markConcluded(t.sessionId)) continue;
    changed = true;
    concludedIds.add(t.sessionId);
    const project = projectStore.getProject(t.projectId);
    logger.info(
      `終了検知: ${project?.name ?? t.projectId} (session=${t.sessionId}) — Stop 未受信だが transcript がターン完了を示すため「完了」へ`
    );
    // 保持が解けた直後の終了検知（ループ終了・バックグラウンド作業終了）は本当の完了なのでトーストを出す（260908_1）
    if (releasedPendingToast.has(t.sessionId) && shouldNotify(lastNotifiedState.get(t.sessionId), "done")) {
      showReleasedToast(t.sessionId, project);
    }
    releasedPendingToast.delete(t.sessionId);
  }

  // (2') 待機中の取り残し（260909_1）: 登録簿 idle のまま transcript が止まっているものは「完了」へ（切断ではない）
  for (const t of findIdleConcluded(targets.filter((t) => !concludedIds.has(t.sessionId)), {
    now: () => Date.now(),
    mtimeMs: activityMtimeMs,
    registryStatus: (sid) => registryStatusOf(registry, sid),
    heldReason: held,
  })) {
    if (!stateStore.markConcluded(t.sessionId)) continue;
    changed = true;
    concludedIds.add(t.sessionId);
    const project = projectStore.getProject(t.projectId);
    logger.info(`終了検知: ${project?.name ?? t.projectId} (session=${t.sessionId}) — 登録簿 status=idle のまま transcript が無更新のため「完了」へ`);
    releasedPendingToast.delete(t.sessionId);
  }

  const rest = targets.filter((t) => !concludedIds.has(t.sessionId));
  let windows: TopLevelWindow[] | null = null;
  const windowPresent = (projectId: string): boolean | null => {
    const project = projectStore.getProject(projectId);
    if (project === null || !windowApiAvailable()) return null; // 判定不能 → liveness-monitor 側で安全側に扱う
    if (windows === null) windows = listTopLevelWindows();
    return hasWindowFor(project.clickTarget, path.basename(project.path), windows);
  };
  // 無更新の判定は subagent 記録も含めた最終活動時刻で行い、登録簿が busy の間は切断しない（260907_1 R4）
  const hits = findDisconnected(rest, {
    now: () => Date.now(),
    mtimeMs: activityMtimeMs,
    windowPresent,
    registryStatus: (sid) => registryStatusOf(registry, sid),
    heldReason: held,
  });
  for (const t of hits) {
    if (!stateStore.markDisconnected(t.sessionId)) continue;
    changed = true;
    const project = projectStore.getProject(t.projectId);
    const name = project?.name ?? t.projectId;
    logger.warn(`切断検知: ${name} (session=${t.sessionId}) — transcript 更新途絶`);
    showDisconnectToast(project, name);
  }
  if (changed) broadcast();
}

/* ---------------- 未接続タイル（260903_1） ---------------- */

/**
 * 1 回の判定: 登録済み全プロジェクトについて「クリックで開く対象アプリ（Cursor / ターミナル）の
 * ウィンドウが今あるか」を EnumWindows 1 回分の結果から求め、変化があったときだけ broadcast する。
 * 判定条件は前面化・切断検知と同じ hasWindowFor（window-presence.ts）。
 * koffi 未ロード（判定不能）のときは空マップ = renderer は全タイルを「接続あり」扱いにする（安全側）。
 */
function pollWindowPresence(): void {
  let next: WindowPresence = {};
  if (windowApiAvailable() && projectStore.projects.length > 0) {
    try {
      next = computeWindowPresence(projectStore.projects, listTopLevelWindows());
    } catch (e) {
      logger.warn(`ウィンドウ有無の判定に失敗（前回値を維持）: ${String(e)}`);
      return;
    }
  }
  const first = !windowPollDone;
  windowPollDone = true;
  if (presenceEquals(windowPresence, next)) return;
  const diff = presenceDiff(windowPresence, next);
  if (first) {
    // 初回は全プロジェクト分の変化になるため 1 行に要約（以後は変化したタイルだけ個別に記録）
    const unlinked = diff.filter((d) => !d.present).map((d) => projectStore.getProject(d.id)?.name ?? d.id);
    logger.info(`ウィンドウ判定（初回）: 接続 ${diff.length - unlinked.length} / 未接続 ${unlinked.length}${unlinked.length > 0 ? ` [${unlinked.join(", ")}]` : ""}`);
  } else {
    for (const d of diff) {
      const name = projectStore.getProject(d.id)?.name ?? d.id;
      logger.info(`ウィンドウ${d.present ? "検出（接続）" : "消失（未接続）"}: ${name}`);
    }
  }
  windowPresence = next;
  broadcast();
}

/** D&D 登録（design.md 3.2(a): パス検証 → hooks マージ → projects 追加。失敗時は登録しない） */
function registerProject(dirPath: string): RegisterResult {
  // 事前検証は ProjectStore と共通の validateProjectDir に集約
  // （hooks マージより先に弾くことで、無効パスへの .claude/ 作成を防ぐ）
  const valid = validateProjectDir(dirPath, projectStore.projects);
  if (!valid.ok) {
    return { ok: false, path: dirPath, error: valid.error };
  }
  const merged = mergeHooks(dirPath, projectStore.config.port, ALL_HOOK_EVENTS);
  if (!merged.ok) {
    // design.md 3.2(a) 失敗時: settings.json に書き込まず、登録も行わない
    logger.error(`hooks マージ失敗のため登録中止: ${dirPath} — ${merged.error}`);
    return { ok: false, path: dirPath, error: merged.error };
  }
  // statusLine 転送（260712_3 案A）は付加機能のため、失敗しても登録は続行する（ログのみ）
  const sl = mergeStatusLine(dirPath, projectStore.config.port);
  if (!sl.ok) logger.warn(`statusLine 設定失敗（登録は続行）: ${dirPath} — ${sl.error}`);
  else if (sl.skipped === true) logger.info(`statusLine は既存のユーザー設定を尊重（設定せず）: ${dirPath}`);
  const added = projectStore.addProject(dirPath);
  if (!added.ok || added.project === undefined) {
    removeHooks(dirPath, ALL_HOOK_EVENTS); // 追加に失敗したらマージを巻き戻す
    removeStatusLine(dirPath);
    return { ok: false, path: dirPath, error: added.error };
  }
  logger.info(`プロジェクト登録: ${dirPath} (hooks 書込=${merged.changed}, statusLine=${sl.skipped === true ? "skip" : String(sl.changed)})`);
  return { ok: true, path: dirPath, projectId: added.project.id };
}

/** 登録解除の本体（設定画面の IPC と右クリックメニューの両方から呼ぶ。260712_2 でハンドラから抽出） */
async function unregisterProjectById(id: string): Promise<OpResult> {
  const project = projectStore.getProject(id);
  if (project === null) return { ok: false, error: "プロジェクトが見つかりません" };
  // 起動中の開発サーバーは、タイル（= 停止導線）が消える前に止める（260722_1 レビュー指摘）
  if (devServers.isRunning(id)) {
    const stopped = await devServers.stop(id);
    logger.info(
      `dev-server 停止（登録解除に伴う）${stopped.ok ? "成功" : "失敗"}: ${project.name}${stopped.error !== undefined ? ` — ${stopped.error}` : ""}`
    );
  }
  const removed = removeHooks(project.path, ALL_HOOK_EVENTS);
  if (!removed.ok) {
    // design.md 4.2 除去: パース失敗時は中断（手動対応を促す）。登録は残す
    logger.error(`hooks 除去失敗: ${project.path} — ${removed.error}`);
    setStatus(`hooks を除去できません（手動確認が必要）: ${removed.error ?? ""}`);
    return { ok: false, error: removed.error };
  }
  const slRemoved = removeStatusLine(project.path);
  if (!slRemoved.ok) logger.warn(`statusLine 除去失敗（解除は続行）: ${project.path} — ${slRemoved.error}`);
  projectStore.removeProject(id);
  stateStore.removeProjectSessions(id); // 解除済みプロジェクトのセッションを保持し続けない（メモリ整理）
  logger.info(`プロジェクト登録解除: ${project.path} (hooks 除去=${removed.changed}, statusLine 除去=${slRemoved.changed})`);
  broadcast();
  return { ok: true };
}

/**
 * 再接続（260712_2、260712_4 で終端分類対応）: transcript 走査でセッションを復元する。
 * アプリ再起動（セッションは揮発）後や切断誤検知からの復帰の手動導線。
 * 復元状態は transcript 終端で決まる（終了済み →「完了」/ 進行中 →「実行中」）。
 */
function reconnectProject(id: string): void {
  const project = projectStore.getProject(id);
  if (project === null) return;
  const found = scanLiveSessions(project.path);
  let revived = 0;
  let concluded = 0;
  for (const s of found) {
    const ok = stateStore.reviveSession({
      sessionId: s.sessionId,
      projectId: id,
      lastEventAt: s.mtimeMs,
      transcriptPath: s.transcriptPath,
      workText: s.workText,
      turnEnd: s.turnEnd,
    });
    if (!ok) continue;
    revived += 1;
    if (s.turnEnd === "concluded") concluded += 1;
  }
  const detail = concluded > 0 ? `（うち終了済み → 完了 ${concluded} 件）` : "";
  logger.info(`再接続: ${project.name} — 走査 ${found.length} 件 / 復元 ${revived} 件${detail}`);
  setStatus(
    revived > 0
      ? `再接続: ${project.name} のセッション ${revived} 件を復元しました${detail}`
      : `再接続: ${project.name} に動作中のセッションは見つかりませんでした`
  );
}

/* ---------------- 開発サーバー起動・停止（260722_1） ---------------- */

/**
 * タイル右クリック →「ブラウザで開く」の本体。起動〜URL 検出〜ブラウザ表示〜停止を
 * DevServerManager に委ね、ここでは UI 通知（ステータスバー・ログ）とブラウザ起動だけを行う。
 * サーバー出力は CP932 / UTF-8 自動判別でデコード済みの行が届く（dev-server.ts）
 */
const devServers = new DevServerManager({
  onUrl: (projectId, url) => {
    const project = projectStore.getProject(projectId);
    const name = project?.name ?? projectId;
    logger.info(`dev-server URL 検出: ${name} → ${url}`);
    void shell.openExternal(url);
    setStatus(`${name} をブラウザで開きました（${url}）`);
  },
  onUrlTimeout: (projectId) => {
    const name = projectStore.getProject(projectId)?.name ?? projectId;
    logger.warn(`dev-server URL 未検出: ${name} — サーバーは起動継続`);
    setStatus(`${name}: サーバーは起動しましたが URL を検出できませんでした（右クリック → 停止で終了できます）`);
  },
  onExit: (projectId, code) => {
    const name = projectStore.getProject(projectId)?.name ?? projectId;
    logger.info(`dev-server 終了: ${name} (code=${String(code)})`);
    setStatus(`${name} の開発サーバーが終了しました${code !== null && code !== 0 ? `（code=${code}）` : ""}`);
  },
  onLine: (projectId, line, stream) => {
    if (line.trim() === "") return;
    const name = projectStore.getProject(projectId)?.name ?? projectId;
    if (stream === "stderr") logger.warn(`dev-server[${name}] ${line}`);
    else logger.info(`dev-server[${name}] ${line}`);
  },
});

function startDevServer(id: string): void {
  const project = projectStore.getProject(id);
  if (project === null) return;
  const result = devServers.start({ id, path: project.path });
  logger.info(
    `dev-server 起動 ${result.ok ? "受理" : "失敗"}: ${project.name}${result.scriptName !== undefined ? ` (npm run ${result.scriptName})` : ""}${result.error !== undefined ? ` — ${result.error}` : ""}`
  );
  setStatus(
    result.ok
      ? `${project.name} の開発サーバーを起動中（npm run ${result.scriptName}）… URL 検出後にブラウザを開きます`
      : (result.error ?? "開発サーバーの起動に失敗しました")
  );
}

async function stopDevServer(id: string): Promise<void> {
  const project = projectStore.getProject(id);
  if (project === null) return;
  const result = await devServers.stop(id);
  logger.info(`dev-server 停止 ${result.ok ? "成功" : "失敗"}: ${project.name}${result.error !== undefined ? ` — ${result.error}` : ""}`);
  setStatus(result.ok ? `${project.name} の開発サーバーを停止しました` : (result.error ?? "停止に失敗しました"));
}

/**
 * タイルメニューの開発サーバー項目（260722_1）。
 * 未起動: 「ブラウザで開く」（スクリプト未検出のタイルは無効表示で誤操作防止）
 * 起動中: 「サーバー停止」＋（URL 検出済みなら）「ブラウザで再度開く」
 */
function devServerMenuItems(id: string, projectPath: string): Electron.MenuItemConstructorOptions[] {
  const running = devServers.get(id);
  if (running === null) {
    const script = detectDevScript(projectPath);
    return [
      {
        label:
          script !== null
            ? `ブラウザで開く（npm run ${script.name} を起動）`
            : "ブラウザで開く（開発サーバーのスクリプトなし）",
        enabled: script !== null,
        click: () => {
          startDevServer(id);
        },
      },
    ];
  }
  const items: Electron.MenuItemConstructorOptions[] = [
    {
      label: `サーバー停止（${running.url ?? "URL 検出中"}）`,
      click: () => {
        void stopDevServer(id);
      },
    },
  ];
  if (running.url !== undefined) {
    const url = running.url;
    items.push({
      label: "ブラウザで再度開く",
      click: () => {
        void shell.openExternal(url);
      },
    });
  }
  return items;
}

/**
 * 立ち上げ（260717_1）: 閉じていた Cursor / ターミナルをプロジェクトフォルダ付きで起動する手動導線。
 * 前面化（focusProject）は既存ウィンドウ限定のため、アプリを閉じた後の復帰はこちらを使う。
 * 起動後のセッション復元は従来どおり「再接続」（イベントが届けば自動でも再表示される）。
 */
function launchProject(id: string): void {
  const project = projectStore.getProject(id);
  if (project === null) return;
  const appName = project.clickTarget === "cursor" ? "Cursor" : "ターミナル";
  const outcome = launchProjectApp(project.clickTarget, project.path);
  logger.info(
    `立ち上げ ${outcome.ok ? "成功" : "失敗"}: ${project.name} → ${project.clickTarget}${outcome.message ? ` (${outcome.message})` : ""}`
  );
  setStatus(outcome.ok ? `${project.name} を ${appName} で立ち上げました` : (outcome.message ?? "立ち上げに失敗しました"));
  // 記憶したウィンドウ位置があれば、ウィンドウが現れ次第そこへ動かす（260904_1 #3）
  if (outcome.ok && project.windowBounds !== undefined) scheduleRestoreAfterLaunch(project.id);
}

/** 表示クリア（260712_2）: タイルのセッション表示のみ消す（登録・hooks は維持。次のイベントで再表示される） */
function clearProjectDisplay(id: string): void {
  const project = projectStore.getProject(id);
  if (project === null) return;
  stateStore.removeProjectSessions(id);
  logger.info(`表示クリア: ${project.name}`);
  setStatus(`${project.name} の表示をクリアしました`);
}

/** 分割タイルの「この枠を消す」（260904_1 #3）: 1 セッションの表示だけ消す（次のイベントで再表示される） */
function removeSessionDisplay(id: string, sessionId: string): void {
  const project = projectStore.getProject(id);
  if (project === null) return;
  if (!stateStore.removeSession(sessionId)) return;
  deadStrikes.delete(sessionId);
  lastNotifiedState.delete(sessionId);
  logger.info(`枠を消去: ${project.name} (session=${sessionId})`);
  setStatus(`${project.name} の枠を 1 つ消しました`);
}

/* ---------------- ウィンドウ位置の記憶／復元（260904_1 #3） ---------------- */

/** 立ち上げ後の自動復元: ウィンドウ出現の待ち時間上限・出現後の落ち着き待ち・ポーリング間隔 */
const LAUNCH_RESTORE_TIMEOUT_MS = 60_000;
const LAUNCH_RESTORE_SETTLE_MS = 1_500;
const LAUNCH_RESTORE_POLL_MS = 500;
/** projectId → 進行中の自動復元タイマー（立ち上げの連打で重複させない） */
const pendingRestores = new Map<string, NodeJS.Timeout>();

function cancelPendingRestore(id: string): void {
  const t = pendingRestores.get(id);
  if (t !== undefined) {
    clearInterval(t);
    pendingRestores.delete(id);
  }
}

function cancelAllPendingRestores(): void {
  for (const id of [...pendingRestores.keys()]) cancelPendingRestore(id);
}

/** 「ウィンドウ位置を記憶」: 今のウィンドウ配置を projects.json に保存する */
function saveWindowBounds(id: string, quiet = false): boolean {
  const project = projectStore.getProject(id);
  if (project === null) return false;
  const r = readProjectWindowPlacement(project.clickTarget, path.basename(project.path));
  if (!r.ok) {
    logger.info(`ウィンドウ位置の記憶 失敗: ${project.name} — ${r.message}`);
    if (!quiet) setStatus(`${project.name}: ${r.message}`);
    return false;
  }
  const bounds: WindowBounds = {
    x: r.placement.x,
    y: r.placement.y,
    width: r.placement.width,
    height: r.placement.height,
    maximized: r.placement.maximized,
    savedAt: new Date().toISOString(),
  };
  if (!projectStore.setWindowBounds(id, bounds)) {
    if (!quiet) setStatus(`${project.name}: ウィンドウ位置を保存できませんでした`);
    return false;
  }
  logger.info(`ウィンドウ位置を記憶: ${project.name} → ${fmtWindowBounds(bounds)}`);
  if (!quiet) setStatus(`${project.name} のウィンドウ位置を記憶しました ${fmtWindowBounds(bounds)}`);
  else broadcast();
  return true;
}

/** 「記憶した位置へ戻す」: 保存済みの配置を今のウィンドウに適用する */
function restoreWindowBounds(id: string, quiet = false): boolean {
  const project = projectStore.getProject(id);
  if (project === null || project.windowBounds === undefined) return false;
  const r = applyProjectWindowPlacement(project.clickTarget, path.basename(project.path), project.windowBounds);
  logger.info(`ウィンドウ位置を復元 ${r.ok ? "成功" : "失敗"}: ${project.name} → ${fmtWindowBounds(project.windowBounds)}${r.message ? ` (${r.message})` : ""}`);
  if (!quiet) setStatus(r.ok ? `${project.name} のウィンドウを記憶した位置へ戻しました` : `${project.name}: ${r.message ?? "復元に失敗しました"}`);
  return r.ok;
}

function forgetWindowBounds(id: string): void {
  const project = projectStore.getProject(id);
  if (project === null) return;
  cancelPendingRestore(id);
  projectStore.setWindowBounds(id, null);
  logger.info(`ウィンドウ位置の記憶を消去: ${project.name}`);
  setStatus(`${project.name} のウィンドウ位置の記憶を消しました`);
}

/** 設定画面「全プロジェクトのウィンドウ位置を記憶」: ウィンドウが見つかったものだけ保存する */
function saveAllWindowBounds(): OpResult {
  let saved = 0;
  const missing: string[] = [];
  for (const p of projectStore.projects) {
    if (saveWindowBounds(p.id, true)) saved += 1;
    else missing.push(p.name);
  }
  const msg = `ウィンドウ位置を記憶: ${saved} 件${missing.length > 0 ? `（ウィンドウなし ${missing.length} 件: ${missing.join(", ")}）` : ""}`;
  logger.info(msg);
  setStatus(msg);
  return { ok: saved > 0, error: saved > 0 ? undefined : "記憶できるウィンドウがありませんでした" };
}

/** 設定画面「全プロジェクトを記憶した位置へ戻す」: 記憶があり、今ウィンドウがあるものだけ適用する */
function restoreAllWindowBounds(): OpResult {
  let restored = 0;
  let remembered = 0;
  const failed: string[] = [];
  for (const p of projectStore.projects) {
    if (p.windowBounds === undefined) continue;
    remembered += 1;
    if (restoreWindowBounds(p.id, true)) restored += 1;
    else failed.push(p.name);
  }
  const msg =
    remembered === 0
      ? "位置を記憶したプロジェクトがありません（タイル右クリック →「ウィンドウ位置を記憶」）"
      : `ウィンドウ位置を復元: ${restored} / ${remembered} 件${failed.length > 0 ? `（未復元: ${failed.join(", ")}）` : ""}`;
  logger.info(msg);
  setStatus(msg);
  return { ok: restored > 0, error: restored > 0 ? undefined : msg };
}

/**
 * 「立ち上げる」直後の自動復元: 対象アプリのウィンドウが現れるまで 0.5 秒ごとに探し、
 * 現れてから 1.5 秒待って（Cursor 自身の前回位置の復元処理が終わるのを待つ）記憶位置を適用する。
 * 念のため 1.5 秒後にもう一度適用する（Cursor 側が上書きした場合の再適用）。
 */
function scheduleRestoreAfterLaunch(id: string): void {
  cancelPendingRestore(id);
  const startedAt = Date.now();
  let seenAt: number | null = null;
  let applied = 0;
  const timer = setInterval(() => {
    const project = projectStore.getProject(id);
    if (project === null || project.windowBounds === undefined) {
      cancelPendingRestore(id);
      return;
    }
    const folder = path.basename(project.path);
    const now = Date.now();
    if (seenAt === null) {
      if (readProjectWindowPlacement(project.clickTarget, folder).ok) {
        seenAt = now;
      } else if (now - startedAt > LAUNCH_RESTORE_TIMEOUT_MS) {
        cancelPendingRestore(id);
        logger.info(`ウィンドウ位置の自動復元を打ち切り（ウィンドウが現れず）: ${project.name}`);
      }
      return;
    }
    if (now - seenAt < LAUNCH_RESTORE_SETTLE_MS * (applied + 1)) return;
    const r = applyProjectWindowPlacement(project.clickTarget, folder, project.windowBounds);
    applied += 1;
    logger.info(`ウィンドウ位置の自動復元（${applied} 回目）${r.ok ? "成功" : "失敗"}: ${project.name} → ${fmtWindowBounds(project.windowBounds)}${r.message ? ` (${r.message})` : ""}`);
    if (!r.ok || applied >= 2) {
      cancelPendingRestore(id);
      if (r.ok) setStatus(`${project.name} のウィンドウを記憶した位置へ戻しました`);
    }
  }, LAUNCH_RESTORE_POLL_MS);
  pendingRestores.set(id, timer);
}

/** 手動ステータスの割り当て（260727_1）: 右クリックメニューの確定処理。null = 解除 */
function setProjectStatus(id: string, status: string | null): void {
  const project = projectStore.getProject(id);
  if (project === null) return;
  if (!projectStore.setCustomStatus(id, status)) return;
  logger.info(`ステータス変更: ${project.name} → ${status ?? "（なし）"}`);
  setStatus(status === null ? `${project.name} のステータスを外しました` : `${project.name}: ${status}`);
  broadcast();
}

/**
 * 表示名の変更（260903_2）: 右クリックメニューからは renderer の入力ダイアログを開かせる
 * （Electron に prompt 相当のネイティブダイアログが無いため、入力 UI は renderer 側に置く）
 */
function requestRename(id: string): void {
  if (win === null || win.isDestroyed()) return;
  win.webContents.send("rename-request", id);
}

/** 登録解除は hooks 除去を伴う破壊的操作のため、メニューからは確認を挟む（260712_2） */
async function confirmAndUnregister(id: string): Promise<void> {
  const project = projectStore.getProject(id);
  if (project === null || win === null) return;
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    title: "登録解除",
    message: `${project.name} を登録解除しますか？`,
    detail: `タイルを削除し、${project.path} の .claude/settings.json から本アプリの hooks を除去します。`,
    buttons: ["登録解除", "キャンセル"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) {
    const result = await unregisterProjectById(id);
    if (!result.ok && result.error !== undefined) setStatus(result.error);
  }
}

/** アプリ再起動はセッション表示を失うため、既存の破壊的操作と同じく main 側で確認する。 */
async function confirmAndRestart(): Promise<void> {
  if (win === null) return;
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    title: "再起動",
    message: "terminal-app を再起動しますか？",
    detail: "セッション表示（メモリ上の状態）は一旦消えます。必要ならタイル右クリック →「再接続」で復元できます。",
    buttons: ["再起動", "キャンセル"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) await appRestarter.restart();
}

function wireIpc(): void {
  ipcMain.handle("get-snapshot", () => buildSnapshot());

  ipcMain.handle("register-projects", (_e, paths: string[]): RegisterResult[] => {
    // フォルダはそのまま登録し、ファイルのドロップのみ .claude / .git を目印にルートへ読み替える
    // （260729 改定: フォルダの祖先探索は「開発案件/」等の親フォルダ誤登録を招くため廃止）。
    // 解決不能（パス不存在）は元パスのまま registerProject の検証エラーに落とす
    const results = paths.map((p) => registerProject(resolveProjectRoot(p) ?? p));
    broadcast();
    return results;
  });

  // D&D 診断ログ（260727_1）: renderer のコンソールは非表示運用のため main のログファイルへ集約する
  ipcMain.on("dnd-log", (_e, msg: string) => {
    if (typeof msg === "string") logger.info(`D&D(renderer): ${msg.slice(0, 500)}`);
  });

  // D&D 登録の本経路（260727_1）: DataTransfer の生ペイロードを受け、パス抽出→ルート解決→登録。
  // Cursor（VS Code 系）からのドラッグは files が空のため drop-paths のフォールバック抽出が本命
  ipcMain.handle("register-drop", (_e, payload: DropPayload): RegisterResult[] => {
    const types = payload.types ?? [];
    const summary = types.map((t) => `${t}:${(payload.data?.[t] ?? "").length}ch`).join(", ");
    logger.info(`D&D 受信: files=${(payload.filePaths ?? []).length} types=[${summary}]`);
    for (const [k, v] of Object.entries(payload.data ?? {})) {
      if (v !== "") logger.info(`D&D data[${k}]: ${v.slice(0, 300)}`);
    }
    const extracted = extractDropPaths(payload);
    logger.info(`D&D 抽出: source=${extracted.source} paths=[${extracted.paths.join(" | ")}]`);
    if (extracted.paths.length === 0) {
      // Cursor（VS Code 系）のツリードラッグは OS ドラッグにパス情報が載らない（OLE プローブで実証済み）
      return [{ ok: false, path: "", error: "ドロップにパス情報がありません（Cursor のツリーからは登録不可）。エクスプローラからドロップするか、＋ボタンで選択してください" }];
    }
    const results = extracted.paths.map((p) => registerProject(resolveProjectRoot(p) ?? p));
    broadcast();
    return results;
  });

  // フォルダ選択ダイアログによる登録（260727_1）: Cursor D&D 不能の確実な代替導線
  ipcMain.handle("pick-projects", async (): Promise<RegisterResult[]> => {
    if (win === null) return [];
    const picked = await dialog.showOpenDialog(win, {
      title: "登録するプロジェクトフォルダを選択",
      properties: ["openDirectory", "multiSelections"],
    });
    if (picked.canceled || picked.filePaths.length === 0) return [];
    logger.info(`フォルダ選択登録: ${picked.filePaths.join(" | ")}`);
    const results = picked.filePaths.map((p) => registerProject(resolveProjectRoot(p) ?? p));
    broadcast();
    return results;
  });

  ipcMain.handle("unregister-project", (_e, id: string) => unregisterProjectById(id));

  // タイル右クリックメニュー（260712_2）。ネイティブ Menu を popup し、確定処理は main 側で完結する。
  // sessionId は分割タイル（260904_1 #3）からのときだけ届く → 「この枠を消す」を出す
  ipcMain.handle("show-tile-menu", (_e, id: string, sessionId?: string) => {
    const project = projectStore.getProject(id);
    if (project === null || win === null) return;
    const splitItems: MenuItemConstructorOptions[] =
      typeof sessionId === "string" && sessionId !== ""
        ? [{ label: "この枠を消す（このセッションの表示だけ消す）", click: () => { removeSessionDisplay(id, sessionId); } }]
        : [];
    // ウィンドウ位置の記憶／復元（260904_1 #3）
    const remembered = project.windowBounds;
    const boundsItems: MenuItemConstructorOptions[] = [
      { label: "今のウィンドウ位置を記憶", click: () => { saveWindowBounds(id); } },
      {
        label: remembered !== undefined ? `記憶した位置へ戻す ${fmtWindowBounds(remembered)}` : "記憶した位置へ戻す（未記憶）",
        enabled: remembered !== undefined,
        click: () => { restoreWindowBounds(id); },
      },
      { label: "記憶を消す", enabled: remembered !== undefined, click: () => { forgetWindowBounds(id); } },
    ];
    const launchLabel =
      project.clickTarget === "cursor"
        ? "立ち上げる（Cursor でこのフォルダを開く）"
        : "立ち上げる（ターミナルをこのフォルダで開く）";
    // ステータスサブメニュー（260727_1）: config.customStatuses の選択肢＋「（なし）」で解除。
    // 選択肢の追加・削除は設定画面から行う
    const statuses = projectStore.config.customStatuses;
    const statusItems: MenuItemConstructorOptions[] = [
      ...statuses.map((s): MenuItemConstructorOptions => ({
        label: s,
        type: "radio",
        checked: project.customStatus === s,
        click: () => { setProjectStatus(id, s); },
      })),
      ...(statuses.length === 0
        ? [{ label: "（設定画面でステータスを追加できます）", enabled: false } satisfies MenuItemConstructorOptions]
        : []),
      {
        label: "（なし）",
        type: "radio",
        checked: project.customStatus === undefined,
        click: () => { setProjectStatus(id, null); },
      },
    ];
    const menu = Menu.buildFromTemplate([
      { label: launchLabel, click: () => { launchProject(id); } },
      ...devServerMenuItems(id, project.path),
      { label: "再接続（動作中のセッションを拾い直す）", click: () => { reconnectProject(id); } },
      { label: "表示クリア（登録は維持）", click: () => { clearProjectDisplay(id); } },
      ...splitItems,
      { type: "separator" },
      { label: "ステータス", submenu: statusItems },
      { label: "表示名を変更…", click: () => { requestRename(id); } },
      { label: "ウィンドウ位置", submenu: boundsItems },
      { type: "separator" },
      { label: "登録解除（hooks も除去）…", click: () => { void confirmAndUnregister(id); } },
    ]);
    menu.popup({ window: win });
  });

  ipcMain.handle("set-click-target", (_e, id: string, target: ClickTarget) => {
    projectStore.setClickTarget(id, target);
    broadcast();
  });

  // 手動ステータス（260727_1）。割り当ては右クリックメニュー経由が主だが、API としても公開する
  ipcMain.handle("set-project-status", (_e, id: string, status: string | null) => {
    setProjectStatus(id, status);
  });

  ipcMain.handle("set-custom-statuses", (_e, list: string[]) => {
    projectStore.setCustomStatuses(list);
    broadcast();
  });

  // 表示名の変更（260903_2）: renderer の入力ダイアログから確定値を受ける。空はフォルダ名へ戻る
  ipcMain.handle("set-project-name", (_e, id: string, name: string): OpResult => {
    const project = projectStore.getProject(id);
    if (project === null) return { ok: false, error: "プロジェクトが見つかりません" };
    if (typeof name !== "string") return { ok: false, error: "表示名が不正です" };
    const before = project.name;
    const result = projectStore.renameProject(id, name);
    if (!result.ok) return { ok: false, error: result.error };
    if (result.name !== before) {
      logger.info(`表示名変更: ${before} → ${result.name}`);
      setStatus(`表示名を変更しました: ${before} → ${result.name}`);
    } else {
      broadcast();
    }
    return { ok: true };
  });

  // ウィンドウ位置の一括記憶／復元（260904_1 #3）: 設定画面のボタン
  ipcMain.handle("save-all-window-bounds", (): OpResult => saveAllWindowBounds());
  ipcMain.handle("restore-all-window-bounds", (): OpResult => restoreAllWindowBounds());

  // タイルの並び順（260906_1）: D&D 並べ替え・自動整列のどちらも renderer が確定した id 順を渡す。
  // 並び順 = projects.json の配列順そのもの（新しいキーは持たない）。順序が変わらなければ配信もしない
  ipcMain.handle("reorder-projects", (_e, ids: unknown): OpResult => {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      return { ok: false, error: "並び順の指定が不正です" };
    }
    if (projectStore.reorderProjects(ids as string[])) {
      logger.info(`並び順変更: ${projectStore.projects.map((p) => p.name).join(" → ")}`);
      broadcast();
    }
    return { ok: true };
  });

  // 未接続タイルの表示／非表示（260903_1）: ステータスバーのトグル。config.json に保持
  ipcMain.handle("set-show-unlinked", (_e, value: boolean) => {
    projectStore.setShowUnlinked(value === true);
    broadcast();
  });

  ipcMain.handle("set-theme", (_e, theme: ThemeSetting) => {
    projectStore.setTheme(theme);
    broadcast();
  });

  ipcMain.handle("set-aot-default", (_e, value: boolean) => {
    projectStore.setAlwaysOnTopDefault(value);
    broadcast();
  });

  ipcMain.handle("set-pinned", (_e, value: boolean) => {
    pinned = value;
    win?.setAlwaysOnTop(value);
    broadcast();
  });

  ipcMain.handle("focus-project", (_e, id: string) => {
    const project = projectStore.getProject(id);
    if (project === null) return { ok: false, message: "プロジェクトが見つかりません" };
    // クリック時点では本アプリがフォアグラウンド → SetForegroundWindow の権限内（design.md 7.2）
    const outcome = focusProjectWindow(project.clickTarget, path.basename(project.path));
    logger.info(`前面化 ${outcome.ok ? "成功" : "失敗"}: ${project.name} → ${project.clickTarget}${outcome.message ? ` (${outcome.message})` : ""}`);
    setStatus(outcome.ok ? "" : (outcome.message ?? "前面化に失敗しました"));
    return outcome;
  });

  ipcMain.on("window-action", (_e, action: WindowAction) => {
    if (win === null) return;
    if (action === "minimize") win.minimize();
    else if (action === "maximize") {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === "close") win.close(); // 閉じる = アプリ終了（design.md 6.1）
    else if (action === "restart") void confirmAndRestart();
  });

  ipcMain.on("notify-rendered", (_e, rev: number) => {
    const receivedAt = pendingRender.get(rev);
    if (receivedAt !== undefined) {
      pendingRender.delete(rev);
      logger.info(`ui-latency: 受信→描画完了 ${Date.now() - receivedAt}ms (revision=${rev})`); // V-04 のログ差分計測
    }
    // 追い越された古い計測は破棄
    for (const key of pendingRender.keys()) {
      if (key < rev) pendingRender.delete(key);
    }
  });
}

function scheduleCaptureIfNeeded(): void {
  if (capturePath === undefined || win === null) return;
  const target = capturePath;
  setTimeout(() => {
    void (async () => {
      try {
        if (win === null) return;
        // V-11 補助証跡: setAlwaysOnTop の ON/OFF が API に反映されることをログで確認
        const before = win.isAlwaysOnTop();
        win.setAlwaysOnTop(true);
        logger.info(`pin-check: setAlwaysOnTop(true) → isAlwaysOnTop=${win.isAlwaysOnTop()}`);
        win.setAlwaysOnTop(false);
        logger.info(`pin-check: setAlwaysOnTop(false) → isAlwaysOnTop=${win.isAlwaysOnTop()}`);
        win.setAlwaysOnTop(before);
        const image = await win.webContents.capturePage();
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, image.toPNG());
        logger.info(`capture saved: ${target}`);
      } catch (e) {
        logger.error(`capture 失敗: ${String(e)}`);
      } finally {
        app.quit();
      }
    })();
  }, captureDelay);
}

function createWindow(): void {
  pinned = projectStore.config.alwaysOnTopDefault; // 起動時の既定値（design.md 8 章 / 面 1d）
  win = new BrowserWindow({
    width: 680,
    height: 520,
    minWidth: 420,
    minHeight: 320,
    frame: false, // タイトルバーはモック準拠の自前実装（面 1a〜1f）
    show: false,
    backgroundColor: "#101216",
    alwaysOnTop: pinned,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  const initialView = argValue("view") === "settings" ? "settings" : "main";
  void win.loadFile(path.join(__dirname, "../renderer/index.html"), { query: { view: initialView } });
  win.once("ready-to-show", () => {
    win?.show();
    logger.info(`window shown (demo=${demoMode}, capture=${capturePath ?? "-"})`);
    scheduleCaptureIfNeeded();
  });
  win.on("closed", () => {
    win = null;
  });
}

void app.whenReady().then(async () => {
  if (secondInstance) return; // 多重起動側: quit 完了を待つだけ（サーバ listen もウィンドウ生成もしない）
  // Windows のトースト通知（切断お知らせ。260712_2）は AppUserModelID が無いと表示されないことがある
  app.setAppUserModelId("terminal-app");
  logger.info(`terminal-app 起動 (dataDir=${dataDir}, demo=${demoMode})`);
  projectStore.load();

  if (demoMode) {
    windowPresence = seedDemo(projectStore, stateStore, demoCount); // 260903_1: 未接続タイルもシードで固定
    logger.info(`demo シード投入: ${demoCount} タイル`);
  } else {
    // 起動時追補（セルフヒール）: 登録済み全プロジェクトの hooks を冪等マージし、
    // マーカー付きエントリが不足しているイベントのみ append する（design.md 4.2 / 3.3）。
    // 旧 2 イベント（Stop / Notification）構成で登録済みのプロジェクトにも、
    // 再登録なしで UserPromptSubmit（OPEN-04 案 A）が行き渡る。ポート変更後の再追記も同経路。
    for (const p of projectStore.projects) {
      const r = mergeHooks(p.path, projectStore.config.port, ALL_HOOK_EVENTS);
      if (!r.ok) logger.warn(`hooks 追補失敗: ${p.path} — ${r.error}`);
      else if (r.changed) logger.info(`hooks を追補（不足イベントの追記/再追記）: ${p.path}`);
      // statusLine 転送（260712_3 案A）も同経路で追補（既存プロジェクトへ再登録なしで行き渡る）
      const sl = mergeStatusLine(p.path, projectStore.config.port);
      if (!sl.ok) logger.warn(`statusLine 追補失敗: ${p.path} — ${sl.error}`);
      else if (sl.skipped === true) logger.info(`statusLine は既存のユーザー設定を尊重（設定せず）: ${p.path}`);
      else if (sl.changed) logger.info(`statusLine 転送を追補: ${p.path}`);
    }
  }

  // design.md 10 章「UI は起動継続」: 先にウィンドウを表示し、listen 失敗時は
  // ステータス表示＋エラーダイアログで設定変更を案内する（ダイアログはモーダルで
  // メインプロセスを止めるため、ウィンドウ表示前に出すと起動自体が固まる）
  wireIpc();
  createWindow();

  const server = createAppEventServer();
  eventServer = server;
  try {
    await server.listen();
  } catch (e) {
    // 表示するポートは「実際に bind を試みたポート」を正とする（260712 課題C:
    // 旧実装は設定値 projectStore.config.port を表示しており、実試行ポートと食い違う
    // ダイアログ（表示 41999 / 実 bind 41321）を出していた）
    const attemptedPort = resolveAttemptedPort(e, server.targetPort);
    const text = buildListenErrorText(e, attemptedPort);
    logger.error(`受信サーバの起動に失敗 (port=${attemptedPort}): ${String(e)}`);
    setStatus(text.status);
    // 自動キャプチャ実行（検証・証跡採取）ではモーダルを出さない（無人実行がハングするため）
    if (capturePath === undefined) {
      dialog.showErrorBox(text.title, text.body);
    }
  }

  // 切断検知の定期掃引（260712_2）。デモ実行はシードに transcript が無く対象外
  if (!demoMode) {
    livenessTimer = setInterval(sweepLiveness, DISCONNECT_CHECK_INTERVAL_MS);
    // 未接続タイル（260903_1）: 起動直後に 1 回判定し、以後は約 5 秒ごとに更新（変化時のみ配信）
    pollWindowPresence();
    windowPollTimer = setInterval(pollWindowPresence, WINDOW_POLL_INTERVAL_MS);
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("will-quit", () => {
  if (livenessTimer !== null) clearInterval(livenessTimer);
  if (windowPollTimer !== null) clearInterval(windowPollTimer);
  cancelAllPendingRestores();
  cancelAllPendingStopChecks();
  void devServers.stopAll(); // 開発サーバーを残さない（260722_1）
  void eventServer?.close();
  logger.info("terminal-app 終了");
});
