import { describe, expect, it } from "vitest";
import { ownBackButton } from "./telegram";

/** Telegram's back button, as much of it as the stack of its owners touches. */
function fakeApp() {
  const handlers = new Set<() => void>();
  const log: string[] = [];
  const app = {
    BackButton: {
      show: () => log.push("show"),
      hide: () => log.push("hide"),
      onClick: (handler: () => void) => handlers.add(handler),
      offClick: (handler: () => void) => handlers.delete(handler),
    },
  };
  return { app: app as never, log, press: () => handlers.forEach((handler) => handler()), listening: () => handlers.size };
}

describe("Telegram's back button", () => {
  it("belongs to the last one who took it, and goes back to the one before when that one is gone", () => {
    const { app, log, press, listening } = fakeApp();
    const heard: string[] = [];
    // A section opened from «Настройки», then a window over it, then a window over that.
    const section = ownBackButton({ back: () => heard.push("section") }, app);
    const first = ownBackButton({ back: () => heard.push("first window") }, app);
    const second = ownBackButton({ back: () => heard.push("second window") }, app);
    // Shown once, with one handler, however many own it.
    expect(log).toEqual(["show"]);
    expect(listening()).toBe(1);

    press();
    second();
    press();
    first();
    press();
    expect(heard).toEqual(["second window", "first window", "section"]);
    expect(log).toEqual(["show"]);

    // Nobody left: hidden, and nothing listens.
    section();
    expect(log).toEqual(["show", "hide"]);
    expect(listening()).toBe(0);
    press();
    expect(heard).toHaveLength(3);
  });

  it("stays with the window on top when one under it closes first", () => {
    const { app, log, press } = fakeApp();
    const heard: string[] = [];
    const under = ownBackButton({ back: () => heard.push("under") }, app);
    const top = ownBackButton({ back: () => heard.push("top") }, app);
    under();
    press();
    expect(heard).toEqual(["top"]);
    // Given back twice: no harm.
    under();
    top();
    top();
    expect(log).toEqual(["show", "hide"]);
  });
});
