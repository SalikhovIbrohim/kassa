import { describe, expect, it } from "vitest";
import { ConcurrencyGate, GateFullError } from "../src/concurrency-gate.js";

/** A task that stays unfinished until the test says so. */
function deferredTask<T>(result: T) {
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const started: string[] = [];
  const done = new Promise<T>((resolve, reject) => {
    finish = () => resolve(result);
    fail = reject;
  });
  return { done, finish, fail, started };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("the gate on concurrent work", () => {
  it("runs exactly `running` tasks at once, queues exactly `maxWaiting`, and refuses the next", async () => {
    const gate = new ConcurrencyGate(2, 2);
    const started: number[] = [];
    const tasks = [0, 1, 2, 3, 4].map(() => deferredTask("ok"));
    const runs = tasks.slice(0, 4).map((task, index) =>
      gate.run(() => {
        started.push(index);
        return task.done;
      }),
    );
    await tick();

    expect(started).toEqual([0, 1]);
    await expect(gate.run(() => tasks[4]!.done)).rejects.toBeInstanceOf(GateFullError);

    tasks[0]!.finish();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    tasks[1]!.finish();
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    tasks[2]!.finish();
    tasks[3]!.finish();
    await Promise.all(runs);
  });

  it("serves the waiting in the order they came", async () => {
    const gate = new ConcurrencyGate(1, 3);
    const order: string[] = [];
    const first = deferredTask("a");
    const running = gate.run(() => first.done);
    const waiting = ["b", "c", "d"].map((name) =>
      gate.run(async () => {
        order.push(name);
        return name;
      }),
    );
    await tick();
    expect(order).toEqual([]);

    first.finish();
    await Promise.all([running, ...waiting]);

    expect(order).toEqual(["b", "c", "d"]);
  });

  it("gives a place back when a task fails, so the next one can run", async () => {
    const gate = new ConcurrencyGate(1, 1);
    const failing = deferredTask("never");
    const first = gate.run(() => failing.done);
    const second = gate.run(async () => "second");
    await tick();

    failing.fail(new Error("boom"));

    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("second");
    // Nothing is left occupied: two more fit again.
    const again = await Promise.all([gate.run(async () => 1), gate.run(async () => 2)]);
    expect(again).toEqual([1, 2]);
  });

  it("refuses at once when there is no room to wait at all", async () => {
    const gate = new ConcurrencyGate(1, 0);
    const held = deferredTask("x");
    const running = gate.run(() => held.done);
    await tick();

    await expect(gate.run(async () => "y")).rejects.toBeInstanceOf(GateFullError);

    held.finish();
    await running;
    await expect(gate.run(async () => "z")).resolves.toBe("z");
  });
});
