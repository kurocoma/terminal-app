/* global fetch, AbortSignal, clearTimeout */
/**
 * 自己診断（260927_1）: 「直近の動作が問題なく行われているか」を 1 コマンドで確かめる。
 *
 *   npm run diagnose            … 直近 6 時間を診断して結果を表示
 *   npm run diagnose -- 24      … 直近 24 時間
 *   node scripts/diagnose.mjs 6 docs/evidence/diag.json  … JSON も保存
 *
 * 見るもの:
 *   1. 環境    ビルドの新しさ・設定・登録プロジェクト
 *   2. 受信経路 受信サーバの応答・hooks の設定状況
 *   3. 外部依存 Jev（実際に 1 回聞いて応答時間を測る）・claude CLI
 *   4. データ源 Claude Code の登録簿・transcript
 *   5. 直近の動作 app.log の集計・状態の往復（flip-flop）・警告
 *   6. 表示の整合 sessions.json の状態 vs 実データ
 *
 * 実データは読むだけ。受信サーバへの疎通だけ POST するが、架空の session_id と
 * 未登録の cwd を使うので表示は変わらない（未登録 cwd は破棄される）。
 * 終了コード: 0 = 問題なし / 1 = 要確認（NG あり）
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

function load(name) {
  try {
    return require(path.join(ROOT, "dist", "main", name));
  } catch {
    return null;
  }
}
const diag = load("diagnose.js");
if (diag === null) {
  console.error("NG: dist が見つかりません。先に npm run build を実行してください");
  process.exit(1);
}
const scan = load("session-scan.js");
const registry = load("session-registry.js");
const jevClient = load("jev-client.js");
const jevJudge = load("jev-judge.js");
const snapshot = load("session-snapshot.js");

const hours = Number(process.argv[2] ?? 6);
const windowMs = (Number.isFinite(hours) && hours > 0 ? hours : 6) * 60 * 60_000;
const outJson = process.argv[3];
const now = Date.now();
const dataDir = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "terminal-app");
const checks = [];
const add = (name, level, detail) => checks.push({ name, level, detail });
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const mtime = (p) => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
};
const ago = (ms) => {
  const m = Math.round((now - ms) / 60000);
  return m < 1 ? "たった今" : m < 60 ? `${m}分前` : `${Math.round(m / 60)}時間前`;
};

/* ---------- 1. 環境 ---------- */
const newestSrc = (() => {
  let newest = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|css|html)$/.test(e.name)) newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  walk(path.join(ROOT, "src"));
  return newest;
})();
const builtAt = mtime(path.join(ROOT, "dist", "main", "index.js"));
if (builtAt === null) add("ビルド", "ng", "dist が無い（npm run build）");
else if (builtAt < newestSrc) add("ビルド", "warn", `src の方が新しい（${ago(newestSrc)} に編集・ビルドは ${ago(builtAt)}）。再ビルドが要る`);
else add("ビルド", "ok", `dist は最新（${ago(builtAt)}）`);

const config = readJson(path.join(dataDir, "config.json"));
const projectsFile = readJson(path.join(dataDir, "projects.json"));
const projects = projectsFile?.projects ?? [];
if (config === null || projects.length === 0) add("設定", "ng", `config.json / projects.json を読めない（${dataDir}）`);
else add("設定", "ok", `登録 ${projects.length} 件・ポート ${config.port}・Jev 自動リネーム ${config.autoRename === false ? "off" : "on"}`);

/* ---------- 2. 受信経路 ---------- */
if (config !== null) {
  const url = `http://127.0.0.1:${config.port}/terminal-app/event`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 架空セッション＋未登録 cwd（対応するプロジェクトが無いので破棄される＝表示は変わらない）
      body: JSON.stringify({ hook_event_name: "Stop", session_id: "00000000-diag-4000-8000-000000000001", cwd: path.join(os.tmpdir(), "terminal-app-diagnose") }),
      signal: AbortSignal.timeout(3000),
    });
    add("受信サーバ", res.ok ? "ok" : "warn", `ポート ${config.port} が応答（HTTP ${res.status}）`);
  } catch (e) {
    add("受信サーバ", "ng", `ポート ${config.port} が応答しない（アプリが起動していない？）: ${String(e).slice(0, 60)}`);
  }
}

const hookMissing = [];
for (const p of projects) {
  const s = readJson(path.join(p.path, ".claude", "settings.json"));
  const text = s === null ? "" : JSON.stringify(s.hooks ?? {});
  const has = (name) => text.includes(`"${name}"`) && text.includes("/terminal-app/event");
  const missing = ["Stop", "Notification", "UserPromptSubmit"].filter((n) => !has(n));
  if (missing.length > 0) hookMissing.push(`${p.name}(${missing.join(",")})`);
}
if (projects.length === 0) add("hooks", "skip", "登録プロジェクトなし");
else if (hookMissing.length === 0) add("hooks", "ok", `登録 ${projects.length} 件すべてに Stop / Notification / UserPromptSubmit が入っている`);
else add("hooks", "ng", `不足: ${hookMissing.slice(0, 5).join(" / ")}${hookMissing.length > 5 ? ` ほか${hookMissing.length - 5}件` : ""}`);

/* ---------- 3. 外部依存 ---------- */
const apiKey = jevClient?.loadTypesafeApiKey?.() ?? null;
if (jevClient === null) add("Jev", "skip", "モジュールを読めない");
else if (apiKey === null) add("Jev", "warn", "API キーが無い（判定は全部スキップされる）");
else {
  const client = jevClient.createJevClient({ apiKey });
  const t0 = Date.now();
  const answers = await client.judge("This message asks the user which option to choose.", jevJudge.pendingQuestionQuestions());
  const ms = Date.now() - t0;
  if (answers === null) add("Jev", "ng", `${ms}ms で応答なし（キー・ネットワークを確認）`);
  else {
    const v = jevJudge.interpretPendingQuestion(answers);
    add("Jev", ms > 3000 ? "warn" : "ok", `応答 ${ms}ms・判定可（asks_user=${(answers.asks_user?.noul ?? 0).toFixed(2)} / pending=${v?.pending}）`);
  }
}

const claudeVersion = await new Promise((resolve) => {
  const cmd = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
  const child = spawn(cmd, ["/d", "/s", "/c", "claude", "--version"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  const timer = setTimeout(() => {
    child.kill();
    resolve(null);
  }, 20_000);
  child.stdout.on("data", (d) => {
    out += d.toString("utf8");
  });
  child.on("error", () => {
    clearTimeout(timer);
    resolve(null);
  });
  child.on("close", () => {
    clearTimeout(timer);
    resolve(out.trim() || null);
  });
});
add("claude CLI", claudeVersion === null ? "warn" : "ok", claudeVersion === null ? "実行できない（表示名の AI 提案・自動リネームが使えない）" : `${claudeVersion.split("\n")[0]}`);

/* ---------- 4. データ源 ---------- */
const entries = registry?.readSessionRegistry?.() ?? null;
if (entries === null) add("登録簿", "ng", "~/.claude/sessions を読めない（生死判定ができない）");
else {
  const busy = entries.filter((e) => e.status === "busy").length;
  add("登録簿", entries.length === 0 ? "warn" : "ok", `${entries.length} 件（busy ${busy}）`);
}

let withTranscript = 0;
for (const p of projects) {
  const dir = scan?.transcriptDirFor?.(p.path);
  if (dir !== undefined && fs.existsSync(dir)) withTranscript += 1;
}
add("transcript", withTranscript === 0 ? "warn" : "ok", `${withTranscript}/${projects.length} プロジェクトに記録あり`);

/* ---------- 5. 直近の動作（app.log） ---------- */
const logPath = path.join(dataDir, "logs", "app.log");
let summary = null;
try {
  summary = diag.analyzeAppLog(fs.readFileSync(logPath, "utf8"), now, windowMs);
} catch {
  add("ログ", "ng", `app.log を読めない（${logPath}）`);
}
if (summary !== null) {
  const eventTotal = Object.values(summary.events).reduce((a, b) => a + b, 0);
  add("イベント受信", eventTotal === 0 ? "warn" : "ok", eventTotal === 0 ? `直近 ${hours} 時間で 0 件（hooks が動いていない可能性）` : diag.formatCounts(summary.events));
  const judgeTotal = Object.values(summary.judgments).reduce((a, b) => a + b, 0);
  add("Jev 判定", judgeTotal === 0 ? "warn" : "ok", judgeTotal === 0 ? `直近 ${hours} 時間で 0 件` : diag.formatCounts(summary.judgments));
  const flipTotal = summary.flipFlops.reduce((a, f) => a + f.count, 0);
  if (flipTotal === 0) add("状態の往復", "ok", "なし");
  else {
    const top = summary.flipFlops
      .slice(0, 3)
      .map((f) => `${f.session} ${f.count}回(${f.pattern})`)
      .join(" / ");
    add("状態の往復", flipTotal >= 10 ? "ng" : "warn", `${flipTotal} 回 — ${top}`);
  }
  if (summary.problems.length === 0) add("警告・エラー", "ok", `直近 ${hours} 時間で 0 件`);
  else add("警告・エラー", "warn", `${summary.problems.length} 件 — 最新: ${summary.problems[summary.problems.length - 1].text.slice(0, 90)}`);
}

/* ---------- 6. 表示の整合（sessions.json） ---------- */
const snapFile = snapshot?.loadSessionSnapshot?.(dataDir, now) ?? null;
const snapMtime = mtime(path.join(dataDir, "sessions.json"));
if (snapFile === null) add("表示の保存", "warn", "sessions.json が無い・古い・壊れている（再起動後の引き継ぎができない）");
else {
  add("表示の保存", now - snapFile.savedAt > 10 * 60_000 ? "warn" : "ok", `${snapFile.sessions.length} 件・保存 ${ago(snapMtime ?? snapFile.savedAt)}`);
  const nameOf = (id) => projects.find((p) => p.id === id)?.name ?? id;
  const findings = diag.checkSessionConsistency(snapFile.sessions, {
    now: () => now,
    liveness: (sid) => registry?.classifyLiveness?.(entries, sid) ?? "unknown",
    turnEnd: (p) => scan?.turnEndOf?.(p) ?? "unknown",
    subagentMtimeMs: (p) => scan?.subagentMtimeMs?.(p) ?? null,
    projectName: nameOf,
  });
  const ng = findings.filter((f) => f.level === "ng");
  if (findings.length === 0) add("表示と実データ", "ok", "食い違いなし");
  else {
    const text = findings
      .slice(0, 4)
      .map((f) => `${f.project}(${f.session}) ${f.text}`)
      .join(" / ");
    add("表示と実データ", ng.length > 0 ? "ng" : "warn", `${findings.length} 件 — ${text}`);
  }
}

/* ---------- 出力 ---------- */
console.log(`terminal-app 自己診断  ${new Date(now).toLocaleString("ja-JP")}  （直近 ${hours} 時間）`);
console.log("-".repeat(78));
for (const c of checks) console.log(diag.formatCheck(c));
console.log("-".repeat(78));
const level = diag.overallLevel(checks);
console.log(level === "ok" ? "総合: 問題なし" : level === "warn" ? "総合: 要注意（WARN あり）" : "総合: 要確認（NG あり）");

if (outJson !== undefined) {
  fs.mkdirSync(path.dirname(path.resolve(outJson)), { recursive: true });
  fs.writeFileSync(path.resolve(outJson), `${JSON.stringify({ at: new Date(now).toISOString(), hours, level, checks, summary }, null, 2)}\n`);
  console.log(`保存: ${path.resolve(outJson)}`);
}
process.exit(level === "ng" ? 1 : 0);
