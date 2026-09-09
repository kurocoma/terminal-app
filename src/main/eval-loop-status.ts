/**
 * eval-loop（品質ループ）の進捗バッジ（260907_2）と「作業継続中」判定の根拠（260908_1）。
 *
 * 情報源は eval-loop プラグイン v0.2（C:\dev\loopharness\plugins\eval-loop）がディスクに書く事実だけ:
 * - `<cwd>/.mso/sessions/<session_id>/state.json` … 直列ループ（hook-stop.sh / hook-prompt-submit.sh が参照する正本）
 * - `<cwd>/.mso/agents/<agent_id>/state.json` … fork・parallel ループ（state の session_id で本体セッションに対応付く）
 *   （旧 v3 ハーネスの `~/.claude/eval-loop/registry` は廃止済み。2026-09-08 実測: ディレクトリ自体が無い）
 * - state.json（2026-09-08 実測）… active / iteration（0 始まり）/ max_iterations / phase（plan → generator → eval）/
 *   latest_score / best_score / ended_reason / session_id / agent_id / turns_dir。ended_at は書かれないため
 *   終了時刻は state.json の mtime（loop-control.sh が active=false に書き換えた時刻）で代用する
 * - codex ジョブ `turns/turn-NNN-<plan|generator>-progress.log` … codex-common.sh の codex_exec_progress が
 *   PHASE_START 行で始め、無音 60 秒ごとに ♥ 行、PHASE_END 行で必ず閉じる。「走行中」= PHASE_END が無く
 *   mtime が JOB_STALE_MS 以内
 * - **task 未設定の state は無視する（260908_2）**: プラグインの SubagentStart hook は全 subagent に active=true の
 *   state を事前作成し、ループを使わない subagent のものは誰も閉じない（SubagentStop は Task 起動で確実には
 *   発火しない — anthropics/claude-code#27755。プラグインの never_started GC は UserPromptSubmit 時のみ）。
 *   2026-09-09 実測: 終わったループの隣に task="" / iteration 0/12 の残骸が 3 つ残り、タイルが回り続けた。
 *   loop-control.sh と同じ規則（task が空 or "task not set" = ループ未開始）で除外する
 *
 * 表示は 1 行: 「ループ 2/4・codex 実装中 1分・最高 78点」（周回数は 1 始まり）。終了後は ENDED_SHOW_MS の間だけ
 * 「ループ終了・合格 92点」。LLM の自己申告に依存せず、読めない・壊れているものは黙って無視する（バッジ無し）。
 */
import * as fs from "fs";
import * as path from "path";

export interface LoopState {
  active: boolean;
  /** 0 始まり（state.json のまま。表示時に +1 する） */
  iteration: number;
  maxIterations: number;
  phase?: string;
  threshold?: number;
  latestScore?: number;
  bestScore?: number;
  endedReason?: string;
  /** epoch 秒。state.json に ended_at があればそれ、無ければ active=false の state.json の mtime */
  endedAt?: number;
  sessionId?: string;
  agentId?: string;
  /** codex ジョブの進捗ログが置かれる turns ディレクトリ（state.json の turns_dir。無ければ state.json と同階層の turns/） */
  turnsDir?: string;
  /** state.json の mtime（epoch ms。ファイル由来のときだけ。停滞判定に使う） */
  mtimeMs?: number;
  /** task が設定済み（= ループが実際に始まっている）。未設定は SubagentStart の事前作成 state の残骸（260908_2） */
  hasTask: boolean;
}

export interface RunningJob {
  role: "plan" | "generator";
  elapsedMs: number;
}

/** 1 セッション分のループ状況（バッジ文言＋作業継続中判定の材料） */
export interface LoopStatus {
  /** バッジ文言（進行中・終了後 30 分）。無ければ undefined */
  text?: string;
  /** 進行中のループがあるか */
  active: boolean;
  /** 走行中の codex ジョブ（進行中ループの現在イテレーション） */
  job: RunningJob | null;
  /** ループ側の最終活動時刻（epoch ms）= state.json / 進捗ログの新しい方。停滞判定用 */
  lastActivityMs?: number;
}

/** ループ終了後にバッジを出し続ける時間（30 分） */
export const ENDED_SHOW_MS = 30 * 60_000;
/** codex ジョブの進捗ログがこれより古ければ走行中とみなさない（ハートビート 60 秒 × 2 ＋余裕） */
export const JOB_STALE_MS = 150_000;
/** `.mso/agents` の走査上限（残骸 state の掃除はプラグイン側の hook に任せる） */
const MAX_AGENT_ENTRIES = 200;
const JOB_ROLES: ReadonlyArray<RunningJob["role"]> = ["plan", "generator"];
/** 進捗ログ末尾の走査量（PHASE_END 行の有無を見るには末尾だけで足りる） */
const PROGRESS_TAIL_BYTES = 4096;

const PHASE_LABEL: Record<string, string> = { plan: "計画中", generator: "実装中", evaluator: "採点中", eval: "判定中" };
const JOB_LABEL: Record<RunningJob["role"], string> = { plan: "計画中", generator: "実装中" };
const REASON_LABEL: Record<string, string> = {
  threshold_met: "合格",
  max_iterations: "上限到達",
  cancelled: "停止",
  wall_clock_exceeded: "時間切れ",
  invalid_eval_output: "採点不能",
};

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * state.json の本文 → 表示に要る項目。active が boolean でない・JSON でないものは null。
 * fileMtimeMs を渡すと mtimeMs に載せ、active=false で ended_at が無いときの endedAt にも使う
 */
export function parseLoopState(text: string, fileMtimeMs?: number): LoopState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.active !== "boolean") return null;
  const iteration = num(r.iteration);
  const max = num(r.max_iterations);
  const task = str(r.task);
  const s: LoopState = {
    active: r.active,
    iteration: iteration !== undefined && iteration >= 0 ? Math.floor(iteration) : 0,
    maxIterations: max !== undefined && max > 0 ? Math.floor(max) : 12, // loop-control.sh の既定
    hasTask: task !== undefined && task.trim() !== "" && task !== "task not set",
  };
  const phase = str(r.phase);
  if (phase !== undefined) s.phase = phase;
  const threshold = num(r.threshold);
  if (threshold !== undefined) s.threshold = threshold;
  const latest = num(r.latest_score);
  if (latest !== undefined) s.latestScore = latest;
  const best = num(r.best_score);
  if (best !== undefined) s.bestScore = best;
  const reason = str(r.ended_reason);
  if (reason !== undefined) s.endedReason = reason;
  const endedAt = num(r.ended_at);
  if (endedAt !== undefined) s.endedAt = endedAt;
  else if (!s.active && fileMtimeMs !== undefined) s.endedAt = Math.floor(fileMtimeMs / 1000);
  const sessionId = str(r.session_id);
  if (sessionId !== undefined) s.sessionId = sessionId;
  const agentId = str(r.agent_id);
  if (agentId !== undefined) s.agentId = agentId;
  const turnsDir = str(r.turns_dir);
  if (turnsDir !== undefined) s.turnsDir = turnsDir;
  if (fileMtimeMs !== undefined) s.mtimeMs = fileMtimeMs;
  return s;
}

function mtimeMs(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/** 進捗ログの末尾に PHASE_END 行があるか（読めなければ「ある」= 走行中扱いしない安全側） */
function progressLogEnded(p: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(p, "r");
  } catch {
    return true;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const readLen = Math.min(size, PROGRESS_TAIL_BYTES);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, size - readLen);
    return buf.toString("utf8").includes("PHASE_END");
  } catch {
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

/** 進捗ログ先頭の PHASE_START 行から開始時刻を推定できないため、経過は「ファイル作成時刻」起点（birthtime が無ければ mtime） */
function startedAtMs(p: string): number | null {
  try {
    const st = fs.statSync(p);
    return st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 現在イテレーションで走行中の codex ジョブ（plan → generator の順で最初のもの）。
 * 走行中 = 進捗ログに PHASE_END が無く、mtime が JOB_STALE_MS 以内。turns_dir 不明・無しは null
 */
export function readRunningJob(turnsDir: string | undefined, iteration: number, now: number): RunningJob | null {
  if (turnsDir === undefined) return null;
  const prefix = `turn-${String(iteration).padStart(3, "0")}-`;
  for (const role of JOB_ROLES) {
    const p = path.join(turnsDir, `${prefix}${role}-progress.log`);
    const m = mtimeMs(p);
    if (m === null || now - m > JOB_STALE_MS) continue;
    if (progressLogEnded(p)) continue;
    const started = startedAtMs(p) ?? m;
    return { role, elapsedMs: Math.max(0, now - started) };
  }
  return null;
}

/** ループ側の最終活動時刻 = state.json の mtime と現在イテレーションの進捗ログ mtime の新しい方 */
function loopActivityMs(state: LoopState): number | undefined {
  let latest = state.mtimeMs;
  if (state.turnsDir !== undefined) {
    const prefix = `turn-${String(state.iteration).padStart(3, "0")}-`;
    for (const role of JOB_ROLES) {
      const m = mtimeMs(path.join(state.turnsDir, `${prefix}${role}-progress.log`));
      if (m !== null && (latest === undefined || m > latest)) latest = m;
    }
  }
  return latest;
}

/**
 * 1 ループの表示文字列。
 * - 進行中: 「ループ N/M・<段階>」（N = iteration+1）。codex ジョブ走行中は段階を「codex 計画中／実装中 <経過分>分」に
 *   置き換える。2 周目以降で best_score があれば「・最高 NN点」
 * - 終了: 「ループ終了・<理由> <点数>点」を endedAt から ENDED_SHOW_MS の間だけ。理由は既知のものだけ日本語化
 *   （stalled:* は「停滞で停止」）。never_started（task 未設定のまま掃除された state）と endedAt 無しは出さない
 */
export function describeLoop(state: LoopState, job: RunningJob | null, now: number): string | undefined {
  if (state.active) {
    const stage =
      job !== null
        ? `codex ${JOB_LABEL[job.role]} ${Math.floor(job.elapsedMs / 60_000)}分`
        : (PHASE_LABEL[state.phase ?? ""] ?? "進行中");
    let text = `ループ ${state.iteration + 1}/${state.maxIterations}・${stage}`;
    if (state.iteration > 0 && state.bestScore !== undefined) text += `・最高 ${state.bestScore}点`;
    return text;
  }
  if (state.endedReason === undefined || state.endedReason === "never_started" || state.endedAt === undefined) return undefined;
  if (now - state.endedAt * 1000 > ENDED_SHOW_MS) return undefined;
  const reason = state.endedReason.startsWith("stalled") ? "停滞で停止" : REASON_LABEL[state.endedReason];
  const score = state.latestScore ?? state.bestScore;
  let text = "ループ終了";
  if (reason !== undefined) text += `・${reason}`;
  if (score !== undefined) text += reason !== undefined ? ` ${score}点` : `・${score}点`;
  return text;
}

/** state.json を読む。読めない・壊れているときは null。turns_dir が無ければ同階層の turns/ を補う */
function readStateFile(statePath: string): LoopState | null {
  let text: string;
  try {
    text = fs.readFileSync(statePath, "utf8");
  } catch {
    return null;
  }
  const m = mtimeMs(statePath);
  const state = parseLoopState(text, m ?? undefined);
  if (state === null) return null;
  if (!state.hasTask) return null; // ループ未開始の事前作成 state（残骸）は存在しないものとして扱う（260908_2）
  if (state.turnsDir === undefined) state.turnsDir = path.join(path.dirname(statePath), "turns");
  return state;
}

/** 検索対象セッション（cwd は hook payload 由来。無ければプロジェクトのパスだけを見る） */
export interface LoopLookupSession {
  sessionId: string;
  cwd?: string;
  projectPath: string;
}

/** `.mso` を探す基点（cwd とプロジェクトルート。重複は除く） */
function baseDirsOf(s: LoopLookupSession): string[] {
  const out: string[] = [];
  for (const d of [s.cwd, s.projectPath]) {
    if (d === undefined || d === "") continue;
    const n = path.resolve(d);
    if (!out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n);
  }
  return out;
}

/** セッションに対応するループ state をすべて集める（直列 = sessions/<sid>、fork = agents/* の session_id 一致） */
export function findLoopsForSession(s: LoopLookupSession): LoopState[] {
  if (!/^[A-Za-z0-9._-]+$/.test(s.sessionId)) return []; // hook 側と同じ規則: 区切り文字を含む id はたどらない
  const out: LoopState[] = [];
  const seen = new Set<string>();
  const add = (statePath: string, state: LoopState): void => {
    const key = statePath.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(state);
  };
  for (const base of baseDirsOf(s)) {
    const mso = path.join(base, ".mso");
    const serial = path.join(mso, "sessions", s.sessionId, "state.json");
    const st = readStateFile(serial);
    if (st !== null) add(serial, st);
    const agentsDir = path.join(mso, "agents");
    let names: string[] = [];
    try {
      names = fs.readdirSync(agentsDir);
    } catch {
      names = [];
    }
    for (const name of names.slice(0, MAX_AGENT_ENTRIES)) {
      const p = path.join(agentsDir, name, "state.json");
      const a = readStateFile(p);
      if (a !== null && a.sessionId === s.sessionId) add(p, a);
    }
  }
  return out;
}

/** 同じセッションに複数ループがあるときの状況: 進行中を優先（他があれば件数）、無ければ最も新しく終わったもの */
export function summarizeLoops(loops: readonly LoopState[], now: number): LoopStatus {
  const active = loops.filter((s) => s.active);
  if (active.length > 0) {
    const s = active[0];
    const job = readRunningJob(s.turnsDir, s.iteration, now);
    const text = describeLoop(s, job, now);
    let lastActivityMs: number | undefined;
    for (const a of active) {
      const m = loopActivityMs(a);
      if (m !== undefined && (lastActivityMs === undefined || m > lastActivityMs)) lastActivityMs = m;
    }
    const status: LoopStatus = { active: true, job, lastActivityMs };
    if (text !== undefined) status.text = active.length > 1 ? `${text}（他 ${active.length - 1} 本）` : text;
    return status;
  }
  const ended = loops.filter((s) => s.endedAt !== undefined).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  for (const s of ended) {
    const text = describeLoop(s, null, now);
    if (text !== undefined) return { active: false, job: null, text };
  }
  return { active: false, job: null };
}

/**
 * 指定セッション群のループ状況。読めない・壊れている・対応する state が無いセッションは結果に含めない（例外は投げない）
 */
export function loopStatusForSessions(sessions: readonly LoopLookupSession[], now: number): Map<string, LoopStatus> {
  const out = new Map<string, LoopStatus>();
  for (const s of sessions) {
    if (out.has(s.sessionId)) continue;
    const loops = findLoopsForSession(s);
    if (loops.length === 0) continue;
    const status = summarizeLoops(loops, now);
    if (status.active || status.text !== undefined) out.set(s.sessionId, status);
  }
  return out;
}
