/**
 * タッチ後のポインター迷子対策（260925_1 / 260925_2）の判断ロジック。
 * Win32 呼び出しは PointerPort に切り出し、この層は「いつ・どこへ・何回」を決めるだけ（テスト可能）。
 *
 * 背景（design.md 7.3）: Windows はタッチ入力でポインターを隠し（CURSOR_SUPPRESSED）、位置もタッチした
 * 画面に残す。しかもタッチ→マウス変換の遅延メッセージで、こちらが動かした直後にまた戻す／隠すことがある。
 */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

/** GetCursorInfo の flags（CURSORINFO.flags） */
export const CURSOR_SHOWING = 0x0001;
/** タッチ／ペン入力でポインターが抑制（非表示）されている */
export const CURSOR_SUPPRESSED = 0x0002;

export interface PointerState {
  pos: Point;
  /** CURSORINFO.flags。取得失敗時は null */
  flags: number | null;
  /** native 診断用。前面とポインター直下のアプリは異なることがある。 */
  hasCursorShape?: boolean;
  foregroundPid?: number;
  pointerWindowPid?: number;
}

/** Win32 への窓口。window-control が実装する */
export interface PointerPort {
  /** 対象ウィンドウの画面座標。取得失敗は null */
  windowRect(handle: unknown): Rect | null;
  cursor(): PointerState | null;
  setCursorPos(x: number, y: number): void;
  /** 時間を空けた微小移動。遅延した戻しの失敗も通知する。 */
  jiggle(onFailure: () => void): void;
  /** 新しいタップで古い位置へ戻さないよう、遅延した戻しを取り消す。 */
  cancelJiggle(): void;
}

/**
 * 再試行タイミング（ms）。0 = 即時。
 * 即時 1 回の移動だけでは Windows の遅延メッセージに負けることがあるため、タッチ処理が落ち着くまで数回やり直す
 */
export const POINTER_WARP_RETRY_DELAYS_MS: readonly number[] = [0, 120, 300, 600, 1000];

/** 再表示だけの再試行タイミング（ms）。前面化失敗時・タイル外のタッチ終了時に使う */
export const POINTER_REVEAL_RETRY_DELAYS_MS: readonly number[] = [0, 300];

export type WarpAttempt = "warped" | "revealed" | "kept" | "failed";

export interface WarpEvent {
  kind: "retry" | "failed" | "final";
  attempt: number;
  delayMs: number;
  message: string;
}

export interface PointerWarperDeps {
  port: PointerPort;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function pointInRect(pt: Point, rc: Rect): boolean {
  return pt.x >= rc.left && pt.x < rc.right && pt.y >= rc.top && pt.y < rc.bottom;
}

export function describePointerState(state: PointerState | null, rc: Rect | null): string {
  if (state === null) return "状態取得失敗";
  const inside = rc === null ? "矩形不明" : pointInRect(state.pos, rc) ? "対象内" : "対象外";
  const flags = state.flags;
  const visible = flags === null ? "表示状態不明" : (flags & CURSOR_SUPPRESSED) !== 0 ? "タッチで抑制中" : (flags & CURSOR_SHOWING) !== 0 ? "表示中" : "非表示";
  const native = state.hasCursorShape === undefined ? "" : ` [flags=${flags}, shape=${state.hasCursorShape ? "あり" : "なし"}, foregroundPid=${state.foregroundPid ?? 0}, pointerPid=${state.pointerWindowPid ?? 0}]`;
  return `(${state.pos.x},${state.pos.y}) ${inside} / ${visible}${native}`;
}

/**
 * ポインター移動の予約を一元管理する。新しい要求が来たら前の予約を取り消す（260925_2）。
 * 取り消さないと、1 秒以内に別のタイルを押した時に前の予約が「前のウィンドウの外にいる」と判断して
 * 今は背面に回ったウィンドウへ引き戻してしまう
 */
export class PointerWarper {
  private readonly port: PointerPort;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private pending = new Set<unknown>();
  private generation = 0;

  constructor(deps: PointerWarperDeps) {
    this.port = deps.port;
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return t;
    });
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** 進行中の予約をすべて取り消す */
  cancel(): void {
    for (const h of this.pending) this.clearTimer(h);
    this.pending.clear();
    this.port.cancelJiggle();
    this.generation += 1;
  }

  /**
   * 対象ウィンドウの中央へ移す。即時 1 回 + 遅延つき再試行（まだ矩形外にいる時だけ移し直す。
   * すでに中にいるなら再配置せず、非表示の場合だけ再表示する）。
   * 最後の試行から 100ms 後に GetCursorInfo の状態を final として報告する（診断用）
   */
  warpTo(handle: unknown, onEvent?: (ev: WarpEvent) => void): void {
    this.cancel();
    const gen = this.generation;
    let attempts = 0;
    const last = POINTER_WARP_RETRY_DELAYS_MS[POINTER_WARP_RETRY_DELAYS_MS.length - 1];
    for (const delay of POINTER_WARP_RETRY_DELAYS_MS) {
      const run = (): void => {
        if (gen !== this.generation) return;
        attempts += 1;
        const outcome = this.warpOnce(handle, delay > 0, () => {
          if (gen !== this.generation) return;
          onEvent?.({ kind: "failed", attempt: attempts, delayMs: delay, message: "ポインターの戻し入力に失敗" });
        });
        if (outcome === "warped" && delay > 0) {
          onEvent?.({ kind: "retry", attempt: attempts, delayMs: delay, message: `ポインター移動をやり直し ${attempts} 回目（${delay}ms 後、まだ対象の外だった）` });
        } else if (outcome === "revealed") {
          onEvent?.({ kind: "retry", attempt: attempts, delayMs: delay, message: `ポインター再表示をやり直し ${attempts} 回目（${delay}ms 後、対象内だが非表示だった）` });
        } else if (outcome === "failed") {
          onEvent?.({ kind: "failed", attempt: attempts, delayMs: delay, message: `ポインター移動に失敗（${delay}ms 後）` });
        }
        if (delay === last) {
          // 擬似入力の送信直後ではなく、OS が入力を処理する猶予を置いて観測する。
          this.schedule(() => {
            if (gen !== this.generation) return;
            onEvent?.({ kind: "final", attempt: attempts, delayMs: delay + 100, message: `ポインター最終状態: ${describePointerState(this.port.cursor(), this.port.windowRect(handle))}` });
          }, 100);
        }
      };
      this.schedule(run, delay);
    }
  }

  /**
   * 位置は変えず再表示だけする（前面化失敗時・タイル外のタッチ終了時）。
   * 進行中の warpTo は取り消さない（タイルを押した直後の pointerup で warp を消さないため）
   */
  reveal(onEvent?: (ev: WarpEvent) => void): void {
    const gen = this.generation;
    let attempts = 0;
    const last = POINTER_REVEAL_RETRY_DELAYS_MS[POINTER_REVEAL_RETRY_DELAYS_MS.length - 1];
    for (const delay of POINTER_REVEAL_RETRY_DELAYS_MS) {
      const run = (): void => {
        if (gen !== this.generation) return;
        attempts += 1;
        const before = this.port.cursor();
        // すでに表示中で抑制もされていないなら触らない
        if (before !== null && before.flags !== null && (before.flags & CURSOR_SUPPRESSED) === 0 && (before.flags & CURSOR_SHOWING) !== 0) {
          if (delay === last) onEvent?.({ kind: "final", attempt: attempts, delayMs: delay, message: `ポインター再表示: 不要（${describePointerState(before, null)}）` });
          return;
        }
        const failed = (): void => {
          if (gen !== this.generation) return;
          onEvent?.({ kind: "failed", attempt: attempts, delayMs: delay, message: "ポインター再表示の入力に失敗" });
        };
        try {
          this.port.jiggle(failed);
        } catch {
          failed();
        }
        if (delay === last) {
          this.schedule(() => {
            if (gen !== this.generation) return;
            onEvent?.({ kind: "final", attempt: attempts, delayMs: delay + 100, message: `ポインター再表示 ${attempts} 回: ${describePointerState(this.port.cursor(), null)}` });
          }, 100);
        }
      };
      this.schedule(run, delay);
    }
  }

  private schedule(run: () => void, delay: number): void {
    if (delay === 0) {
      run();
      return;
    }
    const handle = this.setTimer(() => {
      this.pending.delete(handle);
      run();
    }, delay);
    this.pending.add(handle);
  }

  private warpOnce(handle: unknown, onlyIfOutside: boolean, onPulseFailure: () => void): WarpAttempt {
    try {
      const rc = this.port.windowRect(handle);
      if (rc === null) return "failed";
      if (onlyIfOutside) {
        const state = this.port.cursor();
        if (state !== null && pointInRect(state.pos, rc)) {
          // flags=0（通常の非表示）も回復対象。位置が正しくても表示は別に判定する。
          if (state.flags !== null && ((state.flags & CURSOR_SHOWING) === 0 || (state.flags & CURSOR_SUPPRESSED) !== 0)) {
            this.port.jiggle(onPulseFailure);
            return "revealed";
          }
          return "kept";
        }
      }
      this.port.setCursorPos(Math.round((rc.left + rc.right) / 2), Math.round((rc.top + rc.bottom) / 2));
      // SetCursorPos だけではタッチで隠れたポインターが再表示されないため、擬似マウス移動で再表示させる
      this.port.jiggle(onPulseFailure);
      return "warped";
    } catch {
      return "failed";
    }
  }
}
