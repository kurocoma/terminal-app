/* global fetch, WebSocket, clearTimeout */
/**
 * Codex の SQLite 履歴から実 Electron のタイルまでを検証する。
 * 専用 dataDir・Codex DB・Claude 登録簿・プロジェクトを一時ディレクトリに作る。
 * 実ユーザーの履歴や認証情報を使わず、Jev も呼び出さない。
 * 実行: npm run build 後に node scripts/verify-codex-e2e.mjs [出力先]
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROJECT_ID = "p-codex-e2e";
const CODEX_THREAD = "00000000-c0de-4000-8000-000000000001";
const CODEX_SID = `codex:${CODEX_THREAD}`;
const SECOND_CODEX_THREAD = "00000000-c0de-4000-8000-000000000002";
const SECOND_CODEX_SID = `codex:${SECOND_CODEX_THREAD}`;
const CLAUDE_SID = "00000000-c1a0-4000-8000-000000000001";
const GHOST_SID = "00000000-dead-4000-8000-000000000001";
const SWEEP_MS = 1500;
const POLL_MS = 300;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-codex-e2e-"));
const projectDir = path.join(dataDir, "fixture-project");
const codexDir = path.join(dataDir, ".codex");
const codexLocksDir = path.join(codexDir, "thread-writer-locks");
const registryDir = path.join(dataDir, ".claude", "sessions");
const claudeRegistryFile = path.join(registryDir, `${process.pid}.json`);
const loopDir = path.join(dataDir, ".claude", "eval-loop");
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : dataDir;
for (const dir of [projectDir, codexDir, codexLocksDir, registryDir, loopDir, outDir]) fs.mkdirSync(dir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
const eventPort = await freePort();
let cdpPort;

const stateDb = new DatabaseSync(path.join(codexDir, "state_5.sqlite"));
const historyDb = new DatabaseSync(path.join(codexDir, "thread_history_1.sqlite"));
stateDb.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE threads (
    id TEXT PRIMARY KEY, cwd TEXT, source TEXT, archived INTEGER,
    created_at INTEGER, updated_at INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER,
    name TEXT, title TEXT
  );
`);
historyDb.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE thread_turns (
    thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT,
    started_at INTEGER, completed_at INTEGER
  );
  CREATE TABLE thread_items (
    thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER, item_type TEXT, item_json TEXT
  );
`);
function addThread(threadId, name) {
  const now = Date.now();
  stateDb.prepare("INSERT INTO threads VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)")
    .run(threadId, path.toNamespacedPath(projectDir), "cli", Math.floor(now / 1000), Math.floor(now / 1000), now, now, name, `${name} task`);
}
addThread(CODEX_THREAD, "Codex fixture");

function touchThread(threadId = CODEX_THREAD) {
  const now = Date.now();
  stateDb.prepare("UPDATE threads SET updated_at = ?, updated_at_ms = ? WHERE id = ?")
    .run(Math.floor(now / 1000), now, threadId);
}
function addItem(turnId, itemId, ordinal, type, data, threadId = CODEX_THREAD) {
  historyDb.prepare("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?)")
    .run(threadId, turnId, itemId, ordinal, type, JSON.stringify(data));
  touchThread(threadId);
}
function addTurn(turnId, ordinal, prompt, threadId = CODEX_THREAD) {
  historyDb.prepare("INSERT INTO thread_turns VALUES (?, ?, ?, 'inProgress', ?, NULL)")
    .run(threadId, turnId, ordinal, Math.floor(Date.now() / 1000));
  addItem(turnId, `${turnId}-user`, 1, "userMessage", { type: "userMessage", content: [{ type: "text", text: prompt }] }, threadId);
}
addTurn("turn-1", 1, "Codex fixture first task");

fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({
  version: 1, port: eventPort, theme: "dark", alwaysOnTopDefault: false,
  notifySound: { enabled: false }, customStatuses: [], showUnlinked: false, monitorCodex: true,
}, null, 2));
fs.writeFileSync(path.join(dataDir, "projects.json"), JSON.stringify({
  version: 1, projects: [{ id: PROJECT_ID, name: "Codex fixture", path: projectDir, clickTarget: "cursor", registeredAt: new Date().toISOString() }],
}, null, 2));
fs.writeFileSync(claudeRegistryFile, JSON.stringify({
  pid: process.pid, sessionId: CLAUDE_SID, cwd: projectDir, kind: "interactive", entrypoint: "cli", status: "busy",
}));
const transcript = path.join(dataDir, "claude-fixture.jsonl");
fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "Claude fixture task" } }) + "\n");

const checks = [];
const checkpoints = [];
function check(label, actual, expected) {
  const passed = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ label, passed, actual, expected });
  console.log(`${passed ? "OK" : "NG"}: ${label}`);
  if (!passed) throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

// Codex 本体と同じ形式のロックを、検証専用の別プロセスで保持する。
const codexHolders = new Map();
async function startCodexHolder(threadId) {
  if (codexHolders.has(threadId)) throw new Error("Codex fixture のロックが既に起動しています");
  const lockFile = path.join(codexLocksDir, `${threadId}.lock`);
  if (!fs.existsSync(lockFile)) fs.writeFileSync(lockFile, "");
  const holder = spawn(process.execPath, [path.join(ROOT, "scripts", "fixtures", "codex-lock-holder.cjs"), lockFile], {
    cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  codexHolders.set(threadId, holder);
  holder.stdin.on("error", () => { /* 終了済みプロセスの EPIPE は exit で判定する */ });
  let stderr = "";
  holder.stderr.setEncoding("utf8");
  holder.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  await new Promise((resolve, reject) => {
    let output = "";
    const cleanup = () => {
      clearTimeout(timer);
      holder.removeListener("error", onError);
      holder.removeListener("exit", onExit);
      holder.stdout.removeListener("data", onData);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onExit = (code) => { cleanup(); reject(new Error(`Codex fixture のロック取得前に終了しました: ${code} ${stderr}`)); };
    const onData = (chunk) => {
      output += chunk;
      if (!output.split(/\r?\n/).includes("ready")) return;
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Codex fixture のロック取得が完了しません")); }, 10_000);
    holder.once("error", onError);
    holder.once("exit", onExit);
    holder.stdout.setEncoding("utf8");
    holder.stdout.on("data", onData);
  });
}

async function stopCodexHolder(threadId) {
  const holder = codexHolders.get(threadId);
  if (!holder) return;
  if (holder.exitCode !== null || holder.signalCode !== null) {
    codexHolders.delete(threadId);
    return;
  }
  const exited = new Promise((resolve) => holder.once("exit", () => resolve(true)));
  holder.stdin.end();
  if (!await Promise.race([exited, sleep(3000).then(() => false)])) {
    holder.kill();
    await Promise.race([exited, sleep(1000)]);
    throw new Error("Codex fixture のロックを正常に解放できませんでした");
  }
  codexHolders.delete(threadId);
}

let child;
let cdp;
const launches = [];
let activeLaunch;
async function launch() {
  // 終了直後の Chromium が前の CDP ポートを解放するまで待たずに再利用しない。
  const previousPort = cdpPort;
  do { cdpPort = await freePort(); } while (cdpPort === eventPort || cdpPort === previousPort);
  const env = {
    ...process.env,
    TERMINAL_APP_DATA_DIR: dataDir,
    TERMINAL_APP_CODEX_HOME: codexDir,
    TERMINAL_APP_CODEX_POLL_MS: String(POLL_MS),
    TERMINAL_APP_SESSIONS_DIR: registryDir,
    TERMINAL_APP_EVAL_LOOP_DIR: loopDir,
    TERMINAL_APP_LIVENESS_INTERVAL_MS: String(SWEEP_MS),
    TERMINAL_APP_JEV: "off",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const diagnostic = { attempt: launches.length + 1, cdpPort, stderrFile: `electron-${launches.length + 1}.stderr.log`, stderrTail: "" };
  activeLaunch = diagnostic;
  launches.push(diagnostic);
  const stderrPath = path.join(outDir, diagnostic.stderrFile);
  fs.writeFileSync(stderrPath, "");
  child = spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), [".", `--remote-debugging-port=${cdpPort}`], {
    cwd: ROOT, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
  });
  diagnostic.pid = child.pid;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    fs.appendFileSync(stderrPath, chunk);
    diagnostic.stderrTail = (diagnostic.stderrTail + chunk).slice(-4000);
  });
  child.on("error", (error) => { diagnostic.spawnError = error.message; });
  child.on("exit", (code, signal) => { diagnostic.exitCode = code; diagnostic.signal = signal; });
}

async function connect() {
  let page;
  let lastProbe = "未接続";
  for (let i = 0; i < 60 && !page; i++) {
    if (activeLaunch.spawnError) throw new Error(`Electron 起動失敗: ${activeLaunch.spawnError}`);
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Electron が終了しました: ${child.exitCode ?? child.signalCode}\n${activeLaunch.stderrTail}`);
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const list = await response.json();
      lastProbe = `targets=${list.length}, pages=${list.filter((target) => target.type === "page").length}`;
      page = list.find((target) => target.type === "page" && String(target.url).includes("index.html"));
    } catch (error) { lastProbe = error instanceof Error ? error.message : String(error); }
    if (!page) await sleep(250);
  }
  if (!page) throw new Error(`CDP の page ターゲットが見つかりません（port=${cdpPort}, ${lastProbe}）\n${activeLaunch.stderrTail}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const response = JSON.parse(data);
    const waiting = pending.get(response.id);
    if (!waiting) return;
    pending.delete(response.id);
    clearTimeout(waiting.timer);
    if (response.error) waiting.reject(new Error(JSON.stringify(response.error)));
    else waiting.resolve(response.result);
  });
  ws.addEventListener("close", () => {
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error("CDP 接続が閉じました"));
    }
    pending.clear();
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 応答待ち時間超過: ${method}`));
    }, 10_000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const connection = {
    ws, send,
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(`renderer で例外: ${result.exceptionDetails.text}`);
      return result.result.value;
    },
    async shot(name) {
      const result = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(outDir, name), Buffer.from(result.data, "base64"));
    },
  };
  // 起動直後の page はまだ file:// への遷移中の場合がある。
  for (let i = 0; i < 40; i++) {
    try {
      if (await connection.evaluate("document.readyState === 'complete' && typeof window.terminalApp?.getSnapshot === 'function'")) return connection;
    } catch (error) {
      if (!String(error).includes("Execution context was destroyed") && !String(error).includes("Cannot find context")) throw error;
    }
    await sleep(100);
  }
  ws.close();
  throw new Error("renderer の読み込みが完了しません");
}

async function stop() {
  if (cdp) {
    try { await Promise.race([cdp.send("Browser.close"), sleep(1000)]); } catch { /* 終了時は接続も閉じる */ }
    cdp.ws.close();
    cdp = undefined;
  }
  if (child && child.exitCode === null) {
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(1500)]);
    if (child.exitCode === null) child.kill();
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(1000)]);
  }
}

async function view() {
  return cdp.evaluate(`(async () => {
    const snapshot = await window.terminalApp.getSnapshot();
    const sessions = snapshot.splitSessions[${JSON.stringify(PROJECT_ID)}]
      ?? [snapshot.sessions[${JSON.stringify(PROJECT_ID)}]].filter(Boolean);
    return {
      presence: snapshot.windowPresence[${JSON.stringify(PROJECT_ID)}],
      showUnlinked: snapshot.config.showUnlinked,
      splitCount: snapshot.splitSessions[${JSON.stringify(PROJECT_ID)}]?.length ?? 0,
      sessions: sessions.map(s => ({ sessionId: s.sessionId, provider: s.provider ?? 'claude', state: s.state,
        workText: s.workText, confirmKind: s.confirmKind, runningSince: s.runningSince,
        terminalClosed: s.terminalClosed === true })),
      counts: snapshot.counts,
      tiles: [...document.querySelectorAll('.tile')].map(tile => ({
        sessionId: tile.dataset.sessionId,
        classes: tile.className,
        hidden: tile.hidden,
        provider: tile.querySelector('.tile-provider').hidden ? '' : tile.querySelector('.tile-provider').textContent,
        status: tile.querySelector('.tile-status').textContent,
      })),
    };
  })()`);
}
async function waitFor(label, predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await view();
    if (predicate(latest)) return latest;
    await sleep(150);
  }
  throw new Error(`${label} の待機時間超過: ${JSON.stringify(latest)}`);
}
const codex = (snapshot) => snapshot.sessions.find((session) => session.sessionId === CODEX_SID);
const codexTile = (snapshot) => snapshot.tiles.find((tile) => tile.provider === "Codex");
function checkpoint(name, snapshot) { checkpoints.push({ name, ...snapshot }); }
async function post(event) {
  const response = await fetch(`http://127.0.0.1:${eventPort}/terminal-app/event`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: projectDir, transcript_path: transcript, ...event }),
  });
  check(`hook ${event.session_id === GHOST_SID ? "ghost" : "Claude"} の受信`, response.status, 204);
}
const appLog = () => fs.readFileSync(path.join(dataDir, "logs", "app.log"), "utf8");

let error;
try {
  await startCodexHolder(CODEX_THREAD);
  await launch();
  cdp = await connect();
  let current = await waitFor("Codex 実行中", (s) => codex(s)?.state === "running" && codexTile(s)?.classes.includes("state-running"));
  check("Codex DB の実行中を表示", codex(current).provider, "codex");
  check("Codex の最新ユーザー依頼を表示", codex(current).workText, "Codex fixture first task");
  check("Codex ラベル付きタイルを表示", codexTile(current).hidden, false);
  checkpoint("running", current);

  historyDb.prepare("UPDATE thread_turns SET status = 'completed', completed_at = ? WHERE thread_id = ? AND turn_id = 'turn-1'")
    .run(Math.floor(Date.now() / 1000), CODEX_THREAD);
  touchThread();
  current = await waitFor("Codex 完了", (s) => codex(s)?.state === "done" && codexTile(s)?.classes.includes("state-done") && s.presence === false);
  check("未接続を隠す設定でも Codex 完了を表示", [current.showUnlinked, codexTile(current).hidden], [false, false]);
  check("Cursor が無くても Codex 完了を灰色化しない", codexTile(current).classes.includes("is-unlinked"), false);
  await sleep(POLL_MS * 2 + 150);
  current = await view();
  check("応答完了後もロックがある Codex は開いている入力待ちとして残る", [codex(current)?.state, codex(current)?.terminalClosed], ["done", false]);
  checkpoint("completed", current);
  await cdp.shot("01-codex-completed.png");

  addTurn("turn-2", 2, "Codex fixture next task");
  current = await waitFor("Codex 新しいターン", (s) => codex(s)?.state === "running" && codex(s)?.workText === "Codex fixture next task");
  check("新しいターンで完了から実行中に戻る", codex(current).state, "running");
  checkpoint("next-turn", current);

  await post({ hook_event_name: "UserPromptSubmit", session_id: CLAUDE_SID, prompt: "Claude fixture task" });
  current = await waitFor("Claude と Codex の分割", (s) => s.sessions.length === 2 && s.tiles.length === 2);
  check("同じ cwd の Claude と Codex を分割表示", current.sessions.map((s) => s.provider).sort(), ["claude", "codex"]);
  check("Claude のラベル表示は変えない", current.tiles.find((tile) => tile.sessionId === CLAUDE_SID)?.provider, "");
  check("分割タイルをセッション数に反映", current.counts.total, 2);
  checkpoint("mixed-split", current);
  await cdp.shot("02-claude-codex-split.png");

  await post({ hook_event_name: "UserPromptSubmit", session_id: GHOST_SID, prompt: "Ghost fixture task" });
  await waitFor("掃引対象 Claude の取り込み", (s) => s.sessions.some((session) => session.sessionId === GHOST_SID));
  current = await waitFor("Claude の 2 回掃引", (s) =>
    !s.sessions.some((session) => session.sessionId === GHOST_SID)
    && appLog().includes(`セッション終了を確認（登録簿にプロセスなし）: session=${GHOST_SID}`));
  check("Claude 掃引後も Codex の実行中が残る", codex(current)?.state, "running");
  check("Codex を Claude 登録簿の終了判定にかけない", appLog().includes(`セッション終了を確認（登録簿にプロセスなし）: session=${CODEX_SID}`), false);
  checkpoint("after-two-sweeps", current);

  addItem("turn-2", "question-1", 2, "agentMessage", {
    type: "agentMessage", questions: [{ title: "どちらの手順で進めますか", options: null }],
  });
  current = await waitFor("Codex 質問待ち", (s) => codex(s)?.state === "confirm" && codexTile(s)?.status.includes("返答待ち"));
  check("Codex の質問を返答待ちで表示", codex(current).confirmKind, "question");
  check("返答待ちの Codex を先頭に表示", current.tiles[0].provider, "Codex");
  checkpoint("question", current);
  await cdp.shot("03-codex-question.png");

  await stop();
  await launch();
  cdp = await connect();
  current = await waitFor("再起動後の Codex 復元", (s) => codex(s)?.state === "confirm" && codexTile(s)?.status.includes("返答待ち"));
  check("再起動後も同じ Codex セッションを表示", codex(current).sessionId, CODEX_SID);
  check("再起動後も質問待ちを復元", codex(current).confirmKind, "question");
  checkpoint("restarted", current);
  await cdp.shot("04-codex-restarted.png");

  // 質問へ回答し、Codex を入力待ちにしたまま開存数を増減させる。
  addItem("turn-2", "question-answer", 3, "userMessage", {
    type: "userMessage", content: [{ type: "text", text: "Codex fixture answer" }],
  });
  historyDb.prepare("UPDATE thread_turns SET status = 'completed', completed_at = ? WHERE thread_id = ? AND turn_id = 'turn-2'")
    .run(Math.floor(Date.now() / 1000), CODEX_THREAD);
  touchThread();
  current = await waitFor("開いたままの Codex 入力待ち", (s) => codex(s)?.state === "done" && !codex(s)?.terminalClosed && s.sessions.length === 2);
  check("Codex のターン完了だけでは分割タイルを減らさない", current.splitCount, 2);

  await startCodexHolder(SECOND_CODEX_THREAD);
  addThread(SECOND_CODEX_THREAD, "Second Codex fixture");
  addTurn("second-turn-1", 1, "Second Codex fixture task", SECOND_CODEX_THREAD);
  current = await waitFor("Claude と Codex 2 本の分割", (s) => s.sessions.length === 3 && s.tiles.length === 3 && s.splitCount === 3);
  check("開いている Claude 1 本と Codex 2 本をそれぞれ表示", current.sessions.map((s) => s.sessionId).sort(), [CLAUDE_SID, CODEX_SID, SECOND_CODEX_SID].sort());
  check("Codex 2 本のうち入力待ちも開いたタイルとして数える", [codex(current).state, codex(current).terminalClosed, current.counts.total], ["done", false, 3]);
  checkpoint("three-open-terminals", current);
  await cdp.shot("05-three-open-terminals.png");

  await stopCodexHolder(SECOND_CODEX_THREAD);
  await sleep(POLL_MS * 2 + 150);
  current = await waitFor("Codex 1 本を閉じた後の分割縮小", (s) => s.sessions.length === 2 && s.tiles.length === 2 && !s.sessions.some((session) => session.sessionId === SECOND_CODEX_SID));
  check("DB が実行中のままでも閉じた Codex を分割から外す", historyDb.prepare("SELECT status FROM thread_turns WHERE thread_id = ?").get(SECOND_CODEX_THREAD).status, "inProgress");
  check("Codex 1 本を閉じると 3 枚から 2 枚へ減る", [current.splitCount, current.counts.total], [2, 2]);
  checkpoint("second-codex-closed", current);

  fs.unlinkSync(claudeRegistryFile);
  current = await waitFor("最後の Claude を閉じた後の分割解除", (s) => s.sessions.length === 1 && s.tiles.length === 1 && s.sessions[0].sessionId === CODEX_SID && s.splitCount === 0);
  check("終了済み Claude 履歴を開いている Codex と分割しない", [current.counts.total, codex(current).terminalClosed], [1, false]);
  check("1 本へ戻ると分割の番号と装飾が外れる", current.tiles[0].classes.includes("is-split"), false);
  checkpoint("only-one-codex-open", current);
  await cdp.shot("06-only-one-codex-open.png");

  // 最後に使用した会話を明示してから閉じる。履歴を消したり状態を偽装せずロック解放だけで判定する。
  touchThread();
  await sleep(POLL_MS * 2 + 150);
  await stopCodexHolder(CODEX_THREAD);
  await sleep(POLL_MS * 2 + 150);
  current = await waitFor("全ターミナル終了後の履歴 1 枚", (s) => s.sessions.length === 1 && s.tiles.length === 1 && s.splitCount === 0 && s.sessions[0].sessionId === CODEX_SID && s.sessions[0].terminalClosed);
  check("最後の Codex を閉じても分割せず完了履歴を 1 枚残す", [current.counts.total, codex(current).state, codex(current).terminalClosed], [1, "done", true]);
  checkpoint("all-terminals-closed", current);

  await startCodexHolder(CODEX_THREAD);
  current = await waitFor("同じ Codex 会話を開き直した後の生存復帰", (s) => s.sessions.length === 1 && s.tiles.length === 1 && s.splitCount === 0 && codex(s)?.terminalClosed === false);
  check("DB に新しいターンが無くてもロック再取得で終了印を外す", [codex(current).sessionId, codex(current).state, codex(current).terminalClosed], [CODEX_SID, "done", false]);
  checkpoint("same-thread-reopened", current);
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught);
  console.error(`NG: ${error}`);
  if (cdp) {
    try { await cdp.shot("failure.png"); } catch { /* 接続が失われていても結果を保存する */ }
  }
} finally {
  await stop();
  const holderStops = await Promise.allSettled([...codexHolders.keys()].map(stopCodexHolder));
  for (const result of holderStops) {
    if (result.status === "rejected") error ??= String(result.reason);
  }
  stateDb.close();
  historyDb.close();
  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify({
    at: new Date().toISOString(), passed: !error && checks.every((item) => item.passed),
    checks, checkpoints, error, sweepMs: SWEEP_MS, codexPollMs: POLL_MS, eventPort, launches,
  }, null, 2));
}
console.log(`結果: ${path.join(outDir, "result.json")}`);
process.exitCode = error ? 1 : 0;
