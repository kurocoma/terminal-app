import type { Point, Rect } from "./pointer-warp";

/** 往復を同じメッセージ処理にまとめないための間隔。 */
export const POINTER_PULSE_HOLD_MS = 60;

export interface PointerPulsePort {
  position(): Point | null;
  monitorBounds(point: Point): Rect | null;
  canMove(): boolean;
  move(point: Point): void;
}

/** 負座標を含む仮想デスクトップ上のピクセル中央を SendInput の絶対座標へ変換する。 */
export function absoluteMousePoint(point: Point, desktop: Rect): Point {
  const width = desktop.right - desktop.left;
  const height = desktop.bottom - desktop.top;
  if (![point.x, point.y, desktop.left, desktop.top, width, height].every(Number.isInteger)
    || width <= 0 || height <= 0 || width > 65536 || height > 65536
    || point.x < desktop.left || point.x >= desktop.right || point.y < desktop.top || point.y >= desktop.bottom) {
    throw new Error("Invalid absolute mouse coordinates");
  }
  // 32768px を超える仮想画面では「中央を切り捨てる」だけだと前のピクセルへ落ちる。
  const normalize = (offset: number, span: number): number => Math.max(
    Math.ceil(offset * 65536 / span),
    Math.min(65535, Math.floor((offset + 0.5) * 65536 / span)),
  );
  return { x: normalize(point.x - desktop.left, width), y: normalize(point.y - desktop.top, height) };
}

/** 非ゼロの移動を送り、ユーザーが動かしていなければ時間を空けて戻す。 */
export class PointerPulse {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor(private readonly port: PointerPulsePort) {}

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.generation += 1;
  }

  start(onFailure: () => void): void {
    // pointerup と click が近接しても、複数の往復を重ねない。
    if (this.timer !== null || !this.port.canMove()) return;
    const origin = this.port.position();
    const bounds = origin === null ? null : this.port.monitorBounds(origin);
    if (origin === null || bounds === null || origin.x < bounds.left || origin.x >= bounds.right
      || origin.y < bounds.top || origin.y >= bounds.bottom) throw new Error("Pointer position unavailable");
    const target = { ...origin };
    if (origin.x + 2 < bounds.right) target.x += 2;
    else if (origin.x - 2 >= bounds.left) target.x -= 2;
    else if (origin.y + 2 < bounds.bottom) target.y += 2;
    else if (origin.y - 2 >= bounds.top) target.y -= 2;
    else throw new Error("Monitor too small for pointer pulse");
    this.port.move(target);
    const gen = this.generation;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (gen !== this.generation) return;
      try {
        const current = this.port.position();
        // 実マウス・別操作・OS によって位置が変わっていたら引き戻さない。
        if (current?.x === target.x && current.y === target.y && this.port.canMove()) this.port.move(origin);
      } catch {
        onFailure();
      }
    }, POINTER_PULSE_HOLD_MS);
    this.timer.unref?.();
  }
}
