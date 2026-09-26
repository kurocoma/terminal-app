/**
 * 自己診断（260927_1）: 「直近の動作が問題なく行われているか」を実データから判定する純関数。
 *
 * 見るのは 3 つ:
 * 1. app.log の直近 — イベントが届いているか、判定が走っているか、警告・失敗が出ていないか
 * 2. 状態の往復（flip-flop） — 同じセッションで「復帰 → 終了検知」が短時間に繰り返されていないか。
 *    実測（2026-09-27）で 109 回の往復が見つかった。表示がちらつくうえ判定が毎回走る
 * 3. 保存した表示（sessions.json）と実データの食い違い — 「返答待ちなのにターンが動いている」
 *    「実行中なのに登録簿にプロセスが居ない」「完了なのに subagent が動いている」
 *
 * I/O は scripts/diagnose.mjs 側。ここは文字列と値だけを扱う（単体テスト対象）。
 */
import type { SessionState } from "../shared/types";

/** 既定の集計窓（直近これだけを「直近の動作」とみなす） */
export const DIAGNOSE_WINDOW_MS = 6 * 60 * 60_000;
/** 往復とみなす間隔（これ以内に逆向きの遷移が起きたら 1 往復） */
export const FLIP_FLOP_WINDOW_MS = 60_000;

export interface LogEntry {
  at: number;
  level: "INFO" | "WARN" | "ERROR";
  /** 「event 受信」「Jev 返答待ち判定」などの見出し部分 */
  kind: string;
  /** 見出し以降の本文 */
  rest: string;
  /** 本文から取れたセッション ID（8 文字に切り詰め） */
  session?: string;
}

const LINE = /^(\S+) \[(INFO|WARN|ERROR)\] ([^:]{1,40}):\s?([\s\S]*)$/;

/** ログ 1 行 → 構造化。形が違う行は null */
export function parseLogLine(line: string): LogEntry | null {
  const m = LINE.exec(line.trimEnd());
  if (m === null) return null;
  const at = Date.parse(m[1]);
  if (!Number.isFinite(at)) return null;
  const rest = m[4];
  const sid = /session=([0-9a-f]{8})/.exec(rest);
  const entry: LogEntry = { at, level: m[2] as LogEntry["level"], kind: m[3], rest };
  if (sid !== null) entry.session = sid[1];
  return entry;
}

/** 状態を行き来させる遷移のログ見出し（往復検知の対象） */
const RESUME_KINDS = new Set(["確認待ちから復帰", "完了から実行中へ復帰", "切断から実行中へ復帰", "返答待ちから実行中へ復帰"]);
const DEMOTE_KINDS = new Set(["終了検知", "切断検知"]);

export interface FlipFlop {
  session: string;
  /** 往復回数（復帰 → 降格 の対が何回あったか） */
  count: number;
  /** 最後の往復の時刻 */
  lastAt: number;
  /** 代表的な組み合わせ（例「確認待ちから復帰 → 終了検知」） */
  pattern: string;
}

export interface LogSummary {
  /** 集計した行数（窓内） */
  lines: number;
  /** 窓の開始時刻 */
  since: number;
  /** 見出しごとの件数 */
  kinds: Record<string, number>;
  /** hook イベントの内訳（Stop / Notification / UserPromptSubmit …） */
  events: Record<string, number>;
  /** Jev 判定の内訳（判定名 → 件数） */
  judgments: Record<string, number>;
  /** WARN / ERROR 行（最大 20 件） */
  problems: Array<{ at: number; level: string; text: string }>;
  /** 状態の往復（多い順） */
  flipFlops: FlipFlop[];
  /** 最後に観測した起動（「Jev 判定:」行の時刻）。無ければ undefined */
  lastStartAt?: number;
}

/**
 * app.log の直近を集計する。now からさかのぼって windowMs の範囲だけを見る
 */
export function analyzeAppLog(text: string, now: number, windowMs: number = DIAGNOSE_WINDOW_MS): LogSummary {
  const since = now - windowMs;
  const kinds: Record<string, number> = {};
  const events: Record<string, number> = {};
  const judgments: Record<string, number> = {};
  const problems: Array<{ at: number; level: string; text: string }> = [];
  const lastMove = new Map<string, { at: number; kind: string; dir: "resume" | "demote" }>();
  const flips = new Map<string, FlipFlop>();
  let lines = 0;
  let lastStartAt: number | undefined;

  for (const raw of text.split(/\r?\n/)) {
    const e = parseLogLine(raw);
    if (e === null || e.at < since || e.at > now) continue;
    lines += 1;
    kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    if (e.kind === "event 受信") {
      const name = /^(\w+)/.exec(e.rest.trim());
      if (name !== null) events[name[1]] = (events[name[1]] ?? 0) + 1;
    }
    if (e.kind.startsWith("Jev ")) {
      const label = e.kind.slice("Jev ".length);
      judgments[label] = (judgments[label] ?? 0) + 1;
    }
    if (e.kind === "Jev 判定") lastStartAt = e.at; // 起動時に 1 回だけ出る行
    if (e.level !== "INFO" && problems.length < 20) problems.push({ at: e.at, level: e.level, text: `${e.kind}: ${e.rest}`.slice(0, 160) });

    const dir = RESUME_KINDS.has(e.kind) ? "resume" : DEMOTE_KINDS.has(e.kind) ? "demote" : null;
    if (dir === null || e.session === undefined) continue;
    const prev = lastMove.get(e.session);
    if (prev !== undefined && prev.dir !== dir && e.at - prev.at <= FLIP_FLOP_WINDOW_MS) {
      const cur = flips.get(e.session);
      const pattern = `${prev.kind} → ${e.kind}`;
      if (cur === undefined) flips.set(e.session, { session: e.session, count: 1, lastAt: e.at, pattern });
      else {
        cur.count += 1;
        cur.lastAt = e.at;
        cur.pattern = pattern;
      }
    }
    lastMove.set(e.session, { at: e.at, kind: e.kind, dir });
  }

  const summary: LogSummary = {
    lines,
    since,
    kinds,
    events,
    judgments,
    problems,
    flipFlops: [...flips.values()].sort((a, b) => b.count - a.count),
  };
  if (lastStartAt !== undefined) summary.lastStartAt = lastStartAt;
  return summary;
}

/* ---------------- 保存した表示と実データの食い違い ---------------- */

export interface DiagSession {
  sessionId: string;
  projectId: string;
  state: SessionState;
  confirmKind?: "permission" | "question";
  lastEventAt: number;
  transcriptPath?: string;
}

export interface ConsistencyDeps {
  now(): number;
  /** Claude Code の登録簿による生死 */
  liveness(sessionId: string): "alive" | "dead" | "unknown";
  /** transcript 終端の分類 */
  turnEnd(path: string): "concluded" | "open" | "unknown";
  /** subagent 記録だけの mtime。無ければ null */
  subagentMtimeMs(path: string): number | null;
  /** プロジェクト名（表示用） */
  projectName(projectId: string): string;
}

export interface Finding {
  /** ng = 表示が実態と食い違っている / warn = 念のため確認 */
  level: "ng" | "warn";
  session: string;
  project: string;
  text: string;
}

/** subagent が動いていると見なす窓（liveness-monitor と同じ考え方） */
export const SUBAGENT_FRESH_MS = 60_000;

/**
 * 保存した表示（sessions.json）と実データを突き合わせ、食い違いを挙げる。
 * 「表示が実態に追いついていない」ことの検出が目的で、直す判断は呼び出し側（人）が行う
 */
export function checkSessionConsistency(sessions: readonly DiagSession[], deps: ConsistencyDeps): Finding[] {
  const out: Finding[] = [];
  const now = deps.now();
  for (const s of sessions) {
    const project = deps.projectName(s.projectId);
    const sid = s.sessionId.slice(0, 8);
    const live = deps.liveness(s.sessionId);
    if (live === "dead") {
      out.push({ level: "warn", session: sid, project, text: `登録簿にプロセスが居ないのに表示が残っている（${s.state}）` });
      continue;
    }
    if (s.transcriptPath === undefined) continue;
    const turn = deps.turnEnd(s.transcriptPath);
    const sub = deps.subagentMtimeMs(s.transcriptPath);
    const subFresh = sub !== null && sub > now - SUBAGENT_FRESH_MS;
    if (s.state === "confirm" && turn === "open") {
      const label = s.confirmKind === "question" ? "返答待ち" : "確認待ち";
      out.push({ level: "ng", session: sid, project, text: `${label}なのにターンが進んでいる（作業中のはず）` });
    }
    if (s.state === "done" && subFresh) {
      out.push({ level: "ng", session: sid, project, text: "完了なのにサブエージェントが動いている（実行中のはず）" });
    }
    if (s.state === "running" && turn === "concluded" && !subFresh && now - s.lastEventAt > 5 * 60_000) {
      out.push({ level: "warn", session: sid, project, text: "実行中のままだがターンは終わっている（掃引で完了へ落ちるはず）" });
    }
    if (s.state === "disconnected" && (turn === "open" || subFresh)) {
      out.push({ level: "ng", session: sid, project, text: "切断表示だが transcript は動いている" });
    }
  }
  return out;
}

/* ---------------- 判定結果のまとめ ---------------- */

export type CheckLevel = "ok" | "warn" | "ng" | "skip";

export interface Check {
  name: string;
  level: CheckLevel;
  detail: string;
}

/** 全体の判定: ng が 1 つでもあれば ng、無ければ warn の有無で warn / ok */
export function overallLevel(checks: readonly Check[]): CheckLevel {
  if (checks.some((c) => c.level === "ng")) return "ng";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "ok";
}

const MARK: Record<CheckLevel, string> = { ok: "OK  ", warn: "WARN", ng: "NG  ", skip: "--  " };

/** コンソール向けの 1 行（診断結果はこの形で並べる） */
export function formatCheck(c: Check): string {
  return `${MARK[c.level]} ${c.name}: ${c.detail}`;
}

/** 件数の多い順に「名前 N」を並べる（ログ要約の表示用） */
export function formatCounts(counts: Record<string, number>, max = 6): string {
  const items = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (items.length === 0) return "なし";
  return items
    .slice(0, max)
    .map(([k, v]) => `${k} ${v}`)
    .join(" / ");
}
