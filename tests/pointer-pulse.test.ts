import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { absoluteMousePoint, PointerPulse, POINTER_PULSE_HOLD_MS, type PointerPulsePort } from "../src/main/pointer-pulse";
import { PointerWarper, type Point, type PointerPort } from "../src/main/pointer-warp";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fixture(initial: Point = { x: 500, y: 400 }) {
  let position = { ...initial };
  const move = vi.fn((point: Point) => { position = { ...point }; });
  const port: PointerPulsePort = {
    position: () => ({ ...position }),
    monitorBounds: () => ({ left: 0, top: 0, right: 1000, bottom: 800 }),
    canMove: () => true,
    move,
  };
  return { port, move, pulse: new PointerPulse(port), userMove: (point: Point) => { position = point; } };
}

describe("PointerPulse", () => {
  it("往路と復路の間に処理時間を置き、元の座標へ戻る", () => {
    const f = fixture();
    const failed = vi.fn();
    f.pulse.start(failed);
    expect(f.move.mock.calls).toEqual([[{ x: 502, y: 400 }]]);
    vi.advanceTimersByTime(POINTER_PULSE_HOLD_MS - 1);
    expect(f.move).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(f.move.mock.calls).toEqual([[{ x: 502, y: 400 }], [{ x: 500, y: 400 }]]);
    expect(failed).not.toHaveBeenCalled();
  });

  it("ユーザーが移動したら引き戻さない", () => {
    const f = fixture();
    f.pulse.start(vi.fn());
    f.userMove({ x: 600, y: 450 });
    vi.advanceTimersByTime(100);
    expect(f.move).toHaveBeenCalledTimes(1);
    expect(f.port.position()).toEqual({ x: 600, y: 450 });
  });

  it("移動中にボタンを押したら復路を送らない", () => {
    const f = fixture();
    f.pulse.start(vi.fn());
    f.port.canMove = () => false;
    vi.advanceTimersByTime(100);
    expect(f.move).toHaveBeenCalledTimes(1);
  });

  it("ボタン押下中は往路も送らない", () => {
    const f = fixture();
    f.port.canMove = () => false;
    f.pulse.start(vi.fn());
    vi.advanceTimersByTime(100);
    expect(f.move).not.toHaveBeenCalled();
  });

  it("重複要求で微動や戻しを重ねない", () => {
    const f = fixture();
    f.pulse.start(vi.fn());
    f.pulse.start(vi.fn());
    vi.advanceTimersByTime(100);
    expect(f.move).toHaveBeenCalledTimes(2);
    expect(f.port.position()).toEqual({ x: 500, y: 400 });
  });

  it("画面右端では隣の画面へ出ず左に動かす", () => {
    const f = fixture({ x: 999, y: 400 });
    f.pulse.start(vi.fn());
    expect(f.move).toHaveBeenCalledWith({ x: 997, y: 400 });
    vi.advanceTimersByTime(100);
    expect(f.port.position()).toEqual({ x: 999, y: 400 });
  });

  it("往路の送信失敗時に復路を予約しない", () => {
    const f = fixture();
    f.port.move = () => { throw new Error("SendInput failed"); };
    expect(() => f.pulse.start(vi.fn())).toThrow("SendInput failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("復路の失敗を呼出元に通知し、非同期例外にしない", () => {
    const f = fixture();
    const failed = vi.fn();
    f.pulse.start(failed);
    f.port.move = () => { throw new Error("SendInput failed"); };
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("実際の Warper で次のタップが古い復路を取り消す", () => {
    const f = fixture();
    const port: PointerPort = {
      windowRect: (handle) => handle === "A"
        ? { left: 0, top: 0, right: 400, bottom: 400 }
        : { left: 400, top: 0, right: 800, bottom: 400 },
      cursor: () => ({ pos: f.port.position()!, flags: 0 }),
      setCursorPos: (x, y) => f.userMove({ x, y }),
      jiggle: (failed) => f.pulse.start(failed),
      cancelJiggle: () => f.pulse.cancel(),
    };
    const warper = new PointerWarper({ port });
    warper.warpTo("A");
    vi.advanceTimersByTime(30);
    warper.warpTo("B");
    vi.advanceTimersByTime(60);
    expect(f.move.mock.calls).toEqual([
      [{ x: 202, y: 200 }], [{ x: 602, y: 200 }], [{ x: 600, y: 200 }],
    ]);
    warper.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("absoluteMousePoint", () => {
  it("負原点・混在解像度の仮想画面で、元の物理ピクセルに復号できる", () => {
    const desktop = { left: -2160, top: -1047, right: 7680, bottom: 2880 };
    const points = [{ x: -2160, y: -1047 }, { x: -1, y: -1 }, { x: 0, y: 0 }, { x: 1920, y: 1044 }, { x: 7679, y: 2879 }];
    for (const point of points) {
      const absolute = absoluteMousePoint(point, desktop);
      expect({
        x: Math.floor(absolute.x * (desktop.right - desktop.left) / 65536) + desktop.left,
        y: Math.floor(absolute.y * (desktop.bottom - desktop.top) / 65536) + desktop.top,
      }).toEqual(point);
    }
  });

  it("不正な画面範囲・範囲外座標では入力を作らない", () => {
    expect(() => absoluteMousePoint({ x: 10, y: 0 }, { left: 0, top: 0, right: 0, bottom: 10 })).toThrow();
    expect(() => absoluteMousePoint({ x: -1, y: 0 }, { left: 0, top: 0, right: 10, bottom: 10 })).toThrow();
  });

  it.each([40000, 65535, 65536])("大きい仮想画面でも隣のピクセルに丸め落とさない（幅=%i）", (width) => {
    const desktop = { left: -1000, top: 0, right: width - 1000, bottom: 800 };
    for (const offset of [0, 1, 8, Math.floor(width / 2), width - 1]) {
      const absolute = absoluteMousePoint({ x: offset - 1000, y: 400 }, desktop);
      expect(Math.floor(absolute.x * width / 65536)).toBe(offset);
    }
  });
});
