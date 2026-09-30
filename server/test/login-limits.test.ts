import { afterEach, describe, expect, it } from "vitest";
import { get } from "./helpers/http.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

const START = new Date("2026-01-10T09:00:00Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;

function after(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

// Every wrong or right password costs a real password check (about 100 ms), and some tests make
// twenty of them, so this file gets more time than the default five seconds.
describe("protecting the login from password guessing", { timeout: 30_000 }, () => {
  let app: TestApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  type Options = Parameters<typeof startTestApp>[0];

  async function startedApp(options: Options = {}) {
    const started = await startTestApp(options);
    started.setNow(START);
    await started.admin.createUser({ login: "ivan", password: "correct horse", role: "cashier" });
    await started.admin.createUser({ login: "owner", password: "long enough pass", role: "viewer" });
    app = started;
    return started;
  }

  /** One login attempt. `from` is the address a trusted proxy reports the client to have. */
  function attempt(started: TestApp, login: string, password: string, from?: string) {
    return fetch(`${started.baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(from ? { "x-forwarded-for": from } : {}) },
      body: JSON.stringify({ login, password }),
    });
  }

  async function wrongAttempts(started: TestApp, count: number, login = "ivan", from?: string) {
    const statuses: number[] = [];
    for (let i = 0; i < count; i++) {
      statuses.push((await attempt(started, login, "wrong horse", from)).status);
    }
    return statuses;
  }

  async function refusal(response: Response) {
    return { status: response.status, retryAfterHeader: response.headers.get("retry-after"), body: await response.json() };
  }

  describe("per login", () => {
    it("lets five wrong attempts in a row be answered as usual, then says how long to wait", async () => {
      const started = await startedApp();

      const first = await wrongAttempts(started, 5);
      const sixth = await refusal(await attempt(started, "ivan", "wrong horse"));

      expect(first).toEqual([401, 401, 401, 401, 401]);
      expect(sixth).toEqual({
        status: 429,
        retryAfterHeader: "30",
        body: { error: "too_many_attempts", retryAfterSeconds: 30 },
      });
    });

    it("does not check the password while the person has to wait, even a right one", async () => {
      const started = await startedApp();
      await wrongAttempts(started, 5);

      const response = await attempt(started, "ivan", "correct horse");

      expect(response.status).toBe(429);
      expect(response.headers.getSetCookie()).toEqual([]);
    });

    it("counts the waiting time down as the clock moves", async () => {
      const started = await startedApp();
      await wrongAttempts(started, 5);

      started.setNow(after(START, 10 * SECOND));
      const tenSecondsLater = await refusal(await attempt(started, "ivan", "wrong horse"));
      started.setNow(after(START, 29 * SECOND));
      const almostThere = await refusal(await attempt(started, "ivan", "wrong horse"));

      expect(tenSecondsLater.body.retryAfterSeconds).toBe(20);
      expect(almostThere.body.retryAfterSeconds).toBe(1);
    });

    it("lets the person try again once the wait is over, and makes the next wait twice as long", async () => {
      const started = await startedApp();
      await wrongAttempts(started, 5);

      started.setNow(after(START, 30 * SECOND));
      const sixth = await attempt(started, "ivan", "wrong horse");
      const seventh = await refusal(await attempt(started, "ivan", "wrong horse"));

      expect(sixth.status).toBe(401);
      expect(seventh.status).toBe(429);
      expect(seventh.body.retryAfterSeconds).toBe(60);
    });

    it("keeps doubling the wait up to fifteen minutes and never beyond", async () => {
      const started = await startedApp();
      await wrongAttempts(started, 5);
      let clock = START;
      const waits: number[] = [];

      for (let round = 0; round < 8; round++) {
        const blocked = await refusal(await attempt(started, "ivan", "wrong horse"));
        waits.push(blocked.body.retryAfterSeconds);
        clock = after(clock, blocked.body.retryAfterSeconds * SECOND);
        started.setNow(clock);
        expect((await attempt(started, "ivan", "wrong horse")).status).toBe(401);
      }

      expect(waits).toEqual([30, 60, 120, 240, 480, 900, 900, 900]);
    });

    it("does not lengthen the wait when attempts keep arriving during it", async () => {
      const started = await startedApp();
      await wrongAttempts(started, 5);

      const hammering = await Promise.all(Array.from({ length: 15 }, () => attempt(started, "ivan", "wrong horse")));
      started.setNow(after(START, 30 * SECOND));
      const afterTheWait = await attempt(started, "ivan", "correct horse");

      expect(hammering.map((response) => response.status)).toEqual(Array(15).fill(429));
      expect(afterTheWait.status).toBe(200);
    });

    it("starts counting again from zero after a right password", async () => {
      const started = await startedApp();
      await wrongAttempts(started, 4);

      expect((await attempt(started, "ivan", "correct horse")).status).toBe(200);
      const again = await wrongAttempts(started, 5);

      expect(again).toEqual([401, 401, 401, 401, 401]);
    });

    it("forgets old failures by itself after thirty quiet minutes", async () => {
      const started = await startedApp();
      await wrongAttempts(started, 8);

      started.setNow(after(START, 30 * MINUTE));
      const fresh = await wrongAttempts(started, 5);
      const sixth = await attempt(started, "ivan", "wrong horse");

      expect(fresh).toEqual([401, 401, 401, 401, 401]);
      expect(sixth.status).toBe(429);
    });

    it("does not forget them sooner: a slow guesser gets no fresh start", async () => {
      const started = await startedApp();
      await wrongAttempts(started, 5);

      started.setNow(after(START, 29 * MINUTE));
      const sixthGuess = await wrongAttempts(started, 1);
      started.setNow(after(START, 29 * MINUTE + 10 * SECOND));
      const blockedAgain = await attempt(started, "ivan", "wrong horse");

      expect(sixthGuess).toEqual([401]);
      expect(blockedAgain.status).toBe(429);
    });

    it("limits a login that does not exist in exactly the same way, so the answers reveal nothing", async () => {
      const started = await startedApp();

      const real = [...(await wrongAttempts(started, 5, "ivan")), await refusal(await attempt(started, "ivan", "x"))];
      const fake = [...(await wrongAttempts(started, 5, "nobody")), await refusal(await attempt(started, "nobody", "x"))];

      expect(fake).toEqual(real);
    });

    it("counts a login once however it is written: capitals and surrounding spaces", async () => {
      const started = await startedApp();

      await attempt(started, "ivan", "wrong horse");
      await attempt(started, "IVAN", "wrong horse");
      await attempt(started, " Ivan ", "wrong horse");
      await attempt(started, "iVaN", "wrong horse");
      await attempt(started, "ivan ", "wrong horse");
      const sixth = await attempt(started, "IVAN", "wrong horse");

      expect(sixth.status).toBe(429);
    });

    it("does not hold back anyone else: another login is not affected", async () => {
      const started = await startedApp();
      await wrongAttempts(started, 6);

      const other = await attempt(started, "owner", "long enough pass");

      expect(other.status).toBe(200);
    });

    it("leaves sessions that already exist alone", async () => {
      const started = await startedApp();
      const loggedIn = await attempt(started, "ivan", "correct horse");
      const cookie = loggedIn.headers.getSetCookie()[0]!.split(";")[0]!;
      await wrongAttempts(started, 6);

      const me = await get(started, "/api/me", cookie);

      expect(me.status).toBe(200);
    });

    it("does not count a request that is not a login attempt at all", async () => {
      const started = await startedApp();
      for (let i = 0; i < 10; i++) {
        const malformed = await fetch(`${started.baseUrl}/api/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ login: "ivan" }),
        });
        expect(malformed.status).toBe(400);
      }

      expect(await wrongAttempts(started, 5)).toEqual([401, 401, 401, 401, 401]);
    });

    it("allows no more than five guesses even when they all arrive at once", async () => {
      const started = await startedApp();

      const burst = await Promise.all(Array.from({ length: 12 }, () => attempt(started, "ivan", "wrong horse")));

      const statuses = burst.map((response) => response.status).sort();
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429, 429, 429, 429, 429]);
    });
  });

  describe("per address", () => {
    const proxy = { trustProxy: "127.0.0.1" };

    it("slows down one address that tries many logins, though each login is tried only once", async () => {
      const started = await startedApp(proxy);

      for (let i = 0; i < 20; i++) {
        expect((await attempt(started, `guess-${i}`, "password123", "203.0.113.7")).status).toBe(401);
      }
      const next = await refusal(await attempt(started, "guess-20", "password123", "203.0.113.7"));

      expect(next).toEqual({
        status: 429,
        retryAfterHeader: "30",
        body: { error: "too_many_attempts", retryAfterSeconds: 30 },
      });
    });

    it("leaves other addresses alone", async () => {
      const started = await startedApp(proxy);
      for (let i = 0; i < 21; i++) await attempt(started, `guess-${i}`, "password123", "203.0.113.7");

      const elsewhere = await attempt(started, "ivan", "correct horse", "198.51.100.4");

      expect(elsewhere.status).toBe(200);
    });

    it("lets a colleague behind the same address in while they are not guessing, as long as the address is under its limit", async () => {
      const started = await startedApp(proxy);
      await wrongAttempts(started, 4, "ivan", "203.0.113.7");

      const colleague = await attempt(started, "owner", "long enough pass", "203.0.113.7");

      expect(colleague.status).toBe(200);
    });

    it("is not reset by a successful login from the same address", async () => {
      const started = await startedApp(proxy);
      for (let i = 0; i < 19; i++) await attempt(started, `guess-${i}`, "password123", "203.0.113.7");
      expect((await attempt(started, "ivan", "correct horse", "203.0.113.7")).status).toBe(200);
      expect((await attempt(started, "guess-x", "password123", "203.0.113.7")).status).toBe(401);

      const next = await attempt(started, "guess-y", "password123", "203.0.113.7");

      expect(next.status).toBe(429);
    });

    it("does not spend an address's allowance on the logins that succeed", async () => {
      const started = await startedApp(proxy);
      for (let i = 0; i < 22; i++) {
        expect((await attempt(started, "ivan", "correct horse", "203.0.113.7")).status).toBe(200);
      }

      expect((await attempt(started, "ivan", "wrong horse", "203.0.113.7")).status).toBe(401);
    });

    it("takes the client address from the proxy, not from what the client claims", async () => {
      const started = await startedApp(proxy);

      // The client invents a different address each time; the proxy appends the real one.
      for (let i = 0; i < 20; i++) {
        await attempt(started, `guess-${i}`, "password123", `10.0.0.${i}, 203.0.113.7`);
      }
      const next = await attempt(started, "guess-20", "password123", "10.0.0.99, 203.0.113.7");

      expect(next.status).toBe(429);
    });

    it("counts an IPv6 client by its /64 network, so moving within it does not start over", async () => {
      const started = await startedApp(proxy);

      for (let i = 0; i < 20; i++) {
        await attempt(started, `guess-${i}`, "password123", `2001:db8:1:2:${i}::${i + 1}`);
      }
      const sameNetwork = await attempt(started, "guess-20", "password123", "2001:db8:1:2:ffff::9");
      const otherNetwork = await attempt(started, "guess-21", "password123", "2001:db8:1:3::1");

      expect(sameNetwork.status).toBe(429);
      expect(otherNetwork.status).toBe(401);
    });

    it("counts an IPv4 address written as IPv6 the same as plain IPv4", async () => {
      const started = await startedApp(proxy);

      for (let i = 0; i < 20; i++) {
        await attempt(started, `guess-${i}`, "password123", i % 2 === 0 ? "203.0.113.7" : "::ffff:203.0.113.7");
      }
      const next = await attempt(started, "guess-20", "password123", "203.0.113.7");

      expect(next.status).toBe(429);
    });

    it("ignores the header altogether unless a proxy is trusted", async () => {
      const started = await startedApp();

      for (let i = 0; i < 20; i++) {
        await attempt(started, `guess-${i}`, "password123", `10.0.0.${i}`);
      }
      const next = await attempt(started, "guess-20", "password123", "10.0.0.99");

      expect(next.status).toBe(429);
    });
  });

  describe("limiting the password checks that run at the same time", () => {
    it("answers 503 to what does not fit, without failing the ones that do, and recovers", async () => {
      const started = await startedApp({
        trustProxy: "127.0.0.1",
        loginProtection: { passwordChecks: { running: 1, waiting: 1 } },
      });

      const burst = await Promise.all(
        Array.from({ length: 12 }, (_, i) => attempt(started, `user-${i}`, "password123", `198.51.100.${i}`)),
      );
      const statuses = burst.map((response) => response.status);

      expect(statuses.every((status) => status === 401 || status === 503)).toBe(true);
      expect(statuses.filter((status) => status === 401).length).toBeGreaterThanOrEqual(2);
      expect(statuses.filter((status) => status === 503).length).toBeGreaterThanOrEqual(1);
      const refused = burst.find((response) => response.status === 503)!;
      expect(refused.headers.get("retry-after")).toBe("2");
      expect(await refused.json()).toEqual({ error: "busy", retryAfterSeconds: 2 });

      const afterwards = await attempt(started, "ivan", "correct horse", "198.51.100.200");
      expect(afterwards.status).toBe(200);
    });

    it("does not count a refused attempt against the person who sent it", async () => {
      const started = await startedApp({
        trustProxy: "127.0.0.1",
        loginProtection: { passwordChecks: { running: 1, waiting: 0 } },
      });
      const burst = await Promise.all(
        Array.from({ length: 10 }, (_, i) => attempt(started, `user-${i}`, "password123", "203.0.113.7")),
      );
      const refusedLogins = burst.flatMap((response, i) => (response.status === 503 ? [`user-${i}`] : []));
      expect(refusedLogins.length).toBeGreaterThan(0);

      // Each refused login still has its five free attempts (from other addresses, so the
      // address allowance is not what is being measured).
      const login = refusedLogins[0]!;
      const statuses = await wrongAttempts(started, 5, login, "192.0.2.50");

      expect(statuses).toEqual([401, 401, 401, 401, 401]);
    });
  });

  describe("memory", () => {
    it("remembers a bounded number of logins, forgetting the least recently tried", async () => {
      const started = await startedApp({ loginProtection: { maxTracked: 3 } });
      await wrongAttempts(started, 4, "ivan");

      // Three other logins push "ivan" out of a table that holds three.
      for (const other of ["a", "b", "c"]) await attempt(started, other, "password123");

      // "ivan" is forgotten, so five more guesses are free again: nine in all.
      expect(await wrongAttempts(started, 5, "ivan")).toEqual([401, 401, 401, 401, 401]);
    });
  });
});
