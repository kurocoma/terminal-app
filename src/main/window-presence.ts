/**
 * 未接続タイル（260903_1）: 各プロジェクトについて「クリックで開く対象アプリ（Cursor / Orca / ターミナル）の
 * ウィンドウが今あるか」を定期的に判定し、無いタイルを灰色表示・非表示の対象にする。
 *
 * - 判定条件は前面化（focusProjectWindow）・切断検知（liveness-monitor の windowPresent）と同じ
 *   hasWindowFor（exe 名＋タイトルにフォルダ名。design.md 7.1）。判定基準を 3 か所に分けない
 * - 本ファイルは純関数のみ: EnumWindows の結果（TopLevelWindow[]）を注入して判定する → 単体テスト可。
 *   koffi による列挙とタイマーは index.ts 側（pollWindowPresence）
 * - koffi 未ロード等で判定不能なときは空のマップにする（renderer は undefined を「接続あり」扱い = 安全側）
 * - タイトル一致はヒューリスティックで偽陰性がある（タブ切替でタイトルが変わる等）ため、
 *   renderer 側（format.isUnlinked）は実行中・確認待ちのタイルを未接続にしない
 */
import * as path from "path";
import type { Project } from "../shared/types";
import { normalizePath } from "./state-store";
import { hasWindowFor, type TopLevelWindow } from "./window-control";

/** 検証用の env 上書き（liveness-monitor と同系の検証フラグ。実運用では未設定 = 既定値） */
function envMs(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** ウィンドウ列挙の間隔（既定 5 秒）。Cursor を開いた／閉じた変化がこの遅れでタイルに反映される */
export const WINDOW_POLL_INTERVAL_MS = envMs("TERMINAL_APP_WINDOW_POLL_MS", 5_000);

/** key = projectId、value = 対象アプリのウィンドウが見つかったか */
export type WindowPresence = Record<string, boolean>;

/**
 * 登録済み全プロジェクトのウィンドウ有無を一括判定する（列挙結果は 1 回分を使い回す）。
 * Orca 対象（261005_1）は「Orca の窓がある」かつ「Orca で開いているフォルダ一覧（orcaPaths。正規化済み）に
 * 登録フォルダがある」で接続あり。orcaPaths = null（CLI で取得できなかった）は窓の有無だけで判定する（灰色にしない側）
 */
export function computeWindowPresence(
  projects: readonly Project[],
  windows: readonly TopLevelWindow[],
  orcaPaths: ReadonlySet<string> | null = null,
): WindowPresence {
  const out: WindowPresence = {};
  for (const p of projects) {
    out[p.id] = projectWindowPresent(p, windows, orcaPaths);
  }
  return out;
}

/** 1 プロジェクト分の判定。前面化・切断検知（index.ts）からも同じ規則で使う */
export function projectWindowPresent(
  project: Project,
  windows: readonly TopLevelWindow[],
  orcaPaths: ReadonlySet<string> | null,
): boolean {
  if (!hasWindowFor(project.clickTarget, path.basename(project.path), windows)) return false;
  if (project.clickTarget !== "orca" || orcaPaths === null) return true;
  return orcaPaths.has(normalizePath(project.path));
}

/** 表示に影響する変化が無ければ broadcast を省く（5 秒ごとの再描画を避ける）ための同値判定 */
export function presenceEquals(a: WindowPresence, b: WindowPresence): boolean {
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  return keysA.every((k) => k in b && a[k] === b[k]);
}

/** 変化した（値が変わった／新たに現れた）プロジェクトの一覧。ログ出力用（消えた id は登録解除なので載せない） */
export function presenceDiff(prev: WindowPresence, next: WindowPresence): Array<{ id: string; present: boolean }> {
  const out: Array<{ id: string; present: boolean }> = [];
  for (const [id, present] of Object.entries(next)) {
    if (prev[id] !== present) out.push({ id, present });
  }
  return out;
}
