/**
 * ③ UI の表示整形 純関数（renderer.ts から切り出し。DOM 非依存のため Vitest で単体テスト可能）。
 * 対応設計: design.md 5.1（経過時間・相対時刻の表示規則）／6.1（ステータスバーの 0 件省略）。
 * 前ループ evaluator 指摘（renderer 表示純関数のテスト未カバー）への対応として分離した。
 */
import type { SessionState, SessionView, StatusCounts } from "../shared/types";

/** 実行中の経過時間 h:mm:ss（モック 1a: 1:24:01。design.md 5.1 / 6.2） */
export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 相対時刻（design.md 5.1: 1 分未満は「たった今」。以降は分・時間・日単位） */
export function fmtRelative(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return "たった今";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}時間前`;
  return `${Math.floor(hr / 24)}日前`;
}

/**
 * ステータスバー表記（REQ-10 / design.md 6.1）。
 * 件数 0 の状態は省略する（面 1b の表記: 「8実行中 2完了 1確認待ち 1エラー / 12セッション」）。
 * 全状態 0 件のときは「{N} セッション」のみ（面 1a / 1c）。
 * counts は StateStore.counts（main 側）を正とし、本関数は整形のみを行う（重複実装の一本化）。
 */
export function fmtStatusCounts(counts: StatusCounts): string {
  const parts: string[] = [];
  if (counts.running > 0) parts.push(`${counts.running}実行中`);
  if (counts.done > 0) parts.push(`${counts.done}完了`);
  if (counts.confirm > 0) parts.push(`${counts.confirm}確認待ち`);
  if (counts.error > 0) parts.push(`${counts.error}エラー`);
  if ((counts.disconnected ?? 0) > 0) parts.push(`${counts.disconnected}切断`); // 260712_2（オプショナル: 旧呼び出しは 0 扱い）
  return parts.length > 0 ? `${parts.join(" ")} / ${counts.total}セッション` : `${counts.total} セッション`;
}

/**
 * 未接続タイルの判定（260903_1）。
 * present = main が 5 秒ごとに判定した「クリックで開く対象アプリ（Cursor / ターミナル）のウィンドウが
 * 見つかったか」（Snapshot.windowPresence）。undefined = 判定不能（koffi 未ロード・初回判定前）。
 * 規則: ウィンドウが無く、かつ実行中・確認待ちでもないタイルだけを未接続にする —
 * タイトル一致の偽陰性（タブ切替でタイトルが変わる等）で作業中のタイルを灰色化・非表示にしないため。
 * Codex は writer lock で終了を確認した履歴（terminalClosed）だけを同じ規則に乗せる（260929_1）。
 */
export function isUnlinked(
  present: boolean | undefined,
  state: SessionState | undefined,
  provider?: SessionView["provider"],
  terminalClosed?: boolean,
): boolean {
  // 開いている Codex（Cursor 外の CLI・アプリを含む）は Cursor のウィンドウ有無では隠さない。
  // 終了を確認した履歴まで除外すると、閉じたプロジェクトが最大 24 時間「完了」のまま残る
  if (provider === "codex" && terminalClosed !== true) return false;
  if (present !== false) return false;
  return state !== "running" && state !== "confirm";
}

/** ステータスバーの表示／非表示トグルのラベル（260903_1）。件数は現在の未接続タイル数 */
export function fmtUnlinkedLabel(count: number): string {
  return `未接続を表示（${count}）`;
}

/**
 * プロジェクト単位の「接続中」判定（260906_1）。isUnlinked をタイル単位からプロジェクト単位へ持ち上げる:
 * 分割タイル（同じプロジェクトの複数セッション）はいずれか 1 本でも接続中なら接続中。
 * states が空（表示セッション無し = 待機 1 タイル）は [undefined] として判定する
 */
export function projectLinked(present: boolean | undefined, states: (SessionState | undefined)[]): boolean {
  const list = states.length > 0 ? states : [undefined];
  return list.some((state) => !isUnlinked(present, state));
}

/**
 * 自動整列（260906_1）: 接続中のプロジェクトを先頭（グリッドの左上）へ、未接続を後ろへ寄せる。
 * それぞれのグループ内では元の相対順（ユーザーが D&D で決めた順）を保つ。
 * linked に無い id は接続中扱い（判定不能を隠さない側 = isUnlinked の undefined と同じ）。
 */
export function autoArrangeIds(ids: readonly string[], linked: Record<string, boolean>): string[] {
  const front = ids.filter((id) => linked[id] !== false);
  const back = ids.filter((id) => linked[id] === false);
  return [...front, ...back];
}

/**
 * D&D 並べ替え（260906_1）: fromId を toId の手前（after=false）または直後（after=true）へ移した
 * 新しい順序を返す。自分自身・未知の id は元の順序のコピーを返す。元配列は変更しない。
 */
export function moveProjectId(ids: readonly string[], fromId: string, toId: string, after: boolean): string[] {
  const next = [...ids];
  if (fromId === toId) return next;
  const from = next.indexOf(fromId);
  if (from < 0 || !next.includes(toId)) return next;
  next.splice(from, 1);
  const to = next.indexOf(toId); // 抜いた後の位置で数える（右方向の移動でずれない）
  next.splice(after ? to + 1 : to, 0, fromId);
  return next;
}

/**
 * プロジェクト単位の「確認待ち」判定（260922_1）。分割タイルはいずれか 1 本でも confirm なら該当。
 * 待機タイル（undefined）・空配列は該当しない
 */
export function projectConfirming(states: readonly (SessionState | undefined)[]): boolean {
  return states.some((state) => state === "confirm");
}

/**
 * 確認待ちを先頭へ（260922_1）: 確認待ちのプロジェクトを**表示上だけ**グリッドの先頭（左上）へ寄せる。
 * autoArrangeIds と違い projects.json の並び（ユーザーの D&D 順）には書き戻さない — 確認待ちが解ければ
 * 元の位置へ自然に戻り、並び順が勝手に壊れない。各グループ内の相対順は元の順を保つ。
 * confirming に無い id（undefined）は確認待ちではない扱い（明示的な true だけを前へ出す）
 */
export function confirmFirstIds(ids: readonly string[], confirming: Record<string, boolean>): string[] {
  const front = ids.filter((id) => confirming[id] === true);
  if (front.length === 0) return [...ids];
  const back = ids.filter((id) => confirming[id] !== true);
  return [...front, ...back];
}

/**
 * 確認待ちのラベル（260922_2）: Jev が「Claude の最後の返答が質問・判断依頼で終わっている」と判定した
 * 返答待ち（confirmKind="question"）は「返答待ち」、それ以外（権限確認・入力待ち）は従来の「確認待ち」
 */
export function confirmLabel(confirmKind: SessionView["confirmKind"]): string {
  return confirmKind === "question" ? "返答待ち" : "確認待ち";
}

/**
 * タイルの注意印（260922_2）: 確認待ちの危険度（dangerText）と実行中の停滞の疑い（stallText）を 1 つの赤いピルに出す。
 * 両方あることは無い（状態が排他）が、あれば危険度を優先。無ければ空文字（非表示）
 */
export function tileAlertText(session: Pick<SessionView, "dangerText" | "stallText"> | undefined): string {
  if (session === undefined) return "";
  return session.dangerText ?? session.stallText ?? "";
}

/**
 * タイル単位の確認待ち先頭配置（260922_3）: 分割タイル（同じプロジェクトの ①②…）の中に確認待ちが混ざるとき、
 * プロジェクト単位の並べ替え（confirmFirstIds）だけでは「dev ①（完了）」が先頭に来て確認待ちの ② が左上にならない。
 * 表示直前にタイル一覧を安定分割し、確認待ちのタイルを全部先頭へ出す（残りの相対順・番号はそのまま）
 */
export function confirmTilesFirst<T>(items: readonly T[], isConfirm: (item: T) => boolean): T[] {
  const front = items.filter((it) => isConfirm(it));
  if (front.length === 0) return [...items];
  return [...front, ...items.filter((it) => !isConfirm(it))];
}
