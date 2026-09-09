/* global fetch, WebSocket */
/**
 * 260907_2 / 260908_1 ライブ検証: 実 Electron（非デモ・専用 dataDir・専用ポート・擬似登録簿）で、
 * タイルのループ進捗バッジと「作業継続中の保持」が eval-loop プラグイン v0.2 の `.mso/` と登録簿から作られることを実測する。
 *
 * (a) <proj>/.mso/sessions/<sessionId>/state.json（進行中・2 周目・best_score 78・codex generator 進捗ログ走行中）
 *     → 「ループ 2/4・codex 実装中 0分・最高 78点」
 * (b) <proj>/.mso/agents/<agentId>/state.json（fork ループ。session_id で対応付け。evaluator 段階）→ 「ループ 1/4・採点中」
 * (c) ループの無いセッションにはバッジが出ない
 * (f) ループ進行中の Stop → 完了にならず実行中のまま（登録簿 idle でも）。入力待ち Notification → 確認待ちにならない。
 *     許可要求 Notification → 確認待ち（人の応答が要る）
 * (d) 進捗ログに PHASE_END（codex ジョブ終了）→ 「ループ 2/4・実装中・最高 78点」
 * (e) ループ終了（threshold_met・92 点。終了時刻は state.json の mtime）→ 「ループ終了・合格 92点」。fork ループは 31 分前に終了 → バッジ消滅。
 *     終了後の Stop → 完了になる
 * (g) バックグラウンド作業の完了待ち: task-notification で起床（作業テキストは維持）→ Stop でも登録簿 status=shell の間は実行中、
 *     status=idle になったら掃引の終了検知で完了
 * (h) 260908_2: c には task="" の事前作成 state（SubagentStart の残骸）が 3 つあるが、バッジも保持も出ない。
 *     Notification は公式 notification_type で分類（idle_prompt は文言が permission 風でも保持、agent_needs_input は確認待ち）
 *
 * 使い方: npm run build 後に node scripts/verify-loop-badge-e2e.mjs [出力先ディレクトリ]
 * 実 ~/.claude/sessions と実プロジェクトには触れない。掃引 2 秒。実稼働アプリ（既定 41321）と並走できる。
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EVENT_PORT = 42201;
const CDP_PORT = 9339;
const SWEEP_MS = 2000;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-badge-e2e-"));
const sessionsDir = path.join(dataDir, "sessions");
const outDir = process.argv[2] !== undefined ? path.resolve(process.argv[2]) : dataDir;
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(sessionsDir, { recursive: true });

const projects = ["a", "b", "c"].map((k) => ({ key: k, id: `p-${k}`, dir: fs.mkdtempSync(path.join(os.tmpdir(), `ta-badge-proj-${k}-`)) }));
const projDir = (k) => projects.find((p) => p.key === k).dir;
const S = { a: "e2e0000a-0000-4000-8000-000000000001", b: "e2e0000b-0000-4000-8000-000000000002", c: "e2e0000c-0000-4000-8000-000000000003" };
const AGENT = "a1b2c3d4e5f60718";
const fwd = (p) => p.replace(/\\/g, "/");

// 擬似登録簿（pid は自プロセス = 生存）。a は idle（ループ保持だけで実行中に保てることを見る）、b は busy、c は shell（バックグラウンド作業あり）
const writeRegistry = (k, status) =>
  fs.writeFileSync(path.join(sessionsDir, `${k}.json`), JSON.stringify({ pid: process.pid, sessionId: S[k], entrypoint: "cli", status }));
writeRegistry("a", "idle");
writeRegistry("b", "busy");
writeRegistry("c", "shell");

// state.json（プラグイン v0.2 の配置: <cwd>/.mso/sessions/<sid> と <cwd>/.mso/agents/<agent>。turns_dir は同階層 turns/）
const stateA = path.join(projDir("a"), ".mso", "sessions", S.a);
const stateB = path.join(projDir("b"), ".mso", "agents", AGENT);
fs.mkdirSync(path.join(stateA, "turns"), { recursive: true });
fs.mkdirSync(path.join(stateB, "turns"), { recursive: true });
const writeState = (dir, obj, mtimeAgeMs = 0) => {
  const p = path.join(dir, "state.json");
  // task は本物のループの印（loop-start.sh が書く）。残骸を作るときは obj 側で task: "" を渡して上書きする（260908_2）
  fs.writeFileSync(p, JSON.stringify({ loop_type: "eval", task: "E2E: ループの疑似タスク", turns_dir: fwd(path.join(dir, "turns")), ...obj }));
  const t = new Date(Date.now() - mtimeAgeMs);
  fs.utimesSync(p, t, t);
};
writeState(stateA, { active: true, iteration: 1, max_iterations: 4, threshold: 90, phase: "generator", best_score: 78, session_id: S.a, agent_id: null, generator_skill: "assign-codex-generator" });
writeState(stateB, { active: true, iteration: 0, max_iterations: 4, threshold: 90, phase: "evaluator", session_id: S.b, agent_id: AGENT });
// (h) c: ループ未開始の事前作成 state の残骸（task=""・iteration 0/12・active=true）。2026-09-09 実測と同じ形
for (const agent of ["a23e90ad45bfbd53c", "a859d90c042c81c5a", "aa35d16707f2a5f4b"]) {
  const d = path.join(projDir("c"), ".mso", "agents", agent);
  fs.mkdirSync(path.join(d, "turns"), { recursive: true });
  writeState(d, { active: true, iteration: 0, max_iterations: 12, threshold: 70, phase: "plan", task: "", session_id: S.c, agent_id: agent }, 2 * 3600_000);
}
const progressA = path.join(stateA, "turns", "turn-001-generator-progress.log");
fs.writeFileSync(progressA, "[17:08:00 +0m00s] generator#001 PHASE_START model=gpt-6-astra effort=xhigh sandbox=workspace-write\n[17:09:00 +1m00s] generator#001 ♥\n");

fs.writeFileSync(
  path.join(dataDir, "config.json"),
  JSON.stringify({ version: 1, port: EVENT_PORT, theme: "dark", alwaysOnTopDefault: false, notifySound: { enabled: false }, customStatuses: [], showUnlinked: true }, null, 2)
);
fs.writeFileSync(
  path.join(dataDir, "projects.json"),
  JSON.stringify({ version: 1, projects: projects.map((p) => ({ id: p.id, name: `loop-${p.key}`, path: p.dir, clickTarget: "cursor", registeredAt: new Date().toISOString() })) }, null, 2)
);

const child = spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), [".", `--remote-debugging-port=${CDP_PORT}`], {
  cwd: ROOT,
  env: {
    ...process.env,
    TERMINAL_APP_DATA_DIR: dataDir,
    TERMINAL_APP_SESSIONS_DIR: sessionsDir,
    TERMINAL_APP_LIVENESS_INTERVAL_MS: String(SWEEP_MS),
    TERMINAL_APP_CONCLUDED_MIN_AGE_MS: "500",
  },
  stdio: "ignore",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "OK " : "NG "} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (期待 ${JSON.stringify(expected)})`}`);
  if (!ok) failures.push(label);
}

async function getPageTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const page = list.find((t) => t.type === "page" && String(t.url).includes("index.html"));
      if (page) return page;
    } catch {
      /* 起動待ち */
    }
    await sleep(500);
  }
  throw new Error("CDP の page ターゲットが見つかりません（起動失敗？）");
}

const target = await getPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", reject);
});
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`renderer で例外: ${r.exceptionDetails.text}`);
  return r.result.value;
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(outDir, name), Buffer.from(r.data, "base64"));
}
const transcriptOf = (k) => path.join(dataDir, `${k}.jsonl`);
async function inject(key, event) {
  const res = await fetch(`http://127.0.0.1:${EVENT_PORT}/terminal-app/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: projDir(key), session_id: S[key], transcript_path: transcriptOf(key), ...event }),
  });
  return res.status;
}
/** 擬似 transcript: open = プロンプト直後（ターン進行中）、concluded = 応答完了（stop_hook_summary + turn_duration） */
function writeTranscript(k, end) {
  const lines = [{ type: "user", message: { role: "user", content: "x" } }];
  if (end === "concluded") {
    lines.push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
    lines.push({ type: "system", subtype: "stop_hook_summary", preventedContinuation: false, timestamp: new Date().toISOString() });
    lines.push({ type: "system", subtype: "turn_duration", durationMs: 1000 });
  }
  fs.writeFileSync(transcriptOf(k), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
/** snapshot の state / loopText / workText と、描画されたバッジ（.tile-loop）の文字列・表示有無 */
async function view() {
  return evaluate(`window.terminalApp.getSnapshot().then(s => ({
    a: s.sessions['p-a']?.loopText ?? null,
    b: s.sessions['p-b']?.loopText ?? null,
    c: s.sessions['p-c']?.loopText ?? null,
    state: { a: s.sessions['p-a']?.state ?? null, b: s.sessions['p-b']?.state ?? null, c: s.sessions['p-c']?.state ?? null },
    work: { a: s.sessions['p-a']?.workText ?? null, c: s.sessions['p-c']?.workText ?? null },
    dom: Object.fromEntries([...document.querySelectorAll('.tile')].map(t => [t.dataset.id, {
      loop: t.querySelector('.tile-loop').hidden ? null : t.querySelector('.tile-loop').textContent,
      row: !t.querySelector('.tile-badge-row').hidden,
    }])),
  }))`);
}
const logFile = () => {
  const dir = path.join(dataDir, "logs");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".log")) : [];
  return files.length > 0 ? fs.readFileSync(path.join(dir, files[0]), "utf8") : "";
};
const TASK_NOTIFICATION = '<task-notification>\n<task-id>bnompbcuf</task-id>\n<summary>Monitor event: "実行係 codex の進捗 (iter 000)"</summary>\n<event>...</event>\n</task-notification>';

try {
  await sleep(1200);
  for (const k of ["a", "b", "c"]) {
    writeTranscript(k, "open");
    check(`注入 UserPromptSubmit（${k}）`, await inject(k, { hook_event_name: "UserPromptSubmit", prompt: `ループ ${k}` }), 204);
  }
  await sleep(SWEEP_MS + 1500);
  await shot("01-badges.png");
  let v = await view();
  check("(a) sessions 配置のループ: 2 周目・codex 実装中 0 分・最高 78 点", v.a, "ループ 2/4・codex 実装中 0分・最高 78点");
  check("(b) agents 配置（fork）のループ: session_id で対応付き 採点中", v.b, "ループ 1/4・採点中");
  check("(c)(h) ループの無いセッション（task 未設定の残骸 3 つだけ）にはバッジ無し", v.c, null);
  check("描画: a/b はバッジ表示・c は行ごと非表示", v.dom, {
    "p-a": { loop: "ループ 2/4・codex 実装中 0分・最高 78点", row: true },
    "p-b": { loop: "ループ 1/4・採点中", row: true },
    "p-c": { loop: null, row: false },
  });
  check("ログ: バッジ出現の記録", logFile().includes(`ループ進捗バッジ 表示: loop-a (session=${S.a}) — ループ 2/4・codex 実装中 0分・最高 78点`), true);
  check("ログ: 作業継続中として保持（ループ進行中）", logFile().includes(`作業継続中として保持: loop-a (session=${S.a}) — ループ進行中（ループ 2/4・codex 実装中 0分・最高 78点）`), true);

  // (f) ループ進行中の Stop / 入力待ち Notification は実行中を維持。許可要求は確認待ち
  writeTranscript("a", "concluded");
  check("(f) 注入 Stop（a）", await inject("a", { hook_event_name: "Stop" }), 204);
  await sleep(4500); // Stop 後の前倒し判定（3.5 秒）を跨ぐ
  v = await view();
  check("(f) ループ進行中の Stop → 実行中のまま（登録簿 idle でも）", v.state.a, "running");
  check("ログ: Stop を実行中維持で受けた記録", logFile().includes(`event 受信: Stop → running（実行中を維持: ループ進行中（ループ 2/4・codex 実装中 0分・最高 78点）） (project=p-a, session=${S.a})`), true);
  check("(f) 注入 Notification idle_prompt（a。文言は permission 風でも種別を優先）", await inject("a", { hook_event_name: "Notification", message: "permission?", notification_type: "idle_prompt" }), 204);
  await sleep(SWEEP_MS + 500);
  check("(f) ループ進行中の入力待ち通知 → 確認待ちにならない", (await view()).state.a, "running");
  check("ログ: 種別に notification_type を併記", logFile().includes("Notification 種別=idle(idle_prompt) → running"), true);
  check("(f) 注入 Notification agent_needs_input（a）", await inject("a", { hook_event_name: "Notification", message: "Claude is waiting for your input", notification_type: "agent_needs_input" }), 204);
  await sleep(300);
  check("(f) 人の応答が要る種別はループ中でも確認待ち", (await view()).state.a, "confirm");
  await sleep(SWEEP_MS + 500);
  check("(f) 許可要求の確認待ちは掃引でも戻らない（人の応答待ち）", (await view()).state.a, "confirm");
  writeTranscript("a", "open");
  check("(f) 注入 UserPromptSubmit（a・人のプロンプト）", await inject("a", { hook_event_name: "UserPromptSubmit", prompt: "続けて" }), 204);
  await shot("02-held.png");

  // (d) 進捗ログに PHASE_END = codex ジョブが終わった → phase 表示へ
  fs.appendFileSync(progressA, "[17:20:00 +12m00s] generator#001 PHASE_END rc=0\n");
  await sleep(SWEEP_MS + 1000);
  check("(d) PHASE_END で codex 表示が消え phase 表示へ", (await view()).a, "ループ 2/4・実装中・最高 78点");

  // (e) 終了: a は合格 92 点（今）、b は 31 分前に上限到達 → 期限切れで消える。終了後の Stop は完了になる
  writeState(stateA, { active: false, iteration: 1, max_iterations: 4, threshold: 90, phase: "eval", latest_score: 92, best_score: 92, ended_reason: "threshold_met", session_id: S.a });
  writeState(stateB, { active: false, iteration: 3, max_iterations: 4, phase: "eval", best_score: 70, ended_reason: "max_iterations", session_id: S.b, agent_id: AGENT }, 31 * 60_000);
  await sleep(SWEEP_MS + 1000);
  await shot("03-ended.png");
  v = await view();
  check("(e) 終了直後: ループ終了・合格 92点", v.a, "ループ終了・合格 92点");
  check("(e) 31 分前に終わった fork ループのバッジは消える", v.b, null);
  check("(e) 描画: b の行は非表示に戻る", v.dom["p-b"], { loop: null, row: false });
  check("ログ: バッジ消滅の記録", logFile().includes(`ループ進捗バッジ 消滅: loop-b (session=${S.b})`), true);
  writeTranscript("a", "concluded");
  check("(e) 注入 Stop（a・ループ終了後）", await inject("a", { hook_event_name: "Stop" }), 204);
  await sleep(4500);
  check("(e) ループ終了後の Stop → 完了", (await view()).state.a, "done");

  // (h) 残骸 state だけのセッション c: 人のプロンプト後の Stop は従来どおり完了になる（残骸で保持されない）
  writeTranscript("c", "concluded");
  check("(h) 注入 Stop（c・残骸 state 3 つあり）", await inject("c", { hook_event_name: "Stop" }), 204);
  await sleep(4500);
  check("(h) task 未設定の残骸では保持されず完了になる", (await view()).state.c, "done");
  check("ログ: 残骸（ループ 1/12）で保持された記録は無い", logFile().includes("実行中を維持: ループ進行中（ループ 1/12"), false);
  writeTranscript("c", "open");
  check("(h) 注入 UserPromptSubmit（c）", await inject("c", { hook_event_name: "UserPromptSubmit", prompt: "ループ c" }), 204);
  await sleep(300);

  // (g) バックグラウンド作業の完了待ち（c: 登録簿 status=shell）
  check("(g) 注入 UserPromptSubmit（c・task-notification）", await inject("c", { hook_event_name: "UserPromptSubmit", prompt: TASK_NOTIFICATION }), 204);
  await sleep(300);
  v = await view();
  check("(g) task-notification で起床しても作業テキストは人の依頼文のまま", v.work.c, "ループ c");
  writeTranscript("c", "concluded");
  check("(g) 注入 Stop（c）", await inject("c", { hook_event_name: "Stop" }), 204);
  await sleep(4500);
  check("(g) 登録簿 status=shell の間は Stop でも実行中", (await view()).state.c, "running");
  check("ログ: バックグラウンド作業の完了待ちで維持した記録", logFile().includes(`event 受信: Stop → running（実行中を維持: バックグラウンド作業の完了待ち（登録簿 status=shell）） (project=p-c, session=${S.c})`), true);
  writeRegistry("c", "idle");
  await sleep(SWEEP_MS * 2 + 1000);
  await shot("04-released.png");
  check("(g) status=idle になったら掃引の終了検知で完了", (await view()).state.c, "done");
  check("ログ: 保持の解除と終了検知", logFile().includes(`保持を解除: loop-c (session=${S.c})`) && logFile().includes(`終了検知: loop-c (session=${S.c})`), true);

  fs.writeFileSync(path.join(outDir, "app.log"), logFile());
  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify({ failures, sessions: S, agent: AGENT, sweepMs: SWEEP_MS, at: new Date().toISOString() }, null, 2));
} finally {
  try {
    await Promise.race([send("Browser.close"), sleep(1000)]);
  } catch {
    /* 既に閉じている */
  }
  ws.close();
  await sleep(500);
  if (child.exitCode === null) child.kill();
  for (const p of projects) fs.rmSync(p.dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`NG: ${failures.length} 件の不一致`);
  process.exit(1);
}
console.log(`すべて期待どおり（出力: ${outDir}）`);
