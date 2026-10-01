#!/usr/bin/env node
// Checks that a running Kassa server answers the way it should. Exits with 1 if anything is wrong,
// so an update script can stop and say so.
//
//   node deploy/check.mjs http://127.0.0.1:3000           on the server, after a start or an update
//   node deploy/check.mjs https://203-0-113-5.sslip.io     the public address: proxy, certificate, port 80
//
// With --login (and the password in KASSA_CHECK_PASSWORD) it also signs in once and looks at the
// session cookie, then signs out again. The password is never taken from the command line.
import { parseArgs } from "node:util";

const USAGE = `Usage: node deploy/check.mjs <address> [--login <login>] [--no-port-80]

  node deploy/check.mjs http://127.0.0.1:3000
  node deploy/check.mjs https://203-0-113-5.sslip.io --login ivan   (password in KASSA_CHECK_PASSWORD)

--no-port-80: do not look at port 80 (another web server holds it, and the proxy gets its certificate on port 443).`;

const TIMEOUT_MS = 10_000;

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { login: { type: "string" }, "no-port-80": { type: "boolean" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  if (values.help || positionals.length !== 1) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 2);
  }

  let base;
  try {
    base = new URL(positionals[0]);
  } catch {
    console.error(`"${positionals[0]}" is not an address (try http://127.0.0.1:3000)\n\n${USAGE}`);
    process.exit(2);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    console.error(`The address must start with http:// or https://\n\n${USAGE}`);
    process.exit(2);
  }
  const https = base.protocol === "https:";
  const at = (path) => new URL(path, base).toString();

  const results = [];
  const check = async (name, run) => {
    try {
      const detail = await run();
      results.push({ name, ok: true, detail });
    } catch (error) {
      results.push({ name, ok: false, detail: explain(error) });
    }
  };

  await check("health", async () => {
    const response = await get(at("/api/health"));
    const body = await response.json().catch(() => ({}));
    if (response.status !== 200 || body.status !== "ok") {
      throw new Failure(`status ${response.status}, database ${body.database ?? "unknown"}`);
    }
    return "the server answers and the database is up";
  });

  await check("app shell", async () => {
    const response = await get(at("/"));
    const text = await response.text();
    const type = response.headers.get("content-type") ?? "";
    if (response.status !== 200 || !type.includes("text/html") || !text.includes('id="root"')) {
      throw new Failure(`status ${response.status}, ${type || "no content type"}: the web app is not being served`);
    }
    return "the web app is served";
  });

  await check("manifest", async () => {
    const response = await get(at("/manifest.webmanifest"));
    const manifest = await response.json().catch(() => undefined);
    if (response.status !== 200 || !manifest?.name) {
      throw new Failure(`status ${response.status}: the app cannot be installed on a phone without it`);
    }
    return `the app is called "${manifest.name}"`;
  });

  await check("login required", async () => {
    const response = await get(at("/api/me"));
    if (response.status !== 401) {
      throw new Failure(`expected 401 without a session, got ${response.status}`);
    }
    return "the API asks for a login";
  });

  if (https && !values["no-port-80"] && (base.port === "" || base.port === "443")) {
    await check("port 80", async () => {
      const plain = new URL(base);
      plain.protocol = "http:";
      plain.port = "";
      const response = await get(plain.toString(), { redirect: "manual" });
      const location = response.headers.get("location") ?? "";
      if (![301, 302, 307, 308].includes(response.status) || !location.startsWith("https://")) {
        throw new Failure(`status ${response.status}: port 80 must answer with a redirect to https (the certificate is renewed through it)`);
      }
      return "port 80 sends visitors to https";
    });
  }

  if (values.login) {
    const password = process.env.KASSA_CHECK_PASSWORD;
    await check("sign in", async () => {
      if (!password) throw new Failure("set KASSA_CHECK_PASSWORD to the password of that login");
      const response = await get(at("/api/login"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login: values.login, password }),
      });
      if (response.status !== 200) throw new Failure(`status ${response.status}`);
      const setCookie = response.headers.getSetCookie().find((line) => line.startsWith("kassa_session="));
      if (!setCookie) throw new Failure("no session cookie came back");
      if (!/;\s*HttpOnly/i.test(setCookie)) throw new Failure("the session cookie is not HttpOnly");
      if (https && !/;\s*Secure/i.test(setCookie)) {
        throw new Failure("the session cookie is not Secure on https (set NODE_ENV=production in the settings file)");
      }
      const cookie = setCookie.split(";")[0];
      const me = await get(at("/api/me"), { headers: { cookie } });
      if (me.status !== 200) throw new Failure(`signed in, but /api/me says ${me.status}`);
      await get(at("/api/logout"), { method: "POST", headers: { cookie } });
      return `${values.login} can sign in${https ? ", and the cookie is Secure and HttpOnly" : ""}`;
    });
  }

  let failed = 0;
  for (const result of results) {
    if (!result.ok) failed++;
    console.log(`${result.ok ? "ok  " : "FAIL"}  ${result.name}: ${result.detail}`);
  }
  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} of ${results.length} checks failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

/** A check that failed for a reason worth saying in plain words. */
class Failure extends Error {}

// What the network errors people meet here mean, in plain words.
const NETWORK_ERRORS = {
  ECONNREFUSED: "nothing is listening at that address and port (is the service running?)",
  ENOTFOUND: "the name does not resolve to an address (check the spelling and the DNS)",
  EAI_AGAIN: "the name could not be looked up just now (no DNS answer)",
  ETIMEDOUT: "no answer: a firewall or a wrong address is likely",
  EHOSTUNREACH: "the address cannot be reached from here",
  ECONNRESET: "the connection was cut off",
  CERT_HAS_EXPIRED: "the certificate has expired",
  DEPTH_ZERO_SELF_SIGNED_CERT: "the certificate is self-signed, so browsers will not trust it",
  SELF_SIGNED_CERT_IN_CHAIN: "the certificate chain contains a certificate that is not trusted",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "the certificate is not from an authority this computer trusts",
  ERR_TLS_CERT_ALTNAME_INVALID: "the certificate is for another name than the one in the address",
};

function explain(error) {
  if (error instanceof Failure) return error.message;
  if (error?.name === "TimeoutError") return `no answer within ${TIMEOUT_MS / 1000} seconds`;
  const code = error?.cause?.code;
  if (code && NETWORK_ERRORS[code]) return `${NETWORK_ERRORS[code]} [${code}]`;
  const cause = code ?? error?.cause?.message;
  return cause ? `${error.message} (${cause})` : String(error?.message ?? error);
}

function get(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

await main();
