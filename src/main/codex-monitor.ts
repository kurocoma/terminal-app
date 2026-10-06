import * as os from "node:os";
import * as path from "node:path";
import type { Project, SessionView, Snapshot } from "../shared/types";
import { readCodexSessions, type CodexReadResult, type CodexSessionRecord } from "./codex-session-reader";
import { matchProjectByCwd } from "./state-store";
import { readCodexLiveness } from "./codex-liveness";
import { orcaCodexHome } from "./orca";
import type { Liveness } from "./session-registry";

export function codexHome(): string {
  return process.env.TERMINAL_APP_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/**
 * 読み取る Codex の保存先一覧（261005_1）。通常の CODEX_HOME に加え、Orca が Codex に渡す専用の
 * CODEX_HOME（%APPDATA%\orca\codex-runtime-home\home）も読む。Orca 側の会話は jsonl こそ ~/.codex と
 * 共有されるが、状態 DB（state_5.sqlite）は別ファイルで、~/.codex 側に載らないスレッドがあるため。
 * 検証用の TERMINAL_APP_CODEX_HOME 指定時はそれだけを読む
 */
export function codexHomes(): string[] {
  if (process.env.TERMINAL_APP_CODEX_HOME) return [process.env.TERMINAL_APP_CODEX_HOME];
  // 本アプリを Orca のターミナルから起動すると CODEX_HOME が Orca 用を指すため、~/.codex も常に読む
  const homes: string[] = [];
  for (const home of [codexHome(), path.join(os.homedir(), ".codex"), orcaCodexHome()]) {
    if (home === null) continue;
    if (!homes.some((h) => path.resolve(h).toLowerCase() === path.resolve(home).toLowerCase())) homes.push(home);
  }
  return homes;
}

/**
 * 複数の保存先をまとめて読む。同じスレッドが複数の DB にあれば最終更新の新しい方を採る。
 * 生存判定は「そのスレッドが見つかった保存先」のロックだけで行う（Codex は実行中の home にだけロックを置く）
 */
export class CodexHomesSource {
  private foundIn = new Map<string, string[]>();
  /** 保存先ごとの直近の成功結果。一時的な読み取り失敗（DB ロック等）の間はこれで代用する */
  private lastGood = new Map<string, { result: CodexReadResult; at: number }>();

  constructor(
    private readonly homes: () => string[] = codexHomes,
    private readonly readHome: (home: string) => CodexReadResult = (home) => readCodexSessions({ codexHome: home }),
    private readonly livenessIn: (home: string, sessionId: string) => Liveness = readCodexLiveness,
    private readonly now: () => number = Date.now,
  ) {}

  read(): CodexReadResult {
    const merged = new Map<string, CodexSessionRecord>();
    const foundIn = new Map<string, string[]>();
    let available = false;
    let error: string | undefined;
    for (const home of this.homes()) {
      let result = this.readHome(home);
      if (result.available) {
        this.lastGood.set(home, { result, at: this.now() });
      } else {
        error ??= result.error;
        // 片方だけ読めない間に、その保存先の会話を消したり別の保存先の lock だけで終了と判定したりしない。
        // 単一保存先のときと同じ 30 秒の猶予の間は直近の成功結果を使う（それを過ぎたら外す）
        const cached = this.lastGood.get(home);
        if (cached === undefined || this.now() - cached.at >= HOME_READ_GRACE_MS) continue;
        result = cached.result;
      }
      available = true;
      for (const record of result.sessions) {
        foundIn.set(record.sessionId, [...(foundIn.get(record.sessionId) ?? []), home]);
        const prev = merged.get(record.sessionId);
        if (prev === undefined || record.lastEventAt > prev.lastEventAt) merged.set(record.sessionId, record);
      }
    }
    this.foundIn = foundIn;
    if (!available) return error === undefined ? { available: false, sessions: [] } : { available: false, sessions: [], error };
    return { available: true, sessions: [...merged.values()] };
  }

  /** alive が 1 つでもあれば alive、判定不能が混じれば unknown、全部 dead のときだけ dead */
  liveness(sessionId: string): Liveness {
    const homes = this.foundIn.get(sessionId) ?? this.homes().slice(0, 1);
    const results = homes.map((home) => this.livenessIn(home, sessionId));
    if (results.includes("alive")) return "alive";
    if (results.includes("unknown") || results.length === 0) return "unknown";
    return "dead";
  }
}

/** 保存先ごとの読み取り失敗を一時的とみなす猶予（CodexMonitor の全体失敗の猶予と同じ 30 秒） */
const HOME_READ_GRACE_MS = 30_000;

const defaultSource = new CodexHomesSource();

/** Codex のスレッド（"codex:" 接頭辞なし）が今も開いているか（writer lock。Orca への送信可否の確認に使う） */
export function codexSessionLiveness(threadId: string): Liveness {
  return defaultSource.liveness(threadId);
}

/** 別 dataDir の検証では、明示的な Codex fixture がない限り実履歴を読まない。 */
export function codexMonitoringEnabled(enabled: boolean | undefined): boolean {
  return enabled !== false && (!process.env.TERMINAL_APP_DATA_DIR || !!process.env.TERMINAL_APP_CODEX_HOME);
}

type Reader = () => CodexReadResult;

/** Codex は Windows の拡張パス（\\\\?\\C:\\...）を保存する。登録パスとの比較前に通常形へ戻す。 */
export function normalizeCodexCwd(cwd: string): string {
  const win = cwd.replace(/\//g, "\\");
  if (win.toLowerCase().startsWith("\\\\?\\unc\\")) return "\\\\" + win.slice(8);
  return win.startsWith("\\\\?\\") ? win.slice(4) : win;
}

/** Claude の登録簿・Jev 判定に Codex の会話を流さず、表示時にだけ合流させる。 */
export class CodexMonitor {
  private views: SessionView[] = [];
  private hidden = new Map<string, { at: number; projectId: string }>();
  private lastSuccessAt = 0;
  private deadStrikes = new Map<string, number>();
  private closedIds = new Set<string>();
  private openIds = new Set<string>();
  available = false;

  constructor(
    private readonly read: Reader = () => defaultSource.read(),
    private readonly now: () => number = Date.now,
    private readonly liveness: (sessionId: string) => Liveness = (id) => defaultSource.liveness(id),
  ) {}

  get sessions(): readonly SessionView[] { return this.views; }

  refresh(projects: readonly Project[]): boolean {
    const result = this.read();
    this.available = result.available;
    if (!result.available) {
      // 一時的な DB ロックは次回再試行。取得不能が続くときは実行中と断言しない。
      if (this.now() - this.lastSuccessAt < 30_000) return false;
      const next = this.views.filter((s) => projects.some((p) => p.id === s.projectId)).map((s): SessionView =>
        s.state === "running" || s.state === "confirm"
          ? { ...s, state: "disconnected", runningSince: undefined, confirmKind: undefined }
          : s,
      );
      return this.replace(next);
    }
    this.lastSuccessAt = this.now();
    const liveIds = new Set<string>();
    const grouped = new Map<string, SessionView[]>();
    for (const record of result.sessions) {
      const project = matchProjectByCwd(normalizeCodexCwd(record.cwd), projects);
      if (project === null) continue;
      const sessionId = `codex:${record.sessionId}`;
      liveIds.add(sessionId);
      const life = this.liveness(record.sessionId);
      if (life === "dead") this.deadStrikes.set(sessionId, Math.min(2, (this.deadStrikes.get(sessionId) ?? 0) + 1));
      else this.deadStrikes.delete(sessionId);
      if (life === "alive") this.closedIds.delete(sessionId);
      else if ((this.deadStrikes.get(sessionId) ?? 0) >= 2) this.closedIds.add(sessionId);
      const closed = this.closedIds.has(sessionId);
      if (life === "alive") this.openIds.add(sessionId);
      else if (closed) this.openIds.delete(sessionId);
      const hiddenAt = this.hidden.get(sessionId);
      if (hiddenAt !== undefined && record.lastEventAt > hiddenAt.at) this.hidden.delete(sessionId);
      const view: SessionView = {
        sessionId, projectId: project.id, provider: "codex", state: record.state,
        lastEventAt: record.lastEventAt, firstSeenAt: record.firstSeenAt,
        runningSince: record.runningSince, taskTitle: record.taskTitle,
        workText: record.workText, confirmKind: record.confirmKind,
      };
      if (closed) {
        view.terminalClosed = true;
        if (view.state === "running" || view.state === "confirm") {
          view.state = "disconnected";
          delete view.runningSince;
          delete view.confirmKind;
        }
      }
      const list = grouped.get(project.id) ?? [];
      list.push(view);
      grouped.set(project.id, list);
    }
    for (const id of this.hidden.keys()) if (!liveIds.has(id)) this.hidden.delete(id);
    for (const id of this.deadStrikes.keys()) if (!liveIds.has(id)) this.deadStrikes.delete(id);
    for (const id of this.closedIds) if (!liveIds.has(id)) this.closedIds.delete(id);
    for (const id of this.openIds) if (!liveIds.has(id)) this.openIds.delete(id);
    const next: SessionView[] = [];
    for (const list of grouped.values()) {
      // 生存確認済みなら、応答完了後の入力待ちも開いているターミナルとして数える。
      // 判定不能の旧版だけ従来の履歴選定を使う。閉じた履歴は分割数に加えない。
      const active = list.filter((s) => !s.terminalClosed &&
        (this.openIds.has(s.sessionId) || s.state === "running" || s.state === "confirm"));
      const latestFinished = list.filter((s) => !s.terminalClosed && !active.includes(s))
        .sort((a, b) => b.lastEventAt - a.lastEventAt || a.sessionId.localeCompare(b.sessionId))[0];
      next.push(...active);
      if (latestFinished !== undefined) next.push(latestFinished);
      if (active.length === 0 && latestFinished === undefined) {
        const latestClosed = [...list].sort((a, b) => b.lastEventAt - a.lastEventAt || a.sessionId.localeCompare(b.sessionId))[0];
        if (latestClosed !== undefined) next.push(latestClosed);
      }
    }
    // 表示候補を先に選ぶ。隠した最新完了を古い完了で埋め直すと「表示クリア」が効かなくなる。
    const visible = next.filter((s) => !this.hidden.has(s.sessionId));
    visible.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    return this.replace(visible);
  }

  hide(sessionId: string): boolean {
    const session = this.views.find((s) => s.sessionId === sessionId);
    if (session === undefined) return false;
    this.hidden.set(sessionId, { at: session.lastEventAt, projectId: session.projectId });
    return this.replace(this.views.filter((s) => s.sessionId !== sessionId));
  }

  reconnect(projectId: string): void {
    // 再接続は明示的な再表示要求。隠した履歴も次の取得で再評価する。
    for (const [id, entry] of this.hidden) if (entry.projectId === projectId) this.hidden.delete(id);
  }

  private replace(next: SessionView[]): boolean {
    if (JSON.stringify(this.views) === JSON.stringify(next)) return false;
    this.views = next;
    return true;
  }
}

/** 既存の表示規則を保ち、同じプロジェクトの Claude / Codex を分割タイルで並べる。 */
export function mergeCodexViews(
  projects: readonly Project[],
  claude: Pick<Snapshot, "sessions" | "splitSessions">,
  codex: readonly SessionView[],
): Pick<Snapshot, "sessions" | "splitSessions"> {
  const sessions = { ...claude.sessions };
  const splitSessions = { ...claude.splitSessions };
  for (const project of projects) {
    const additions = codex.filter((s) => s.projectId === project.id);
    if (additions.length === 0) continue;
    const primary = sessions[project.id];
    const existing = splitSessions[project.id] ?? (primary === undefined ? [] : [primary]);
    const candidates = [...existing, ...additions];
    const open = candidates.filter((s) => !s.terminalClosed);
    // 全部閉じた場合だけ最後の状態を 1 枚残す。別 provider の終了履歴を分割へ戻さない。
    const list = (open.length > 0 ? open : [...candidates].sort((a, b) => b.lastEventAt - a.lastEventAt).slice(0, 1)).sort((a, b) =>
      (a.firstSeenAt ?? a.lastEventAt) - (b.firstSeenAt ?? b.lastEventAt) || a.sessionId.localeCompare(b.sessionId),
    );
    sessions[project.id] = [...list].sort((a, b) =>
      Number(b.state === "running") - Number(a.state === "running") || b.lastEventAt - a.lastEventAt,
    )[0];
    if (list.length > 1) splitSessions[project.id] = list;
    else delete splitSessions[project.id];
  }
  return { sessions, splitSessions };
}
