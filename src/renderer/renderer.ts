/**
 * ③ UI（renderer）: タイルグリッド / 空状態 / 設定 / ステータスバー（design.md 6 章、モック面 1a〜1f）。
 * ES モジュールとしてビルドする（index.html で type="module" 読み込み）。表示整形の純関数は
 * ./format.ts に分離（単体テスト対象）。main とは preload の window.terminalApp 経由でのみ通信する。
 */
import { autoArrangeIds, confirmFirstIds, confirmLabel, confirmTilesFirst, fmtElapsed, fmtRelative, fmtStatusCounts, fmtUnlinkedLabel, isUnlinked, moveProjectId, projectConfirming, tileAlertText } from "./format.js";

type Api = Window["terminalApp"];
type Snapshot = Awaited<ReturnType<Api["getSnapshot"]>>;
type Project = Snapshot["projects"][number];
type SessionView = Snapshot["sessions"][string];
type SessionState = SessionView["state"];
type ThemeSetting = Snapshot["config"]["theme"];
type ClickTarget = Project["clickTarget"];

const api = window.terminalApp;

let snap: Snapshot | null = null;
let currentView: "main" | "settings" = "main";
let projectsExpanded = false;
let localMessageTimer: number | undefined;

/** 折りたたみの閾値（面 1d「他10件を表示」相当。先頭 N 件のみ表示し残りを畳む） */
const PROJECT_FOLD_LIMIT = 5;

/**
 * タイル要素（key = タイルキー）。通常は projectId、分割タイル（260904_1 #3）は `${projectId}|${sessionId}`。
 * tileSessions は 1 秒毎の時刻更新用に、各タイルが今表示しているセッションを保持する
 */
const tileEls = new Map<string, HTMLButtonElement>();
const tileSessions = new Map<string, SessionView | undefined>();

/**
 * タイルの D&D 並べ替え（260906_1 #2）。内部ドラッグは専用 MIME で識別し、フォルダ登録の外部 D&D
 * （window の dragenter/drop）と混ざらないようにする。移動はプロジェクト単位（分割タイル ①② は一緒に動く）
 */
const TILE_MIME = "application/x-terminal-app-tile";
/** ドラッグ中のプロジェクト id（内部ドラッグ中のみ。dragend / drop で戻す） */
let draggingProjectId: string | null = null;
/** 挿入位置の目印（drop-before / drop-after）を付けているタイル */
let dropTargetEl: HTMLElement | null = null;

/** 1 タイル分の描画指示（renderGrid が Snapshot から組み立てる） */
interface TileSpec {
  key: string;
  project: Project;
  session: SessionView | undefined;
  /** 分割タイルの通し番号（1 始まり）。通常タイルは undefined */
  seq?: number;
}

/** 分割タイルの番号表示（①〜⑳。それ以上は数字） */
function seqLabel(n: number): string {
  return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : `#${n}`;
}

function $(sel: string): HTMLElement {
  const el = document.querySelector(sel);
  if (el === null) throw new Error(`要素が見つかりません: ${sel}`);
  return el as HTMLElement;
}

/* ---------------- 表示テキスト（design.md 6.2 / 5.1） ---------------- */

const STATE_META: Record<SessionState, { label: string; icon: string; cls: string }> = {
  waiting: { label: "待機", icon: "◌", cls: "state-waiting" }, // ◌
  running: { label: "実行中", icon: "", cls: "state-running" }, // アイコンはスピナー
  done: { label: "完了", icon: "✓", cls: "state-done" }, // ✓
  confirm: { label: "確認待ち", icon: "?", cls: "state-confirm" },
  error: { label: "エラー", icon: "⚠", cls: "state-error" }, // ⚠
  disconnected: { label: "切断", icon: "⊘", cls: "state-disconnected" }, // 260712_2: SessionEnd 不達のまま更新途絶
};

/** 未接続タイルのツールチップ（260903_1）。復帰導線（右クリック →「立ち上げる」）まで案内する */
const CLICK_TARGETS: ClickTarget[] = ["cursor", "orca", "terminal"];

/** Orca でスリープ中のタイル（261005_4） */
const SLEEPING_ICON = "☾";
const SLEEPING_HINT = "Orca でスリープ中です（ターミナルを閉じて休ませている状態）。右クリック →「起こす」で再開できます";
const TARGET_LABEL: Record<ClickTarget, string> = { cursor: "Cursor", orca: "Orca", terminal: "ターミナル" };

const UNLINKED_HINT: Record<ClickTarget, string> = {
  cursor: "Cursor でこのフォルダを開いているウィンドウが見つかりません。右クリック →「立ち上げる」で開けます",
  orca: "Orca でこのフォルダが開かれていません（Orca が起動していないか、ワークスペースに無い）。右クリック →「立ち上げる」で開けます",
  terminal: "このフォルダを開いているターミナルのウィンドウが見つかりません。右クリック →「立ち上げる」で開けます",
};

/** 未接続タイルの件数（260903_1）。ステータスバーのトグルラベル用 */
function countUnlinked(s: Snapshot): number {
  return buildTileSpecs(s).filter(({ project, session }) =>
    isUnlinked(s.windowPresence[project.id], session?.state, session?.provider, session?.terminalClosed)).length;
}

function tileStatusText(session: SessionView | undefined): string {
  if (session === undefined) return "待機・イベント待ち";
  if (session.state === "running") {
    const elapsed = session.runningSince !== undefined ? fmtElapsed(Date.now() - session.runningSince) : "実行中";
    // statusLine 転送のメトリクス（260712_3 案A: 「↓ 70.5k tokens · thinking xhigh」相当）を併記。
    // 未転送・取得不能時は経過時間のみ（フォールバック）
    return session.statsText !== undefined && session.statsText !== "" ? `${elapsed} · ${session.statsText}` : elapsed;
  }
  // 返答待ち（260922_2: Jev 判定の確認待ち）はラベルだけ変える（色・点滅・左上配置は確認待ちと同じ）
  const label = session.state === "confirm" ? confirmLabel(session.confirmKind) : STATE_META[session.state].label;
  return `${label}・${fmtRelative(Date.now() - session.lastEventAt)}`;
}

/** タイルのステータス行を更新（renderGrid と 1 秒毎の時刻更新で共用。差分がある時だけ DOM を触る） */
function updateTileStatus(el: HTMLElement, session: SessionView | undefined): void {
  const statusEl = el.querySelector(".tile-status") as HTMLElement;
  // スリープ中（261005_4）は経過時間の更新でも上書きしない
  const text = el.classList.contains("is-sleeping") ? "スリープ中（Orca）" : tileStatusText(session);
  if (statusEl.textContent !== text) statusEl.textContent = text;
}

/* ---------------- テーマ（design.md 6.5 / REQ-13） ---------------- */

function resolveTheme(setting: ThemeSetting): "light" | "dark" {
  if (setting === "auto") {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return setting;
}

function applyTheme(): void {
  if (snap === null) return;
  document.documentElement.dataset.theme = resolveTheme(snap.config.theme);
}

window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyTheme());

/* ---------------- タイルグリッド（面 1a / 1b） ---------------- */

function createTile(project: Project, sessionId?: string): HTMLButtonElement {
  const el = document.createElement("button");
  el.className = "tile state-waiting";
  el.setAttribute("role", "listitem");
  el.dataset.id = project.id;
  if (sessionId !== undefined) el.dataset.sessionId = sessionId;

  const glow = document.createElement("span");
  glow.className = "tile-glow";
  // 見出し = 1 行目: プロジェクト名（＋分割タイルの番号）／2 行目: 手動ステータスバッジ
  // （260727_1 のバッジは 260904_1 #1 で名前の下の行へ移動 — 名前と同じ行を取り合わない。未割り当て時は hidden）
  const head = document.createElement("span");
  head.className = "tile-head";
  const nameRow = document.createElement("span");
  nameRow.className = "tile-name-row";
  const name = document.createElement("span");
  name.className = "tile-name";
  const seq = document.createElement("span");
  seq.className = "tile-seq";
  seq.hidden = true;
  const provider = document.createElement("span");
  provider.className = "tile-provider";
  provider.textContent = "Codex";
  provider.hidden = true;
  nameRow.append(name, seq, provider);
  const badge = document.createElement("span");
  badge.className = "tile-badge";
  badge.hidden = true;
  // ループ進捗バッジ（260907_2）: 手動バッジと同じ行に並べる。両方無いときは行ごと隠してレイアウトを崩さない
  const loop = document.createElement("span");
  loop.className = "tile-loop";
  // サブエージェント待ち（260922_8）: 本体は止まっているが裏でエージェントが動いている間の説明
  const bg = document.createElement("span");
  bg.className = "tile-bg";
  bg.hidden = true;
  // 注意印（260922_2）: 確認待ちの危険度／実行中の停滞の疑い（Jev 判定）。無いときは hidden
  const alert = document.createElement("span");
  alert.className = "tile-alert";
  alert.hidden = true;
  // 名前の見直し提案（260922_6）: Jev が「表示名が作業を表していない」と判定したタイルに出す
  const nameHint = document.createElement("span");
  nameHint.className = "tile-name-hint";
  nameHint.hidden = true;
  loop.hidden = true;
  const badgeRow = document.createElement("span");
  badgeRow.className = "tile-badge-row";
  badgeRow.hidden = true;
  badgeRow.append(badge, loop, alert, nameHint, bg);
  // 今やっているタスク（260922_10）: Claude Code の ai-title。名前の下に薄く出す
  const task = document.createElement("span");
  task.className = "tile-task";
  task.hidden = true;
  head.append(nameRow, task, badgeRow);
  const center = document.createElement("span");
  center.className = "tile-center";
  const spinner = document.createElement("span");
  spinner.className = "tile-spinner";
  const icon = document.createElement("span");
  icon.className = "tile-icon";
  // 現在の作業テキスト（260712 課題B: UserPromptSubmit の prompt 由来。未取得時は非表示）
  const work = document.createElement("span");
  work.className = "tile-work";
  work.hidden = true;
  const status = document.createElement("span");
  status.className = "tile-status";
  center.append(spinner, icon, work);
  el.append(glow, head, center, status);

  el.addEventListener("click", (e) => {
    // クリックで前面化（REQ-05）。分割タイルもプロジェクトのウィンドウを前面化する（Cursor 内の
    // 特定ターミナルまでは外から選べない。Orca は押した枠のセッションのタブへ切り替える = 261005_1）。
    // 失敗メッセージは main からステータスバーへ届く。
    // タッチ／ペンのときは main にそれを伝え、ポインターを対象ウィンドウへ連れて行ってもらう
    // （260925_1: タッチ後は Windows がポインターを隠す＋別画面に残すため迷子になる）
    const pointerType = (e as PointerEvent).pointerType;
    const viaTouch = pointerType === "touch" || pointerType === "pen";
    void api.focusProject(project.id, {
      ...(viaTouch ? { viaTouch: true } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
  });
  el.addEventListener("contextmenu", (e) => {
    // 右クリック = プロジェクト操作メニュー（260712_2: 再接続・表示クリア・登録解除）。
    // メニュー本体は main 側のネイティブ Menu（クリック確定処理も main が持つ）。
    // 分割タイルは sessionId を渡し「この枠を消す」を出してもらう（260904_1 #3）
    e.preventDefault();
    void api.showTileMenu(project.id, sessionId);
  });
  wireTileDrag(el, project.id);
  wireTilePeek(el, project.id, sessionId);
  return el;
}

/* ---------------- タイルの D&D 並べ替え（260906_1 #2） ---------------- */

/** 内部（タイル）ドラッグか。dragenter/dragover 中は getData 不可のため types で判定する */
function isTileDrag(dt: DataTransfer | null): boolean {
  return draggingProjectId !== null || (dt !== null && Array.from(dt.types).includes(TILE_MIME));
}

function clearDropMarker(): void {
  if (dropTargetEl === null) return;
  dropTargetEl.classList.remove("drop-before", "drop-after");
  dropTargetEl = null;
}

/** ドロップ位置: タイルの左半分なら手前、右半分なら直後（グリッドは左→右・上→下の流れ） */
function isDropAfter(el: HTMLElement, clientX: number): boolean {
  const rect = el.getBoundingClientRect();
  return clientX >= rect.left + rect.width / 2;
}

function wireTileDrag(el: HTMLButtonElement, projectId: string): void {
  el.draggable = true;
  el.addEventListener("dragstart", (e) => {
    if (e.dataTransfer === null) return;
    draggingProjectId = projectId;
    e.dataTransfer.setData(TILE_MIME, projectId);
    e.dataTransfer.effectAllowed = "move";
    el.classList.add("is-dragging");
  });
  el.addEventListener("dragend", () => {
    // ドロップされなかった（隙間・枠外で離した）ときもここで片付く
    draggingProjectId = null;
    el.classList.remove("is-dragging");
    clearDropMarker();
  });
  el.addEventListener("dragover", (e) => {
    if (!isTileDrag(e.dataTransfer)) return; // フォルダのドロップは window 側（登録）に任せる
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer !== null) e.dataTransfer.dropEffect = "move";
    if (draggingProjectId === projectId) {
      clearDropMarker();
      return;
    }
    const after = isDropAfter(el, e.clientX);
    if (dropTargetEl !== el) {
      clearDropMarker();
      dropTargetEl = el;
    }
    el.classList.toggle("drop-before", !after);
    el.classList.toggle("drop-after", after);
  });
  el.addEventListener("dragleave", (e) => {
    // 子要素間の移動でも dragleave が飛ぶため、タイルの外へ出たときだけ目印を消す
    if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
    if (dropTargetEl === el) clearDropMarker();
  });
  el.addEventListener("drop", (e) => {
    if (!isTileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    const fromId = draggingProjectId ?? e.dataTransfer?.getData(TILE_MIME) ?? "";
    const after = isDropAfter(el, e.clientX);
    clearDropMarker();
    draggingProjectId = null;
    void reorderByDrop(fromId, projectId, after);
  });
}

/** D&D の確定: 現在の並び（Snapshot.projects 順）から新しい id 順を作り main へ保存を依頼する */
async function reorderByDrop(fromId: string, toId: string, after: boolean): Promise<void> {
  if (snap === null || fromId === "" || fromId === toId) return;
  const ids = snap.projects.map((p) => p.id);
  const next = moveProjectId(ids, fromId, toId, after);
  if (next.every((id, i) => id === ids[i])) return;
  const result = await api.reorderProjects(next);
  if (!result.ok) showLocalMessage(result.error ?? "並び順を変更できませんでした");
}

/* ---------------- 自動整列（260906_1 #1） ---------------- */

/**
 * 接続中のプロジェクトを先頭（左上）へ、未接続を後ろへ寄せる。グループ内の相対順は保つ。
 * ボタン押下時に 1 回だけ行う（5 秒ごとのウィンドウ判定に追従して勝手に並び替えると目で追えなくなる）
 */
function autoArrange(): void {
  if (snap === null || snap.projects.length === 0) return;
  const s = snap;
  const linked: Record<string, boolean> = {};
  for (const p of s.projects) {
    const members = s.splitSessions[p.id];
    const sessions = members !== undefined && members.length >= 2 ? members : [s.sessions[p.id]];
    linked[p.id] = sessions.some((session) => !isUnlinked(s.windowPresence[p.id], session?.state, session?.provider, session?.terminalClosed));
  }
  const ids = s.projects.map((p) => p.id);
  const linkedCount = ids.filter((id) => linked[id]).length;
  const next = autoArrangeIds(ids, linked);
  if (next.every((id, i) => id === ids[i])) {
    showLocalMessage(`すでに整列済みです（接続中 ${linkedCount} 件が先頭）`);
    return;
  }
  void (async () => {
    const result = await api.reorderProjects(next);
    if (result.ok) showLocalMessage(`自動整列しました: 接続中 ${linkedCount} 件を左上へ・未接続 ${ids.length - linkedCount} 件を後ろへ`);
    else showLocalMessage(result.error ?? "整列できませんでした");
  })();
}

/**
 * 表示順のプロジェクト一覧（260922_1）: 確認待ちのプロジェクトを先頭（左上）へ寄せる。
 * Snapshot.projects（= projects.json の並び）そのものは変えない — D&D（reorderByDrop）と自動整列は
 * 引き続き projects.json の並びを基準に動き、確認待ちが解ければタイルは元の位置へ戻る
 */
function displayProjects(s: Snapshot): Project[] {
  const confirming: Record<string, boolean> = {};
  for (const p of s.projects) {
    const members = s.splitSessions[p.id];
    const states = members !== undefined && members.length >= 2 ? members.map((m) => m.state) : [s.sessions[p.id]?.state];
    confirming[p.id] = projectConfirming(states);
  }
  const byId = new Map(s.projects.map((p) => [p.id, p] as const));
  return confirmFirstIds(s.projects.map((p) => p.id), confirming).map((id) => byId.get(id)!);
}

/**
 * Snapshot → タイル一覧（260904_1 #3）。表示順（260922_1: 確認待ちが先頭）に、分割対象（splitSessions にキーあり）は
 * セッションごとに 1 タイル（起動順・番号付き）、それ以外は従来の 1 タイル
 */
function buildTileSpecs(s: Snapshot): TileSpec[] {
  const specs: TileSpec[] = [];
  for (const project of displayProjects(s)) {
    const members = s.splitSessions[project.id];
    if (members !== undefined && members.length >= 2) {
      members.forEach((session, i) => {
        specs.push({ key: `${project.id}|${session.sessionId}`, project, session, seq: i + 1 });
      });
    } else {
      specs.push({ key: project.id, project, session: s.sessions[project.id] });
    }
  }
  // 確認待ち・返答待ちのタイルそのものを先頭へ（260922_3。分割タイルの ② が確認待ちでも左上に来る）
  return confirmTilesFirst(specs, (spec) => spec.session?.state === "confirm");
}

function renderGrid(): void {
  if (snap === null) return;
  const grid = $("#tile-grid");
  const empty = $("#empty-state");
  const projects = snap.projects;

  // 空状態（面 1c / REQ-09）
  empty.hidden = projects.length > 0;
  grid.style.display = projects.length > 0 ? "" : "none";

  const specs = buildTileSpecs(snap);
  const seen = new Set<string>();
  let visibleCount = 0;
  specs.forEach((spec, index) => {
    const { project, session } = spec;
    seen.add(spec.key);
    let el = tileEls.get(spec.key);
    if (el === undefined) {
      el = createTile(project, spec.seq !== undefined ? session?.sessionId : undefined);
      tileEls.set(spec.key, el);
    }
    // DOM 順をタイル一覧の順に揃える（分割で増えたタイルを同じプロジェクトの隣に置く）。
    // 既に正しい位置にある要素は動かさない（再挿入は CSS アニメーションを最初から再生させてしまう）
    if (grid.children[index] !== el) grid.insertBefore(el, grid.children[index] ?? null);
    tileSessions.set(spec.key, session);
    const state = session === undefined ? "waiting" : session.state;
    // 未接続（260903_1）: 対象アプリのウィンドウ無し＋実行中／確認待ちでない → 灰色。非表示設定なら隠す
    // Orca でスリープ中（261005_4）: 未接続（灰色）の代わりに「スリープ中」と出す。実行中・確認待ちの表示は優先する
    const sleeping = snap!.sleeping?.[project.id] === true && state !== "running" && state !== "confirm";
    const unlinked = !sleeping && isUnlinked(snap!.windowPresence[project.id], state, session?.provider, session?.terminalClosed);
    const cls = `tile ${STATE_META[state].cls}${unlinked ? " is-unlinked" : ""}${sleeping ? " is-sleeping" : ""}${spec.seq !== undefined ? " is-split" : ""}`;
    if (el.className !== cls) el.className = cls; // 同一値の再代入を避けて発光アニメを継続させる
    const hidden = unlinked && !snap!.config.showUnlinked;
    if (el.hidden !== hidden) el.hidden = hidden;
    if (!hidden) visibleCount += 1;
    const hint = sleeping ? SLEEPING_HINT : unlinked ? UNLINKED_HINT[project.clickTarget] : "";
    if (el.title !== hint) el.title = hint;
    const nameEl = el.querySelector(".tile-name") as HTMLElement;
    const iconEl = el.querySelector(".tile-icon") as HTMLElement;
    if (nameEl.textContent !== project.name) nameEl.textContent = project.name;
    // 分割タイルの番号（260904_1 #3）。通常タイルは非表示
    const seqEl = el.querySelector(".tile-seq") as HTMLElement;
    const seqText = spec.seq !== undefined ? seqLabel(spec.seq) : "";
    if (seqEl.textContent !== seqText) seqEl.textContent = seqText;
    seqEl.hidden = seqText === "";
    // Codex のセッションは名前の横で識別する。既存の Claude タイルには表示しない
    const providerEl = el.querySelector(".tile-provider") as HTMLElement;
    providerEl.hidden = session?.provider !== "codex";
    // 手動ステータスバッジ（260727_1）。未割り当ては非表示でレイアウトを崩さない
    const badgeEl = el.querySelector(".tile-badge") as HTMLElement;
    const badge = project.customStatus ?? "";
    if (badgeEl.textContent !== badge) badgeEl.textContent = badge;
    badgeEl.hidden = badge === "";
    // ループ進捗バッジ（260907_2）。eval-loop の state が無いセッション・待機タイルは非表示
    const loopEl = el.querySelector(".tile-loop") as HTMLElement;
    const loop = session?.loopText ?? "";
    if (loopEl.textContent !== loop) {
      loopEl.textContent = loop;
      loopEl.title = loop; // 省略（…）されても hover で全文が読める
    }
    loopEl.hidden = loop === "";
    // 注意印（260922_2）: 危険度／停滞の疑い。Jev 判定が無いセッション・待機タイルは非表示
    const alertEl = el.querySelector(".tile-alert") as HTMLElement;
    const alert = tileAlertText(session);
    if (alertEl.textContent !== alert) {
      alertEl.textContent = alert;
      alertEl.title = alert;
    }
    alertEl.hidden = alert === "";
    // 名前の見直し提案（260922_6）。右クリックの「表示名を AI に提案」への導線を hover で案内する
    const hintEl = el.querySelector(".tile-name-hint") as HTMLElement;
    const nameHint = session?.nameHint ?? "";
    const hintLabel = nameHint === "" ? "" : `✎ ${nameHint}`;
    if (hintEl.textContent !== hintLabel) {
      hintEl.textContent = hintLabel;
      hintEl.title = nameHint === "" ? "" : `${nameHint}（右クリック →「表示名を AI に提案」で直せます）`;
    }
    hintEl.hidden = hintLabel === "";
    // サブエージェント待ち（260922_8）。実行中のセッションにだけ付く
    const bgEl = el.querySelector(".tile-bg") as HTMLElement;
    const bgText = session?.bgText ?? "";
    if (bgEl.textContent !== bgText) {
      bgEl.textContent = bgText;
      bgEl.title = bgText === "" ? "" : `${bgText}（本体の応答は終わっていますが、バックグラウンドのエージェントが動いています）`;
    }
    bgEl.hidden = bgText === "";
    // 今やっているタスク（260922_10）。同じプロジェクトでもセッションごとに違う
    const taskEl = el.querySelector(".tile-task") as HTMLElement;
    const task = session?.taskTitle ?? "";
    if (taskEl.textContent !== task) {
      taskEl.textContent = task;
      taskEl.title = task;
    }
    taskEl.hidden = task === "";
    const badgeRowEl = el.querySelector(".tile-badge-row") as HTMLElement;
    badgeRowEl.hidden = badge === "" && loop === "" && alert === "" && hintLabel === "" && bgText === "";
    const icon = sleeping ? SLEEPING_ICON : STATE_META[state].icon;
    if (iconEl.textContent !== icon) iconEl.textContent = icon;
    // 現在の作業テキスト（260712 課題B）。取得できないセッション・待機タイルは非表示（フォールバック）
    const workEl = el.querySelector(".tile-work") as HTMLElement;
    const work = session?.workText ?? "";
    if (workEl.textContent !== work) workEl.textContent = work;
    workEl.hidden = work === "";
    updateTileStatus(el, session);
  });
  // 登録解除・分割解除で不要になったタイルを取り除く
  for (const [key, el] of tileEls) {
    if (!seen.has(key)) {
      el.remove();
      tileEls.delete(key);
      tileSessions.delete(key);
    }
  }
  // 未接続タイルをすべて隠して表示が空になったときの案内（260903_1）。未登録の空状態とは別
  $("#all-hidden-note").hidden = !(projects.length > 0 && visibleCount === 0);
}

/* ---------------- ステータスバー（REQ-10 / design.md 6.1） ---------------- */

function renderStatusbar(): void {
  // 件数は main の StateStore.counts（Snapshot.counts）を正とし、ここでは整形のみ（重複実装の一本化）
  $("#status-counts").textContent = snap === null ? "0 セッション" : fmtStatusCounts(snap.counts);
  const msgEl = $("#status-message");
  const msg = snap?.statusMessage ?? "";
  // ローカル一時メッセージ表示中は上書きしない
  if (localMessageTimer === undefined && msgEl.textContent !== msg) {
    msgEl.textContent = msg;
  }
  // 未接続タイルの表示／非表示トグル（260903_1）。プロジェクト未登録時は出さない
  const toggle = $("#unlinked-toggle");
  if (snap === null || snap.projects.length === 0) {
    toggle.hidden = true;
    return;
  }
  toggle.hidden = false;
  const label = fmtUnlinkedLabel(countUnlinked(snap));
  const labelEl = $("#unlinked-label");
  if (labelEl.textContent !== label) labelEl.textContent = label;
  ($("#unlinked-check") as HTMLInputElement).checked = snap.config.showUnlinked;
}

/* ---------------- 表示名の変更ダイアログ（260903_2） ---------------- */

let renameTargetId: string | null = null;

/** タイル右クリック →「表示名を変更…」（main から rename-request）と設定画面の ✎ の両方から開く */
function openRenameDialog(projectId: string): void {
  if (snap === null) return;
  const project = snap.projects.find((p) => p.id === projectId);
  if (project === undefined) return;
  renameTargetId = projectId;
  $("#rename-folder").textContent = project.path;
  const input = $("#rename-input") as HTMLInputElement;
  input.value = project.name;
  $("#rename-dialog").hidden = false;
  input.focus();
  input.select();
}

function closeRenameDialog(): void {
  renameTargetId = null;
  $("#rename-dialog").hidden = true;
}

/** 確定。空はフォルダ名へ戻る（main 側の規則）。拒否（上限超過等）はダイアログを開いたままメッセージ表示 */
async function submitRename(): Promise<void> {
  if (renameTargetId === null) return;
  const value = ($("#rename-input") as HTMLInputElement).value;
  const result = await api.setProjectName(renameTargetId, value);
  if (!result.ok) {
    showLocalMessage(result.error ?? "表示名を変更できませんでした");
    return;
  }
  closeRenameDialog();
}

function showLocalMessage(text: string, ms = 6000): void {
  const msgEl = $("#status-message");
  msgEl.textContent = text;
  if (localMessageTimer !== undefined) window.clearTimeout(localMessageTimer);
  localMessageTimer = window.setTimeout(() => {
    localMessageTimer = undefined;
    renderStatusbar();
  }, ms);
}

/* ---------------- 設定（面 1d / 1f） ---------------- */

function renderSettings(): void {
  if (snap === null) return;

  // テーマ 3 択
  document.querySelectorAll<HTMLButtonElement>("#theme-seg button").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.themeChoice === snap?.config.theme);
  });

  // クリック先の一括変更（261005_1）: 全プロジェクトが同じならその値、混在なら未選択。未登録なら既定値
  const targets = new Set(snap.projects.map((p) => p.clickTarget));
  const uniform = targets.size === 1 ? [...targets][0] : targets.size === 0 ? (snap.config.defaultClickTarget ?? "cursor") : undefined;
  document.querySelectorAll<HTMLButtonElement>("#default-target-seg button").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.targetChoice === uniform);
  });

  // 常に手前を規定にする（起動時の既定値。REQ-07 / design.md 8 章）
  const aot = $("#aot-toggle") as HTMLInputElement;
  aot.checked = snap.config.alwaysOnTopDefault;

  // 通知音は MVP では常に OFF・無効（REQ-12 / AC-18）。HTML 側で disabled 固定
  const sound = $("#sound-toggle") as HTMLInputElement;
  sound.checked = snap.config.notifySound.enabled; // 常に false のはず

  // 手動ステータスの選択肢一覧（260727_1）
  const statusList = $("#status-list");
  statusList.textContent = "";
  for (const s of snap.config.customStatuses) {
    statusList.appendChild(createStatusRow(s));
  }

  // プロジェクト一覧
  const list = $("#project-list");
  list.textContent = "";
  const projects = snap.projects;
  const visible = projectsExpanded ? projects : projects.slice(0, PROJECT_FOLD_LIMIT);
  for (const project of visible) {
    list.appendChild(createProjectRow(project));
  }
  const more = $("#btn-more-projects") as HTMLButtonElement;
  const hiddenCount = projects.length - visible.length;
  if (hiddenCount > 0) {
    more.hidden = false;
    more.textContent = `他${hiddenCount}件を表示`;
  } else if (projectsExpanded && projects.length > PROJECT_FOLD_LIMIT) {
    more.hidden = false;
    more.textContent = "折りたたむ";
  } else {
    more.hidden = true;
  }
}

/** 手動ステータス 1 件の行（260727_1）: ラベル＋使用数＋削除ボタン */
function createStatusRow(statusName: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "status-row";

  const name = document.createElement("span");
  name.className = "status-name";
  name.textContent = statusName;

  const usage = document.createElement("span");
  usage.className = "status-usage";
  const count = snap === null ? 0 : snap.projects.filter((p) => p.customStatus === statusName).length;
  usage.textContent = count > 0 ? `${count} 件で使用中` : "";

  const remove = document.createElement("button");
  remove.className = "btn-remove";
  remove.title = `「${statusName}」を削除（使用中のタイルからも外れます）`;
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    if (snap === null) return;
    void api.setCustomStatuses(snap.config.customStatuses.filter((s) => s !== statusName));
  });

  const info = document.createElement("div");
  info.className = "project-info";
  info.append(name, document.createTextNode(" "), usage);
  row.append(info, remove);
  return row;
}

/** 設定画面の入力欄から手動ステータスを追加（260727_1）。空・重複は追加しない */
function addStatusFromInput(): void {
  if (snap === null) return;
  const input = $("#status-input") as HTMLInputElement;
  const name = input.value.trim();
  if (name === "") return;
  if (snap.config.customStatuses.includes(name)) {
    showLocalMessage(`「${name}」は既にあります`);
    return;
  }
  void api.setCustomStatuses([...snap.config.customStatuses, name]);
  input.value = "";
}

function createProjectRow(project: Project): HTMLElement {
  const row = document.createElement("div");
  row.className = "project-row";

  const info = document.createElement("div");
  info.className = "project-info";
  const name = document.createElement("div");
  name.className = "project-name";
  name.textContent = project.name;
  const p = document.createElement("div");
  p.className = "project-path";
  p.textContent = project.path;
  info.append(name, p);
  // 記憶したウィンドウ位置（260904_1 #3）。タイル右クリック →「ウィンドウ位置」で記憶・復元・消去
  if (project.windowBounds !== undefined) {
    const b = project.windowBounds;
    const bounds = document.createElement("div");
    bounds.className = "project-bounds";
    bounds.textContent = `ウィンドウ位置を記憶済み (${b.x}, ${b.y}) ${b.width}×${b.height}${b.maximized ? "・最大化" : ""}`;
    info.append(bounds);
  }

  const actions = document.createElement("div");
  actions.className = "project-actions";

  // 表示名の変更（260903_2）: 右クリックメニューと同じダイアログを設定画面からも開ける
  const rename = document.createElement("button");
  rename.className = "btn-edit";
  rename.title = `${project.name} の表示名を変更`;
  rename.textContent = "✎"; // ✎
  rename.addEventListener("click", () => openRenameDialog(project.id));

  // クリックで開くアプリ: [Cursor｜Orca｜ターミナル] 3 択（REQ-06 / 面 1d。Orca は 261005_1）
  const seg = document.createElement("div");
  seg.className = "segmented small";
  CLICK_TARGETS.forEach((target) => {
    const btn = document.createElement("button");
    btn.textContent = TARGET_LABEL[target];
    btn.classList.toggle("is-active", project.clickTarget === target);
    btn.addEventListener("click", () => {
      void api.setClickTarget(project.id, target);
    });
    seg.appendChild(btn);
  });

  // 登録解除（REQ-11。モック未記載・設計追加: design.md 6.4）
  const remove = document.createElement("button");
  remove.className = "btn-remove";
  remove.title = `${project.name} を登録解除（hooks も除去）`;
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    void (async () => {
      const result = await api.unregisterProject(project.id);
      if (!result.ok && result.error !== undefined) showLocalMessage(result.error);
    })();
  });

  actions.append(rename, seg, remove);
  row.append(info, actions);
  return row;
}

/* ---------------- ビュー切替・タイトルバー ---------------- */

function switchView(view: "main" | "settings"): void {
  currentView = view;
  $("#view-main").hidden = view !== "main";
  $("#view-settings").hidden = view !== "settings";
  ($("#btn-settings") as HTMLButtonElement).classList.toggle("is-active", view === "settings");
}

function renderTitlebar(): void {
  if (snap === null) return;
  ($("#btn-pin") as HTMLButtonElement).classList.toggle("is-active", snap.pinned);
}

/* ---------------- 全体レンダリング ---------------- */

function render(): void {
  applyTheme();
  renderTitlebar();
  renderGrid();
  renderStatusbar();
  if (currentView === "settings") renderSettings();
}

/** 1 秒毎に時刻表示のみ更新（経過時間・相対時刻。DOM 再構築はしない = NFR-07 に配慮） */
window.setInterval(() => {
  if (snap === null) return;
  for (const [key, el] of tileEls) {
    updateTileStatus(el, tileSessions.get(key));
  }
}, 1000);

/* ---------------- D&D 登録（REQ-01 / 面 1c: ウィンドウ全面が受け付け領域） ---------------- */

let dragDepth = 0;

// タッチ／ペンの接触が終わるたびに main へ知らせる（260925_2）。Windows はタッチ画面に触れるたびに
// ポインターを隠すため、スクロールやタイル外の接触でも迷子になる。タイル上なら続く click で対象へ
// 移動するが、その場合もここでの再表示は害がない（位置は変えない）
window.addEventListener("pointerup", (e) => {
  if (e.pointerType === "touch" || e.pointerType === "pen") api.notifyTouchEnded();
});
window.addEventListener("pointercancel", (e) => {
  if (e.pointerType === "touch" || e.pointerType === "pen") api.notifyTouchEnded();
});

window.addEventListener("dragenter", (e) => {
  if (isTileDrag(e.dataTransfer)) return; // タイルの並べ替え中（260906_1）は登録用オーバーレイを出さない
  e.preventDefault();
  dragDepth += 1;
  const overlay = $("#drop-overlay");
  if (overlay.hidden) {
    // ドラッグ開始時に一度だけ types を記録（ドラッグ中は getData 不可のため types のみ）
    const dt = e.dataTransfer;
    api.dndLog(`dragenter: types=[${dt === null ? "" : Array.from(dt.types).join(", ")}] effectAllowed=${dt?.effectAllowed ?? "-"}`);
  }
  overlay.hidden = false;
});
window.addEventListener("dragover", (e) => {
  if (isTileDrag(e.dataTransfer)) return; // タイル以外の場所（隙間）へは落とせない = 何も起きない
  e.preventDefault();
  // Cursor（VS Code 系）は effectAllowed=copyMove 等で渡してくるため、受け側の効果を明示して drop を確実に許可する
  if (e.dataTransfer !== null) e.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", (e) => {
  if (isTileDrag(e.dataTransfer)) return;
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $("#drop-overlay").hidden = true;
});
window.addEventListener("drop", (e) => {
  if (isTileDrag(e.dataTransfer)) return; // タイル上の drop は wireTileDrag が処理済み（伝播も止めている）
  e.preventDefault();
  dragDepth = 0;
  $("#drop-overlay").hidden = true;
  const dt = e.dataTransfer;
  if (dt === null) return;
  // エクスプローラからのドロップ: 実ファイルのパスを webUtils で解決
  const filePaths: string[] = [];
  for (const file of Array.from(dt.files)) {
    try {
      const p = api.getPathForFile(file);
      if (p !== "") filePaths.push(p);
    } catch {
      /* パス解決不能の項目はスキップ */
    }
  }
  // Cursor（VS Code 系）からのドラッグは files が空のため、DataTransfer の中身を
  // 丸ごと main へ渡してパス抽出（drop-paths.ts）と診断ログ出力を main 側で行う
  const types = Array.from(dt.types);
  const data: Record<string, string> = {};
  for (const t of types) {
    try {
      const v = dt.getData(t);
      if (v !== "") data[t] = v.slice(0, 8000);
    } catch {
      /* getData 不能なタイプはスキップ */
    }
  }
  void (async () => {
    const results = await api.registerDrop({ filePaths, types, data });
    const errors = results.filter((r) => !r.ok);
    if (errors.length > 0) {
      showLocalMessage(errors.map((r) => r.error ?? "登録に失敗しました").join(" ／ "));
    }
  })();
});

/* ---------------- イベント結線 ---------------- */

/** フォルダ選択ダイアログで登録（260727_1: Cursor D&D 不能の代替導線。タイトルバー＋空状態の 2 か所から呼ぶ） */
async function pickProjects(): Promise<void> {
  const results = await api.pickProjects();
  const errors = results.filter((r) => !r.ok);
  if (errors.length > 0) {
    showLocalMessage(errors.map((r) => r.error ?? "登録に失敗しました").join(" ／ "));
  }
}

function wireControls(): void {
  $("#btn-add-project").addEventListener("click", () => {
    void pickProjects();
  });
  $("#btn-pick-empty").addEventListener("click", () => {
    void pickProjects();
  });
  // 自動整列（260906_1 #1）: 接続中のタイルを左上へ
  $("#btn-arrange").addEventListener("click", () => autoArrange());
  $("#btn-pin").addEventListener("click", () => {
    if (snap === null) return;
    void api.setPinned(!snap.pinned); // 常に手前の即時切替（REQ-07）
  });
  $("#btn-theme").addEventListener("click", () => {
    if (snap === null) return;
    const next = resolveTheme(snap.config.theme) === "dark" ? "light" : "dark";
    void api.setTheme(next);
  });
  $("#btn-settings").addEventListener("click", () => {
    switchView(currentView === "settings" ? "main" : "settings");
    render();
  });
  $("#btn-back").addEventListener("click", () => {
    switchView("main");
    render();
  });
  $("#btn-restart").addEventListener("click", () => api.windowAction("restart"));
  $("#btn-min").addEventListener("click", () => api.windowAction("minimize"));
  $("#btn-max").addEventListener("click", () => api.windowAction("maximize"));
  $("#btn-close").addEventListener("click", () => api.windowAction("close"));

  document.querySelectorAll<HTMLButtonElement>("#theme-seg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const choice = btn.dataset.themeChoice as ThemeSetting | undefined;
      if (choice !== undefined) void api.setTheme(choice);
    });
  });

  // クリック先の一括変更（261005_1）
  document.querySelectorAll<HTMLButtonElement>("#default-target-seg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const choice = btn.dataset.targetChoice as ClickTarget | undefined;
      if (choice !== undefined && CLICK_TARGETS.includes(choice)) void api.setAllClickTargets(choice);
    });
  });

  ($("#aot-toggle") as HTMLInputElement).addEventListener("change", (e) => {
    void api.setAlwaysOnTopDefault((e.target as HTMLInputElement).checked);
  });

  $("#btn-more-projects").addEventListener("click", () => {
    projectsExpanded = !projectsExpanded;
    renderSettings();
  });

  // 手動ステータスの追加（260727_1）: ボタンまたは Enter で確定
  $("#btn-add-status").addEventListener("click", () => addStatusFromInput());
  ($("#status-input") as HTMLInputElement).addEventListener("keydown", (e) => {
    if (e.key === "Enter") addStatusFromInput();
  });

  // 未接続タイルの表示／非表示（260903_1）
  ($("#unlinked-check") as HTMLInputElement).addEventListener("change", (e) => {
    void api.setShowUnlinked((e.target as HTMLInputElement).checked);
  });

  // ウィンドウ位置の一括記憶／復元（260904_1 #3）。結果はステータスバー（main の setStatus）に出る
  $("#btn-save-all-bounds").addEventListener("click", () => {
    void api.saveAllWindowBounds();
  });
  $("#btn-restore-all-bounds").addEventListener("click", () => {
    void api.restoreAllWindowBounds();
  });

  // 表示名の変更ダイアログ（260903_2）: Enter／保存で確定、Esc／キャンセル／背景クリックで閉じる
  $("#rename-form").addEventListener("submit", (e) => {
    e.preventDefault();
    void submitRename();
  });
  $("#rename-cancel").addEventListener("click", () => closeRenameDialog());
  $("#rename-dialog").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeRenameDialog();
  });
  ($("#rename-input") as HTMLInputElement).addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeRenameDialog();
  });

  wireOrcaPanel();
}

/* ---------------- Orca: 画面プレビュー・返信（261005_2） ---------------- */

/** マウスを置いてからプレビューを出すまで（通りがかりで CLI を呼ばない） */
const PEEK_DELAY_MS = 600;
/** プレビューに出す画面の行数（末尾から）。指示も出すときは短くする */
const PEEK_LINES = 18;
const PEEK_LINES_WITH_INSTR = 12;
/** プレビューに出す指示の件数 */
const PEEK_INSTRUCTIONS = 3;
/** 返信パネルの画面の更新間隔 */
const PANEL_REFRESH_MS = 2000;

let peekTimer: number | undefined;
/** 進行中のプレビュー要求の番号。マウスが離れた後に届いた結果は捨てる */
let peekToken = 0;

function isOrcaProject(projectId: string): boolean {
  return snap?.projects.find((p) => p.id === projectId)?.clickTarget === "orca";
}

/** Orca 対象タイルにマウスを置くとプレビューを出す（タッチ・ペンは対象外。右クリックのパネルを使う） */
/**
 * タイルにマウスを置くとプレビューを出す（タッチ・ペンは対象外）。
 * 「あなたの指示」（261005_3。全タイル）と、Orca 対象なら Orca ターミナルの末尾（261005_2）
 */
function wireTilePeek(el: HTMLElement, projectId: string, sessionId?: string): void {
  el.addEventListener("pointerenter", (e) => {
    if (e.pointerType !== "mouse" || orcaPanel !== null) return;
    hideOrcaPeek();
    const token = ++peekToken;
    peekTimer = window.setTimeout(() => {
      const orca = isOrcaProject(projectId);
      void Promise.all([
        api.sessionInstructions(projectId, sessionId),
        orca ? api.orcaReadScreen(projectId, sessionId) : Promise.resolve(null),
      ]).then(([instr, screen]) => {
        if (token !== peekToken) return;
        const items = instr.ok ? instr.items.slice(0, PEEK_INSTRUCTIONS) : [];
        const lines = screen !== null && screen.ok ? (screen.lines ?? []) : [];
        if (items.length === 0 && lines.length === 0) return;
        // 指示があるときは画面を少し短くして、プレビューが縦に長くなりすぎないようにする
        showOrcaPeek(el, items, lines.slice(-(items.length > 0 ? PEEK_LINES_WITH_INSTR : PEEK_LINES)));
      });
    }, PEEK_DELAY_MS);
  });
  el.addEventListener("pointerleave", () => hideOrcaPeek());
  el.addEventListener("pointerdown", () => hideOrcaPeek());
}

/** 送った時刻の表示（今日なら HH:MM、それ以前は M/D HH:MM） */
function fmtInstructionTime(at: number | undefined): string {
  if (at === undefined) return "";
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 指示の一覧を描く（新しい順。先頭 = 直近の指示を太字）。0 件なら隠す */
function renderInstructions(container: HTMLElement, items: ReadonlyArray<{ text: string; at?: number }>): void {
  container.textContent = "";
  container.hidden = items.length === 0;
  if (items.length === 0) return;
  const head = document.createElement("div");
  head.className = "instr-head";
  head.textContent = "あなたの指示（新しい順）";
  container.append(head);
  items.forEach((item, i) => {
    const row = document.createElement("div");
    row.className = i === 0 ? "instr-item is-latest" : "instr-item";
    const time = document.createElement("span");
    time.className = "instr-time";
    time.textContent = fmtInstructionTime(item.at);
    const text = document.createElement("div");
    text.className = "instr-text";
    text.textContent = item.text;
    text.title = item.text; // 省略された長い指示も hover で全文が読める
    row.append(time, text);
    container.append(row);
  });
}

function hideOrcaPeek(): void {
  peekToken += 1;
  if (peekTimer !== undefined) window.clearTimeout(peekTimer);
  peekTimer = undefined;
  $("#orca-peek").hidden = true;
}

/** タイルの下（入らなければ上）に、画面の外へはみ出さない位置で出す */
function showOrcaPeek(anchor: HTMLElement, items: ReadonlyArray<{ text: string; at?: number }>, lines: string[]): void {
  const box = $("#orca-peek");
  renderInstructions($("#peek-instr"), items);
  const pre = $("#orca-peek-text");
  pre.textContent = lines.join("\n");
  pre.hidden = lines.length === 0;
  box.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
}

/** 開いている返信パネル。状態はパネルごとに持つ（閉じた古いパネルの送信完了が新しいパネルに影響しない） */
interface OrcaPanelState {
  projectId: string;
  /** 開いた時点で固定したセッション。無ければ送信しない（表示のみ） */
  sessionId?: string;
  /** 送信中（応答待ち）。この間は画面の更新が入力欄を再び有効にしない（二重送信・Esc 二連打を防ぐ） */
  sending: boolean;
  /** 直近に「送信できる」と確認できたか。更新が一時的に失敗しても入力途中の欄を無効にしない */
  sendable: boolean;
  /** 前回描いた指示の一覧（同じなら描き直さない） */
  instrKey?: string;
}

let orcaPanel: OrcaPanelState | null = null;
let orcaPanelTimer: number | undefined;

/** 右クリック →「Orca: 画面を見て返信…」 */
function openOrcaPanel(projectId: string, sessionId?: string): void {
  const project = snap?.projects.find((p) => p.id === projectId);
  if (project === undefined) return;
  hideOrcaPeek();
  // 開いた時点のセッションに固定する（代表セッションが後から入れ替わっても、送信先が変わらないように）
  const pinned = sessionId ?? snap?.sessions[projectId]?.sessionId;
  orcaPanel = pinned !== undefined
    ? { projectId, sessionId: pinned, sending: false, sendable: false }
    : { projectId, sending: false, sendable: false };
  $("#orca-title").textContent = `Orca — ${project.name}`;
  $("#orca-screen").textContent = "読み込み中…";
  $("#orca-note").textContent = "";
  renderInstructions($("#orca-instr"), []);
  const input = $("#orca-input") as HTMLInputElement;
  input.value = "";
  setOrcaSendEnabled(false);
  $("#orca-dialog").hidden = false;
  input.focus();
  if (orcaPanelTimer !== undefined) window.clearTimeout(orcaPanelTimer);
  orcaPanelTimer = undefined;
  void refreshOrcaPanelLoop(orcaPanel);
}

/** 前回の読み取りが終わってから次を予約する（Orca が遅いときに CLI を積み上げない） */
async function refreshOrcaPanelLoop(target: typeof orcaPanel): Promise<void> {
  if (target === null || orcaPanel !== target) return;
  await refreshOrcaPanel();
  if (orcaPanel !== target) return;
  orcaPanelTimer = window.setTimeout(() => void refreshOrcaPanelLoop(target), PANEL_REFRESH_MS);
}

function closeOrcaPanel(): void {
  orcaPanel = null;
  if (orcaPanelTimer !== undefined) window.clearTimeout(orcaPanelTimer);
  orcaPanelTimer = undefined;
  $("#orca-dialog").hidden = true;
}

function setOrcaSendEnabled(enabled: boolean): void {
  ($("#orca-input") as HTMLInputElement).disabled = !enabled;
  ($("#orca-send") as HTMLButtonElement).disabled = !enabled;
  ($("#orca-esc") as HTMLButtonElement).disabled = !enabled;
}

async function refreshOrcaPanel(): Promise<void> {
  const target = orcaPanel;
  if (target === null) return;
  const [r, instr] = await Promise.all([
    api.orcaReadScreen(target.projectId, target.sessionId),
    api.sessionInstructions(target.projectId, target.sessionId),
  ]);
  if (orcaPanel !== target) return; // 閉じた・別のパネルを開いた後の結果は捨てる
  // 指示の欄は内容が変わったときだけ描き直す（読んでいる途中のスクロール位置を戻さない）
  const instrKey = JSON.stringify(instr.items);
  if (instr.ok && instrKey !== target.instrKey) {
    target.instrKey = instrKey;
    renderInstructions($("#orca-instr"), instr.items);
  }
  const screen = $("#orca-screen");
  // 下端を見ているときだけ追従する（上へスクロールして読んでいる途中は動かさない）
  const atBottom = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 24;
  if (!r.ok) {
    // 一時的な失敗では画面と入力欄の状態を保つ（入力途中の欄を無効にしない）
    if (!target.sending) $("#orca-note").textContent = r.message ?? "画面を読めませんでした";
    return;
  }
  screen.textContent = (r.lines ?? []).join("\n");
  if (atBottom) screen.scrollTop = screen.scrollHeight;
  if (target.sending) return; // 送信の結果待ち。入力欄の有効化と案内文は送信処理に任せる
  // セッションを固定できなかったパネルは表示のみ（main 側も送信を拒否する）
  target.sendable = r.exact === true && target.sessionId !== undefined;
  const input = $("#orca-input") as HTMLInputElement;
  const wasDisabled = input.disabled;
  setOrcaSendEnabled(target.sendable);
  if (target.sendable && wasDisabled) input.focus();
  $("#orca-note").textContent = target.sendable
    ? ""
    : "このセッションのエージェントが動いている Orca ターミナルを確認できないため、ここからは送信できません。";
}

async function sendOrcaInput(input: { kind: "text"; text: string } | { kind: "escape" }): Promise<void> {
  const target = orcaPanel;
  if (target === null || target.sending || !target.sendable) return;
  target.sending = true;
  setOrcaSendEnabled(false);
  $("#orca-note").textContent = input.kind === "escape" ? "中断（Esc）を送っています…" : "送信しています…";
  try {
    const r = await api.orcaSend(target.projectId, target.sessionId, input);
    if (orcaPanel !== target) return;
    if (!r.ok) {
      $("#orca-note").textContent = r.message ?? "送信できませんでした";
    } else {
      $("#orca-note").textContent = input.kind === "escape" ? "中断（Esc）を送りました" : "送信しました";
      if (input.kind === "text") ($("#orca-input") as HTMLInputElement).value = "";
    }
  } finally {
    target.sending = false;
    if (orcaPanel === target) {
      setOrcaSendEnabled(target.sendable);
      if (target.sendable) ($("#orca-input") as HTMLInputElement).focus();
    }
  }
}

function wireOrcaPanel(): void {
  $("#orca-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = ($("#orca-input") as HTMLInputElement).value;
    if (text.trim() !== "") void sendOrcaInput({ kind: "text", text });
  });
  $("#orca-esc").addEventListener("click", () => void sendOrcaInput({ kind: "escape" }));
  $("#orca-open").addEventListener("click", () => {
    const target = orcaPanel;
    closeOrcaPanel();
    if (target !== null) void api.focusProject(target.projectId, target.sessionId !== undefined ? { sessionId: target.sessionId } : undefined);
  });
  $("#orca-close").addEventListener("click", () => closeOrcaPanel());
  $("#orca-dialog").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeOrcaPanel();
  });
  $("#orca-dialog").addEventListener("keydown", (e) => {
    // Esc はパネルを閉じるだけ（エージェントへの中断は「中断（Esc）」ボタンで明示的に送る）
    if (e.key === "Escape") closeOrcaPanel();
  });
}

/* ---------------- 起動 ---------------- */

api.onSnapshot((s) => {
  snap = s;
  render();
  // NFR-01 のログ差分計測: 描画完了を main へ通知（verification.md 3.2）
  window.requestAnimationFrame(() => api.notifyRendered(s.revision));
});

// タイル右クリック →「表示名を変更…」（260903_2）。メニュー本体は main のネイティブ Menu、入力 UI はこちら
api.onRenameRequest((id) => openRenameDialog(id));
// タイル右クリック →「Orca: 画面を見て返信…」（261005_2）
api.onOrcaPanelRequest((id, sessionId) => openOrcaPanel(id, sessionId ?? undefined));

void (async () => {
  wireControls();
  // --view=settings 起動（設定画面の検証・証跡用）
  if (new URLSearchParams(window.location.search).get("view") === "settings") {
    switchView("settings");
  }
  snap = await api.getSnapshot();
  render();
})();
