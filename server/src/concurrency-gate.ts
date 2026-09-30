/** The gate is full and nobody else may queue: turn the request away. */
export class GateFullError extends Error {
  constructor() {
    super("Too many tasks running and waiting");
  }
}

/**
 * Lets at most `running` tasks run at once and `maxWaiting` more wait their turn, in
 * order. Anything beyond that is refused at once, so a flood cannot pile up work or
 * memory. Used for password checks, which are deliberately heavy (about 100 ms and
 * 32 MB each).
 */
export class ConcurrencyGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly running: number,
    private readonly maxWaiting: number,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.running) {
      this.active += 1;
    } else if (this.waiting.length < this.maxWaiting) {
      // The finishing task hands its place over, so `active` stays as it is.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      throw new GateFullError();
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}
