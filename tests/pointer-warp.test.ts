import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURSOR_SHOWING,
  CURSOR_SUPPRESSED,
  POINTER_WARP_RETRY_DELAYS_MS,
  PointerWarper,
  describePointerState,
  pointInRect,
  type PointerPort,
  type PointerState,
  type WarpEvent,
} from "../src/main/pointer-warp";

// タッチ後のポインター迷子対策（260925_1 / 260925_2）

const RECT_A = { left: 0, top: 0, right: 1000, bottom: 800 };
const RECT_B = { left: 2000, top: 0, right: 3000, bottom: 800 };

/** 擬似 Win32。ポインター位置と抑制フラグを保持し、jiggle で抑制が解ける */
function fakePort(initial: PointerState): { port: PointerPort; state: PointerState; calls: string[] } {
  const state: PointerState = { pos: { ...initial.pos }, flags: initial.flags };
  const calls: string[] = [];
  const rects: Record<string, typeof RECT_A> = { A: RECT_A, B: RECT_B };
  const port: PointerPort = {
    cancelJiggle: () => {},
    windowRect: (h) => rects[h as string] ?? null,
    cursor: () => ({ pos: { ...state.pos }, flags: state.flags }),
    setCursorPos: (x, y) => {
      calls.push(`set:${x},${y}`);
      state.pos = { x, y };
    },
    jiggle: () => {
      calls.push("jiggle");
      if (state.flags !== null) state.flags = (state.flags & ~CURSOR_SUPPRESSED) | CURSOR_SHOWING;
    },
  };
  return { port, state, calls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("pointInRect", () => {
  it("矩形内なら true、右端・下端は含まない", () => {
    expect(pointInRect({ x: 200, y: 300 }, RECT_A)).toBe(true);
    expect(pointInRect({ x: 1000, y: 300 }, RECT_A)).toBe(false);
    expect(pointInRect({ x: -1, y: 300 }, RECT_A)).toBe(false);
  });
});

describe("POINTER_WARP_RETRY_DELAYS_MS", () => {
  it("即時 1 回 + 遅延つき再試行で、昇順かつ 1 秒程度で終える", () => {
    expect(POINTER_WARP_RETRY_DELAYS_MS[0]).toBe(0);
    for (let i = 1; i < POINTER_WARP_RETRY_DELAYS_MS.length; i++) {
      expect(POINTER_WARP_RETRY_DELAYS_MS[i]).toBeGreaterThan(POINTER_WARP_RETRY_DELAYS_MS[i - 1]);
    }
    expect(POINTER_WARP_RETRY_DELAYS_MS.at(-1)).toBeLessThanOrEqual(1500);
  });
});

describe("PointerWarper.warpTo", () => {
  it("即時に中央へ移して再表示し、以後は矩形内にいれば触らない", () => {
    const { port, calls } = fakePort({ pos: { x: 5000, y: 5000 }, flags: CURSOR_SUPPRESSED });
    const events: WarpEvent[] = [];
    new PointerWarper({ port }).warpTo("A", (ev) => events.push(ev));
    expect(calls).toEqual(["set:500,400", "jiggle"]);
    vi.advanceTimersByTime(2000);
    expect(calls).toEqual(["set:500,400", "jiggle"]);
    expect(events.map((e) => e.kind)).toEqual(["final"]);
    expect(events[0].message).toContain("対象内");
    expect(events[0].message).toContain("表示中");
  });

  it("遅延後に矩形外へ戻されていたら移し直し、retry として報告する", () => {
    const { port, state, calls } = fakePort({ pos: { x: 5000, y: 5000 }, flags: CURSOR_SUPPRESSED });
    const events: WarpEvent[] = [];
    new PointerWarper({ port }).warpTo("A", (ev) => events.push(ev));
    // Windows の遅延メッセージがタッチ位置へ戻した想定
    state.pos = { x: 5000, y: 5000 };
    state.flags = CURSOR_SUPPRESSED;
    vi.advanceTimersByTime(150);
    expect(calls.filter((c) => c.startsWith("set:")).length).toBe(2);
    expect(events[0]).toMatchObject({ kind: "retry", attempt: 2, delayMs: 120 });
    vi.advanceTimersByTime(2000);
    expect(events.at(-1)?.kind).toBe("final");
  });

  it("新しいタップが来たら前の予約を取り消す（背面に回ったウィンドウへ引き戻さない）", () => {
    const { port, calls } = fakePort({ pos: { x: 5000, y: 5000 }, flags: CURSOR_SUPPRESSED });
    const w = new PointerWarper({ port });
    w.warpTo("A");
    vi.advanceTimersByTime(50);
    w.warpTo("B"); // 1 秒以内に別タイル
    vi.advanceTimersByTime(2000);
    // A の再試行が生きていれば B の中央（2500,400）は A の外なので set:500,400 が再び現れるはず
    expect(calls.filter((c) => c === "set:500,400").length).toBe(1);
    expect(calls.filter((c) => c === "set:2500,400").length).toBe(1);
  });

  it.each([0, CURSOR_SUPPRESSED])("対象内でも非表示が続けば各試行で再表示する（flags=%i）", (flags) => {
    const { port, state, calls } = fakePort({ pos: { x: 5000, y: 5000 }, flags: CURSOR_SUPPRESSED });
    const events: WarpEvent[] = [];
    // jiggle が効かない環境を模す（抑制が解けない）
    port.jiggle = () => {
      calls.push("jiggle");
      state.flags = flags;
    };
    new PointerWarper({ port }).warpTo("A", (ev) => events.push(ev));
    vi.advanceTimersByTime(2000);
    expect(calls.filter((c) => c === "jiggle").length).toBe(5);
    expect(calls.filter((c) => c.startsWith("set:"))).toEqual(["set:500,400"]);
    expect(events.at(-1)?.message).toContain(flags === 0 ? "非表示" : "タッチで抑制中");
  });

  it("最後の再表示が非同期に反映された状態を報告する", () => {
    const { port, state } = fakePort({ pos: { x: 500, y: 400 }, flags: 0 });
    const events: WarpEvent[] = [];
    port.jiggle = () => {
      if (Date.now() >= start + 1000) {
        setTimeout(() => { state.flags = CURSOR_SHOWING; }, 50);
      }
    };
    const start = Date.now();
    new PointerWarper({ port }).warpTo("A", (ev) => events.push(ev));
    vi.advanceTimersByTime(1000);
    expect(events.some((e) => e.kind === "final")).toBe(false);
    vi.advanceTimersByTime(100);
    expect(events.at(-1)).toMatchObject({ kind: "final", delayMs: 1100 });
    expect(events.at(-1)?.message).toContain("表示中");
  });

  it("次のタップは前の最終観測も取り消す", () => {
    const { port } = fakePort({ pos: { x: 500, y: 400 }, flags: CURSOR_SHOWING });
    const events: WarpEvent[] = [];
    const w = new PointerWarper({ port });
    w.warpTo("A", (ev) => events.push(ev));
    vi.advanceTimersByTime(1000);
    w.warpTo("B");
    vi.advanceTimersByTime(2000);
    expect(events.some((e) => e.kind === "final")).toBe(false);
  });

  it("矩形が取れなければ failed を報告し、例外を投げない", () => {
    const { port } = fakePort({ pos: { x: 0, y: 0 }, flags: CURSOR_SHOWING });
    const events: WarpEvent[] = [];
    expect(() => new PointerWarper({ port }).warpTo("missing", (ev) => events.push(ev))).not.toThrow();
    expect(events[0].kind).toBe("failed");
    vi.advanceTimersByTime(2000);
  });
});

describe("PointerWarper.reveal", () => {
  it("最後の入力送信直後ではなく、非同期の再表示を待って観測する", () => {
    const { port, state } = fakePort({ pos: { x: 500, y: 400 }, flags: 0 });
    const start = Date.now();
    const events: WarpEvent[] = [];
    port.jiggle = () => {
      if (Date.now() >= start + 300) setTimeout(() => { state.flags = CURSOR_SHOWING; }, 70);
    };
    new PointerWarper({ port }).reveal((event) => events.push(event));
    vi.advanceTimersByTime(300);
    expect(events.some((event) => event.kind === "final")).toBe(false);
    vi.advanceTimersByTime(100);
    expect(events.at(-1)).toMatchObject({ kind: "final", delayMs: 400 });
    expect(events.at(-1)?.message).toContain("表示中");
  });

  it("入力送信失敗を通知し、タイマーから例外を漏らさない", () => {
    const { port } = fakePort({ pos: { x: 500, y: 400 }, flags: 0 });
    const events: WarpEvent[] = [];
    port.jiggle = () => { throw new Error("SendInput failed"); };
    expect(() => new PointerWarper({ port }).reveal((event) => events.push(event))).not.toThrow();
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(events.filter((event) => event.kind === "failed")).toHaveLength(2);
    expect(events.at(-1)?.message).toContain("非表示");
  });

  it("抑制中なら位置を変えずに再表示する", () => {
    const { port, state, calls } = fakePort({ pos: { x: 5000, y: 5000 }, flags: CURSOR_SUPPRESSED });
    const events: WarpEvent[] = [];
    new PointerWarper({ port }).reveal((ev) => events.push(ev));
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual(["jiggle"]);
    expect(state.pos).toEqual({ x: 5000, y: 5000 });
    expect(events.at(-1)?.message).toContain("表示中");
  });

  it("すでに表示中なら触らない", () => {
    const { port, calls } = fakePort({ pos: { x: 10, y: 10 }, flags: CURSOR_SHOWING });
    const events: WarpEvent[] = [];
    new PointerWarper({ port }).reveal((ev) => events.push(ev));
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual([]);
    expect(events.at(-1)?.message).toContain("不要");
  });

  it("warpTo の後に reveal が届いても移動の再試行を取り消さない", () => {
    const { port, state, calls } = fakePort({ pos: { x: 5000, y: 5000 }, flags: CURSOR_SUPPRESSED });
    const w = new PointerWarper({ port });
    w.warpTo("A");
    w.reveal();
    state.pos = { x: 5000, y: 5000 };
    vi.advanceTimersByTime(2000);
    expect(calls.filter((c) => c === "set:500,400").length).toBeGreaterThan(1);
  });

  it("pointerup → click の順で reveal が取り消されても warpTo が再表示を引き継ぐ", () => {
    const { port, state, calls } = fakePort({ pos: { x: 5000, y: 5000 }, flags: CURSOR_SUPPRESSED });
    const w = new PointerWarper({ port });
    w.reveal();
    w.warpTo("A");
    // タッチ処理が遅れて非表示に戻す。ユーザーが対象内で動かした位置は維持する。
    state.pos = { x: 700, y: 600 };
    state.flags = 0;
    vi.advanceTimersByTime(120);
    expect(state.flags).toBe(CURSOR_SHOWING);
    expect(state.pos).toEqual({ x: 700, y: 600 });
    expect(calls).toEqual(["jiggle", "set:500,400", "jiggle", "jiggle"]);
    vi.advanceTimersByTime(2000);
    expect(calls).toHaveLength(4);
  });
});

describe("describePointerState", () => {
  it("位置・矩形内外・表示状態を 1 行にする", () => {
    expect(describePointerState({ pos: { x: 1, y: 2 }, flags: CURSOR_SHOWING }, RECT_A)).toBe("(1,2) 対象内 / 表示中");
    expect(describePointerState({ pos: { x: 1, y: 2 }, flags: CURSOR_SUPPRESSED }, RECT_B)).toBe("(1,2) 対象外 / タッチで抑制中");
    expect(describePointerState({ pos: { x: 1, y: 2 }, flags: null }, null)).toBe("(1,2) 矩形不明 / 表示状態不明");
    expect(describePointerState(null, null)).toBe("状態取得失敗");
  });
});
