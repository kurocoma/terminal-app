/**
 * 260907_2 / 260908_1: eval-loop（品質ループ）の進捗バッジと「作業継続中」判定の材料。
 * eval-loop プラグイン v0.2 が `<cwd>/.mso/sessions/<sid>/state.json`（直列）と `<cwd>/.mso/agents/<agent>/state.json`（fork）に
 * 書く state と、`turns/turn-NNN-<plan|generator>-progress.log`（PHASE_START … PHASE_END）から
 * 「ループ 2/4・codex 実装中 1分・最高 78点」のような 1 行と、進行中か／codex ジョブが走っているかを作る。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ENDED_SHOW_MS,
  JOB_STALE_MS,
  describeLoop,
  findLoopsForSession,
  loopStatusForSessions,
  parseLoopState,
  readRunningJob,
  summarizeLoops,
  type LoopState,
} from "../src/main/eval-loop-status";

const NOW = Date.parse("2026-09-08T08:30:00.000Z");
const NOW_S = Math.floor(NOW / 1000);

/** 実測の state.json（Pricefluctuation-app 2026-09-08。長いフィールドは省略） */
const REAL_STATE = {
  loop_type: "eval",
  active: true,
  iteration: 0,
  max_iterations: 4,
  threshold: 90,
  started_at: 1788854627,
  max_wall_minutes: 360,
  ended_reason: null,
  session_id: "632eda45-2131-4192-aaaf-5f6c4cf5baf1",
  agent_id: null,
  project_dir: "C:/dev/Pricefluctuation-app",
  task: "ホットキー（キーボードショートカット）設定機能を構築する。",
  latest_score: null,
  best_score: null,
  turns_dir: "C:/dev/Pricefluctuation-app/.mso/sessions/632eda45-2131-4192-aaaf-5f6c4cf5baf1/turns",
  phase: "plan",
  generator_skill: "assign-codex-generator",
  evaluator_skill: "assign-eval-loop-evaluator",
};

function state(over: Partial<LoopState> = {}): LoopState {
  return { active: true, iteration: 0, maxIterations: 4, hasTask: true, ...over };
}

describe("parseLoopState", () => {
  it("実測フォーマットから表示に要る項目を取り出す（turns_dir・mtime も載る）", () => {
    expect(parseLoopState(JSON.stringify(REAL_STATE), NOW)).toEqual({
      active: true,
      iteration: 0,
      maxIterations: 4,
      phase: "plan",
      threshold: 90,
      sessionId: "632eda45-2131-4192-aaaf-5f6c4cf5baf1",
      turnsDir: REAL_STATE.turns_dir,
      mtimeMs: NOW,
      hasTask: true,
    });
  });

  it("task が空・\"task not set\"・欠落 は hasTask=false（SubagentStart の事前作成 state = ループ未開始。260908_2）", () => {
    expect(parseLoopState(JSON.stringify({ ...REAL_STATE, task: "" }))?.hasTask).toBe(false);
    expect(parseLoopState(JSON.stringify({ ...REAL_STATE, task: "task not set" }))?.hasTask).toBe(false);
    expect(parseLoopState(JSON.stringify({ ...REAL_STATE, task: "  " }))?.hasTask).toBe(false);
    expect(parseLoopState(JSON.stringify({ active: true }))?.hasTask).toBe(false);
    expect(parseLoopState(JSON.stringify(REAL_STATE))?.hasTask).toBe(true);
  });

  it("終了した state: ended_at があればそれ、無ければ（プラグイン v0.2 は書かない）ファイル mtime を終了時刻にする", () => {
    const ended = { ...REAL_STATE, active: false, ended_reason: "threshold_met", latest_score: 100, best_score: 100, agent_id: "a6be3bf9", session_id: "cf955ad8" };
    expect(parseLoopState(JSON.stringify({ ...ended, ended_at: 1788719308 }), NOW)).toMatchObject({
      active: false, endedReason: "threshold_met", endedAt: 1788719308, latestScore: 100, bestScore: 100, agentId: "a6be3bf9", sessionId: "cf955ad8",
    });
    expect(parseLoopState(JSON.stringify(ended), NOW)).toMatchObject({ active: false, endedAt: NOW_S });
    expect(parseLoopState(JSON.stringify(ended))).not.toHaveProperty("endedAt"); // mtime も無ければ終了時刻不明
  });

  it("壊れた JSON・オブジェクトでない・active が boolean でない は null。iteration/max の欠落は 0 / 12（loop-control の既定）", () => {
    expect(parseLoopState("{")).toBe(null);
    expect(parseLoopState("[1]")).toBe(null);
    expect(parseLoopState(JSON.stringify({ iteration: 1 }))).toBe(null);
    expect(parseLoopState(JSON.stringify({ active: true }))).toEqual({ active: true, iteration: 0, maxIterations: 12, hasTask: false });
  });
});

describe("describeLoop（表示文字列）", () => {
  it("進行中: ループ N/M（N は 1 始まり）・phase の日本語", () => {
    expect(describeLoop(state({ phase: "plan" }), null, NOW)).toBe("ループ 1/4・計画中");
    expect(describeLoop(state({ phase: "generator" }), null, NOW)).toBe("ループ 1/4・実装中");
    expect(describeLoop(state({ phase: "evaluator", iteration: 2 }), null, NOW)).toBe("ループ 3/4・採点中");
    expect(describeLoop(state({ phase: "eval" }), null, NOW)).toBe("ループ 1/4・判定中");
    expect(describeLoop(state({ phase: undefined }), null, NOW)).toBe("ループ 1/4・進行中");
    expect(describeLoop(state({ phase: "something-new" }), null, NOW)).toBe("ループ 1/4・進行中");
  });

  it("codex ジョブが走っていれば phase より優先して「codex 計画中／実装中 + 経過」を出す", () => {
    expect(describeLoop(state({ phase: "generator" }), { role: "generator", elapsedMs: 65_000 }, NOW)).toBe("ループ 1/4・codex 実装中 1分");
    expect(describeLoop(state({ phase: "plan" }), { role: "plan", elapsedMs: 20_000 }, NOW)).toBe("ループ 1/4・codex 計画中 0分");
    expect(describeLoop(state({ phase: "generator" }), { role: "generator", elapsedMs: 3_700_000 }, NOW)).toBe("ループ 1/4・codex 実装中 61分");
  });

  it("2 周目以降で最高点があれば末尾に付ける（1 周目は付けない）", () => {
    expect(describeLoop(state({ iteration: 1, phase: "generator", bestScore: 78 }), null, NOW)).toBe("ループ 2/4・実装中・最高 78点");
    expect(describeLoop(state({ iteration: 0, phase: "generator", bestScore: 78 }), null, NOW)).toBe("ループ 1/4・実装中");
    expect(describeLoop(state({ iteration: 1, phase: "generator" }), null, NOW)).toBe("ループ 2/4・実装中");
  });

  it("終了: 理由の日本語 + 点数（latest → best の順）。終了から 30 分を過ぎたら出さない", () => {
    const ended = (reason: string, over: Partial<LoopState> = {}) => state({ active: false, endedReason: reason, endedAt: NOW_S - 60, ...over });
    expect(describeLoop(ended("threshold_met", { latestScore: 92, bestScore: 80 }), null, NOW)).toBe("ループ終了・合格 92点");
    expect(describeLoop(ended("max_iterations", { bestScore: 78 }), null, NOW)).toBe("ループ終了・上限到達 78点");
    expect(describeLoop(ended("cancelled"), null, NOW)).toBe("ループ終了・停止");
    expect(describeLoop(ended("wall_clock_exceeded", { latestScore: 70 }), null, NOW)).toBe("ループ終了・時間切れ 70点");
    expect(describeLoop(ended("stalled:WAIT_GENERATOR"), null, NOW)).toBe("ループ終了・停滞で停止");
    expect(describeLoop(ended("invalid_eval_output"), null, NOW)).toBe("ループ終了・採点不能");
    expect(describeLoop(ended("mystery"), null, NOW)).toBe("ループ終了");
    expect(describeLoop(ended("threshold_met", { endedAt: NOW_S - ENDED_SHOW_MS / 1000 - 1 }), null, NOW)).toBeUndefined();
    expect(describeLoop(ended("threshold_met", { endedAt: NOW_S - ENDED_SHOW_MS / 1000 }), null, NOW)).toBe("ループ終了・合格");
  });

  it("never_started（task 未設定のまま掃除された state）と終了時刻不明の終了は出さない", () => {
    expect(describeLoop(state({ active: false, endedReason: "never_started", endedAt: NOW_S }), null, NOW)).toBeUndefined();
    expect(describeLoop(state({ active: false, endedReason: "threshold_met" }), null, NOW)).toBeUndefined();
  });
});

describe("readRunningJob / findLoopsForSession / loopStatusForSessions（ファイル）", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-evalloop-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** 進捗ログを置く。ended=true なら PHASE_END 行で閉じる。ageMs = mtime を NOW から遡らせる */
  function progress(turnsDir: string, name: string, opts: { ended?: boolean; ageMs?: number } = {}): string {
    fs.mkdirSync(turnsDir, { recursive: true });
    const p = path.join(turnsDir, name);
    const lines = ["[17:08:00 +0m00s] generator#000 PHASE_START model=gpt-6-astra effort=xhigh sandbox=workspace-write", "[17:09:00 +1m00s] generator#000 ♥"];
    if (opts.ended === true) lines.push("[17:20:00 +12m00s] generator#000 PHASE_END rc=0");
    fs.writeFileSync(p, lines.join("\n") + "\n");
    const t = new Date(NOW - (opts.ageMs ?? 0));
    fs.utimesSync(p, t, t);
    return p;
  }

  it("readRunningJob: 現在イテレーションの進捗ログに PHASE_END が無く mtime が新しい → running（役割は plan → generator の順）", () => {
    const turns = path.join(dir, "turns");
    progress(turns, "turn-001-generator-progress.log", { ageMs: 5_000 });
    expect(readRunningJob(turns, 1, NOW)).toMatchObject({ role: "generator" });
    progress(turns, "turn-001-plan-progress.log", { ageMs: 1_000 });
    expect(readRunningJob(turns, 1, NOW)).toMatchObject({ role: "plan" });
  });

  it("readRunningJob: PHASE_END 済み／mtime が JOB_STALE_MS より古い／別イテレーション／turns 不明 → null", () => {
    const turns = path.join(dir, "turns");
    progress(turns, "turn-001-generator-progress.log", { ended: true, ageMs: 1_000 });
    expect(readRunningJob(turns, 1, NOW)).toBe(null);
    progress(turns, "turn-002-generator-progress.log", { ageMs: JOB_STALE_MS + 1 });
    expect(readRunningJob(turns, 2, NOW)).toBe(null);
    progress(turns, "turn-003-generator-progress.log", { ageMs: JOB_STALE_MS });
    expect(readRunningJob(turns, 3, NOW)).toMatchObject({ role: "generator" });
    expect(readRunningJob(turns, 4, NOW)).toBe(null);
    expect(readRunningJob(undefined, 1, NOW)).toBe(null);
    expect(readRunningJob(path.join(dir, "nope"), 1, NOW)).toBe(null);
  });

  /** `<base>/.mso/{sessions|agents}/<id>/state.json` を置く（turns_dir は同階層 turns/。プラグインは絶対パスを書く） */
  function writeState(base: string, kind: "sessions" | "agents", id: string, stateObj: Record<string, unknown>, mtimeAgeMs = 0): string {
    const stateDir = path.join(base, ".mso", kind, id);
    fs.mkdirSync(stateDir, { recursive: true });
    const stateFile = path.join(stateDir, "state.json");
    fs.writeFileSync(stateFile, JSON.stringify({ ...stateObj, turns_dir: path.join(stateDir, "turns").replace(/\\/g, "/") }));
    const t = new Date(NOW - mtimeAgeMs);
    fs.utimesSync(stateFile, t, t);
    return stateDir;
  }

  it("直列ループ: <cwd>/.mso/sessions/<sid>/state.json を読み、codex ジョブ込みの表示・active・job を返す", () => {
    const stateDir = writeState(dir, "sessions", "s1", { ...REAL_STATE, session_id: "s1", iteration: 1, best_score: 78, phase: "generator" }, 60_000);
    progress(path.join(stateDir, "turns"), "turn-001-generator-progress.log", { ageMs: 3_000 });
    const m = loopStatusForSessions([{ sessionId: "s1", cwd: dir, projectPath: dir }, { sessionId: "s2", cwd: dir, projectPath: dir }], NOW);
    expect(m.get("s1")).toMatchObject({ active: true, job: { role: "generator" }, text: "ループ 2/4・codex 実装中 0分・最高 78点" });
    expect(m.get("s1")?.lastActivityMs).toBe(NOW - 3_000); // 進捗ログの方が state.json より新しい
    expect(m.has("s2")).toBe(false);
  });

  it("cwd が無い（再接続復元のみ）セッションはプロジェクトのパスから探す。cwd がサブディレクトリなら cwd 側とプロジェクト側の両方を見る", () => {
    writeState(dir, "sessions", "s1", { ...REAL_STATE, session_id: "s1", phase: "plan" });
    expect(loopStatusForSessions([{ sessionId: "s1", projectPath: dir }], NOW).get("s1")?.text).toBe("ループ 1/4・計画中");
    const sub = path.join(dir, "packages", "web");
    fs.mkdirSync(sub, { recursive: true });
    expect(loopStatusForSessions([{ sessionId: "s1", cwd: sub, projectPath: dir }], NOW).get("s1")?.text).toBe("ループ 1/4・計画中");
    writeState(sub, "sessions", "s3", { ...REAL_STATE, session_id: "s3", phase: "eval" });
    expect(loopStatusForSessions([{ sessionId: "s3", cwd: sub, projectPath: dir }], NOW).get("s3")?.text).toBe("ループ 1/4・判定中");
  });

  it("fork ループ（.mso/agents/<agentId>。state の session_id で対応付け）も拾う", () => {
    writeState(dir, "agents", "a6be3bf9a9c1e87d1", { ...REAL_STATE, session_id: "s9", agent_id: "a6be3bf9a9c1e87d1", iteration: 0, phase: "evaluator" });
    expect(loopStatusForSessions([{ sessionId: "s9", cwd: dir, projectPath: dir }], NOW).get("s9")).toMatchObject({ active: true, job: null, text: "ループ 1/4・採点中" });
  });

  it("同じセッションに複数ループ → 進行中を優先し「（他 N 本）」を添える。終了のみなら終了表示（終了時刻は state.json の mtime）", () => {
    writeState(dir, "sessions", "s1", { ...REAL_STATE, session_id: "s1", active: false, ended_reason: "threshold_met", latest_score: 95 }, 10_000);
    writeState(dir, "agents", "agent-a", { ...REAL_STATE, session_id: "s1", agent_id: "agent-a", iteration: 2, phase: "plan" });
    writeState(dir, "agents", "agent-b", { ...REAL_STATE, session_id: "s1", agent_id: "agent-b", iteration: 0, phase: "generator" });
    const lookup = [{ sessionId: "s1", cwd: dir, projectPath: dir }];
    expect(loopStatusForSessions(lookup, NOW).get("s1")?.text).toMatch(/^ループ [13]\/4・(計画中|実装中)（他 1 本）$/);
    fs.rmSync(path.join(dir, ".mso", "agents"), { recursive: true, force: true });
    expect(loopStatusForSessions(lookup, NOW).get("s1")).toEqual({ active: false, job: null, text: "ループ終了・合格 95点" });
  });

  it("summarizeLoops: 30 分より前に終わったループは表示も active も無し（呼び出し側はセッションを結果に含めない）", () => {
    writeState(dir, "sessions", "s1", { ...REAL_STATE, session_id: "s1", active: false, ended_reason: "cancelled" }, ENDED_SHOW_MS + 1_000);
    const loops = findLoopsForSession({ sessionId: "s1", cwd: dir, projectPath: dir });
    expect(loops).toHaveLength(1);
    expect(summarizeLoops(loops, NOW)).toEqual({ active: false, job: null });
    expect(loopStatusForSessions([{ sessionId: "s1", cwd: dir, projectPath: dir }], NOW).size).toBe(0);
  });

  it("task 未設定の active な state（事前作成の残骸）は存在しない扱い: 保持も「（他 N 本）」もバッジも出ない（260908_2）", () => {
    // 2026-09-09 実測: 終わった直列ループの隣に task="" / iteration 0/12 の agents state が 3 つ残り、
    // 「ループ 1/12・計画中（他 2 本）」で保持され続けた
    writeState(dir, "sessions", "s1", { ...REAL_STATE, session_id: "s1", active: false, ended_reason: "threshold_met", latest_score: 91 }, 60_000);
    for (const a of ["a23e90ad45bf", "a859d90c042c", "aa35d16707f2"]) {
      writeState(dir, "agents", a, { loop_type: "eval", active: true, iteration: 0, max_iterations: 12, threshold: 70, phase: "plan", task: "", session_id: "s1", agent_id: a });
    }
    writeState(dir, "agents", "notset", { loop_type: "eval", active: true, iteration: 0, max_iterations: 12, phase: "plan", task: "task not set", session_id: "s1", agent_id: "notset" });
    expect(findLoopsForSession({ sessionId: "s1", cwd: dir, projectPath: dir })).toHaveLength(1);
    expect(loopStatusForSessions([{ sessionId: "s1", cwd: dir, projectPath: dir }], NOW).get("s1")).toEqual({ active: false, job: null, text: "ループ終了・合格 91点" });
    // task が入った本物の fork ループなら拾う
    writeState(dir, "agents", "real", { ...REAL_STATE, session_id: "s1", agent_id: "real", phase: "generator" });
    expect(loopStatusForSessions([{ sessionId: "s1", cwd: dir, projectPath: dir }], NOW).get("s1")).toMatchObject({ active: true, text: "ループ 1/4・実装中" });
  });

  it("state が無い・壊れている・.mso 自体が無い・区切り文字入りの id → そのセッションは無し（例外を出さない）", () => {
    const broken = path.join(dir, ".mso", "sessions", "s3");
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, "state.json"), "{not json");
    const m = loopStatusForSessions(
      [
        { sessionId: "s1", cwd: dir, projectPath: dir },
        { sessionId: "s3", cwd: dir, projectPath: dir },
        { sessionId: "../s1", cwd: dir, projectPath: dir },
        { sessionId: "s1", cwd: path.join(dir, "nowhere"), projectPath: path.join(dir, "nowhere") },
      ],
      NOW
    );
    expect(m.size).toBe(0);
  });
});
