/* ux F1 (fixer): a focused grid cell that nobody is typing in does not hold back newer versions. */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type Handler = (e: unknown) => void;
const listeners = new Map<string, Handler[]>();
const fire = (type: string, e: unknown = {}) => { for (const h of listeners.get(type) ?? []) h(e); };

const input = { tagName: "INPUT", isContentEditable: false };
const region = { contains: (x: unknown) => x === input };
const doc = {
  activeElement: input as unknown,
  focused: true,
  open: false,
  hasFocus() { return this.focused; },
  querySelector(sel: string) {
    if (sel.includes('aria-label="Graphs"')) return region;
    return this.open ? {} : null;
  },
};

beforeAll(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  (globalThis as Record<string, unknown>).window = {
    addEventListener: (type: string, h: Handler) => { listeners.set(type, [...(listeners.get(type) ?? []), h]); },
  };
  (globalThis as Record<string, unknown>).document = doc;
});
afterAll(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).document;
});

describe("domInteractionBusy", () => {
  it("a focused cell is busy only while it is being typed in", async () => {
    const { domInteractionBusy, TYPING_QUIET_MS } = await import("./session");
    // The caret rests in a cell (after Enter the grid focuses the next one): not busy.
    expect(domInteractionBusy()).toBe(false);
    fire("keydown");
    expect(domInteractionBusy()).toBe(true);
    vi.advanceTimersByTime(TYPING_QUIET_MS + 10);
    expect(domInteractionBusy()).toBe(false);
    // An input method composing is busy however long it takes.
    fire("compositionstart");
    vi.advanceTimersByTime(TYPING_QUIET_MS * 3);
    expect(domInteractionBusy()).toBe(true);
    fire("compositionend");
    vi.advanceTimersByTime(TYPING_QUIET_MS + 10);
    expect(domInteractionBusy()).toBe(false);
    // Typing just now, but the window doesn't have the keyboard: not busy.
    fire("input");
    doc.focused = false;
    expect(domInteractionBusy()).toBe(false);
    doc.focused = true;
    expect(domInteractionBusy()).toBe(true);
  });

  it("a mouse button held down and an open menu stay busy", async () => {
    const { domInteractionBusy, TYPING_QUIET_MS } = await import("./session");
    vi.advanceTimersByTime(TYPING_QUIET_MS + 10);
    expect(domInteractionBusy()).toBe(false);
    fire("pointerdown", { button: 0 });
    expect(domInteractionBusy()).toBe(true);
    fire("pointerup");
    expect(domInteractionBusy()).toBe(false);
    doc.open = true;
    expect(domInteractionBusy()).toBe(true);
    doc.open = false;
  });
});
