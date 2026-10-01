import { execFileSync, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { repoRoot, type Run } from "./run-script.js";

/**
 * A small make-believe of the owner's machine, for running the PowerShell scripts of deploy/windows on
 * Linux with PowerShell 7: a bare "origin" repository, a checkout of it that the scripts update, a root folder
 * like C:\kassa with a settings file, programs that only write down what they were asked (sc.exe, icacls.exe,
 * npm), the service cmdlets as functions that keep the state of the service in a file, and a stand-in for
 * the application (its admin command, its check) whose behaviour is written into the version itself: a
 * file `fake/crash` in a version means that this version does not answer, `fake/migrate` holds the exit
 * code of its `migrate`.
 *
 * What this cannot say: how Windows PowerShell 5.1, a real service, or a real icacls behave. What it can
 * say is what the scripts decide, in what order, and what they print and return.
 */

const pwshAvailable = (() => {
  try {
    execFileSync("pwsh", ["-NoProfile", "-Command", "1"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

export const havePowerShell = pwshAvailable;

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function write(folder: string, relative: string, text: string, executable = false) {
  const path = join(folder, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (executable) chmodSync(path, 0o755);
}

const lines = (...items: string[]) => items.join("\n") + "\n";

// The check that update.ps1 and the others run after a start: answers only when the service is running and
// this version does not crash.
const FAKE_CHECK = lines(
  'import { existsSync, readFileSync } from "node:fs";',
  'import { execFileSync } from "node:child_process";',
  'import { fileURLToPath } from "node:url";',
  'const app = fileURLToPath(new URL("..", import.meta.url));',
  'const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: app }).toString().trim();',
  "let running = false;",
  'try { running = readFileSync(process.env.FAKE_WORLD + "/service.state", "utf8").trim() === "Running"; } catch {}',
  'if (!running || existsSync(app + "fake/crash")) {',
  '  console.log("FAIL  the application does not answer on " + process.argv[2] + " (version " + sha + ")");',
  '  console.log("FAIL  see the log");',
  "  process.exit(1);",
  "}",
  'console.log("ok    the application answers on " + process.argv[2] + " (version " + sha + ")");',
);

// The admin command: writes down how it was called, and `migrate` exits with the code in fake/migrate.
const FAKE_CLI = lines(
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const app = path.join(__dirname, "..", "..", "..");',
  "const args = process.argv.slice(2);",
  'const envFile = process.execArgv.find((item) => item.startsWith("--env-file=")) || "no env file";',
  'fs.appendFileSync(process.env.FAKE_WORLD + "/calls.log", "cli " + JSON.stringify(args) + " " + envFile + "\\n");',
  'if (args[0] === "migrate") {',
  "  let code = 0;",
  '  try { code = Number(fs.readFileSync(path.join(app, "fake", "migrate"), "utf8").trim()); } catch {}',
  '  if (code === 3) console.error("Error: the database was changed by a newer version (fake)");',
  '  if (code === 4) console.error("Error: Migration 0002.sql failed: boom. Nothing was applied: the database is as it was.");',
  '  if (code === 1) console.error("Error: Migration 0003.sql failed: boom, after 0002.sql was applied.");',
  "  process.exit(code);",
  "}",
);

const FAKE_RESTORE = lines(
  'import { appendFileSync } from "node:fs";',
  'appendFileSync(process.env.FAKE_WORLD + "/calls.log", "restore.mjs " + process.argv.slice(2).join(" ") + "\\n");',
  'if (process.env.FAKE_RESTORE_FAIL) { console.error("Error: could not restore (fake)"); process.exit(1); }',
  'console.log("Restored (fake).");',
);

const STUB_LOGGING = (name: string) =>
  lines("#!/bin/sh", `echo "${name} $*" >> "$FAKE_WORLD/calls.log"`);

const STUBS: Record<string, string> = {
  // Writes down what it was asked; fails for the arguments named in FAKE_NPM_FAIL (e.g. "ci").
  npm: lines(
    "#!/bin/sh",
    'echo "npm $*" >> "$FAKE_WORLD/calls.log"',
    'if [ -n "$FAKE_NPM_FAIL" ]; then case " $* " in *" $FAKE_NPM_FAIL "*) echo "npm ERR! (fake) $*" >&2; exit 1;; esac; fi',
    "exit 0",
  ),
  "sc.exe": lines(
    "#!/bin/sh",
    'echo "sc.exe $*" >> "$FAKE_WORLD/calls.log"',
    'case "$*" in "config KassaApp start= "*) echo "$*" | sed "s/.*start= //" > "$FAKE_WORLD/startmode";; esac',
    "exit 0",
  ),
  "icacls.exe": lines("#!/bin/sh", 'echo "icacls.exe $*" >> "$FAKE_WORLD/calls.log"', 'exit "${FAKE_ICACLS_EXIT:-0}"'),
  "powercfg.exe": STUB_LOGGING("powercfg.exe"),
  // The PostgreSQL tools that deploy/backup.mjs starts: a copy that is a file with some text in it, and a list that
  // names the table the money lives in. FAKE_BACKUP_FAIL makes the copy fail.
  pg_dump: lines(
    "#!/bin/sh",
    'echo "pg_dump $*" >> "$FAKE_WORLD/calls.log"',
    'if [ -n "$FAKE_BACKUP_FAIL" ]; then echo "pg_dump: error: (fake) could not connect to the database" >&2; exit 1; fi',
    'out=""',
    'while [ $# -gt 0 ]; do if [ "$1" = "--file" ]; then out="$2"; fi; shift; done',
    'echo "fake dump" > "$out"',
  ),
  pg_restore: lines("#!/bin/sh", 'echo "3456; 0 16400 TABLE DATA public operations kassa"'),
};

// The Windows commands the scripts use, as functions: the state of the service is in a file, and nothing waits.
const PRELUDE = lines(
  "$World = $env:FAKE_WORLD",
  "function Add-Call { param([string]$Text) Add-Content -LiteralPath (Join-Path $World 'calls.log') -Value $Text }",
  "function Get-ServiceState { $file = Join-Path $World 'service.state'; if (Test-Path -LiteralPath $file) { (Get-Content -LiteralPath $file -Raw).Trim() } else { $null } }",
  "function Get-Service {",
  "    [CmdletBinding()] param([string]$Name)",
  "    if ($Name -eq 'KassaApp') {",
  "        $state = Get-ServiceState",
  "        if ($state) { return [pscustomobject]@{ Name = 'KassaApp'; Status = $state } }",
  "        return $null",
  "    }",
  "    if ($Name -like 'postgresql*') { return [pscustomobject]@{ Name = 'postgresql-x64-16'; Status = 'Running' } }",
  "    return $null",
  "}",
  "function Stop-Service { [CmdletBinding()] param([string]$Name, [switch]$Force); Add-Call \"Stop-Service $Name\"; Set-Content -LiteralPath (Join-Path $World 'service.state') -Value 'Stopped' }",
  "function Start-Service { [CmdletBinding()] param([string]$Name); $sha = (& git -C $env:FAKE_APP rev-parse --short HEAD); Add-Call \"Start-Service $Name at $sha\"; Set-Content -LiteralPath (Join-Path $World 'service.state') -Value 'Running' }",
  "function Start-Sleep { param($Seconds, $Milliseconds) }",
);

export type World = ReturnType<typeof createWorld>;

/** Commands run in the world. `command` is what a person would type in the PowerShell window. */
export function createWorld() {
  const dir = mkdtempSync(join(tmpdir(), "kassa world "));
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  const app = join(dir, "app");
  const root = join(dir, "kassa root");
  const bin = join(dir, "bin");

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_IDENTITY }, encoding: "utf8" }).trim();

  mkdirSync(bin, { recursive: true });
  for (const [name, text] of Object.entries(STUBS)) write(bin, name, text, true);
  write(dir, "prelude.ps1", PRELUDE);
  write(dir, "calls.log", "");
  write(root, "config/kassa.env", "DATABASE_URL=postgres://kassa:secret@127.0.0.1:5432/kassa\nPORT=3000\n");
  write(root, "logs/.keep", "");

  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", seed]);
  git(seed, "remote", "add", "origin", origin);

  // What every version holds: the real scripts, the real code the scripts share, and the stand-ins.
  cpSync(join(repoRoot, "deploy", "windows"), join(seed, "deploy", "windows"), { recursive: true });
  cpSync(join(repoRoot, "deploy", "backup-lib.mjs"), join(seed, "deploy", "backup-lib.mjs"));
  cpSync(join(repoRoot, "deploy", "backup.mjs"), join(seed, "deploy", "backup.mjs"));
  write(seed, "deploy/check.mjs", FAKE_CHECK);
  write(seed, "deploy/restore.mjs", FAKE_RESTORE);
  write(seed, "server/dist/admin/cli.js", FAKE_CLI);
  write(seed, "package.json", '{"name":"fake","private":true,"version":"1.0.0"}\n');
  write(seed, "package-lock.json", "{}\n");
  write(seed, "server/package.json", '{"name":"@fake/server","version":"1.0.0"}\n');
  write(seed, "web/package.json", '{"name":"@fake/web","version":"1.0.0"}\n');
  write(seed, "server/migrations/0001.sql", "-- first\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "Version A");
  git(seed, "-c", "push.negotiate=false", "push", "--quiet", "origin", "main");
  execFileSync("git", ["clone", "--quiet", origin, app]);
  write(dir, "service.state", "Running\n");

  const env = () => ({
    ...process.env,
    ...GIT_IDENTITY,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    FAKE_WORLD: dir,
    FAKE_APP: app,
  });

  return {
    dir,
    root,
    app,
    seed,
    origin,
    git,

    /** The path of a script of the checkout that is deployed. */
    script: (name: string) => join(app, "deploy", "windows", name),

    /** A new version on the server: files to write (text), or to delete (null). Returns its commit. */
    commit(message: string, files: Record<string, string | null>): string {
      for (const [path, text] of Object.entries(files)) {
        if (text === null) rmSync(join(seed, path), { force: true });
        else write(seed, path, text);
      }
      git(seed, "add", "-A");
      git(seed, "commit", "--quiet", "-m", message);
      git(seed, "-c", "push.negotiate=false", "push", "--quiet", "origin", "main");
      return git(seed, "rev-parse", "HEAD");
    },

    /** The commit the deployed checkout is on. */
    head: () => git(app, "rev-parse", "HEAD"),

    /** Everything the stand-ins were asked, one line each, in order. */
    calls: () =>
      readFileSync(join(dir, "calls.log"), "utf8")
        .split("\n")
        .filter(Boolean),

    service: () => (existsSync(join(dir, "service.state")) ? readFileSync(join(dir, "service.state"), "utf8").trim() : undefined),
    removeService: () => rmSync(join(dir, "service.state"), { force: true }),
    startMode: () => (existsSync(join(dir, "startmode")) ? readFileSync(join(dir, "startmode"), "utf8").trim() : undefined),

    read: (relative: string) => readFileSync(join(root, relative), "utf8"),
    exists: (path: string) => existsSync(path),
    write: (relative: string, text: string) => write(root, relative, text),

    /**
     * Runs a command line the way a person types it in the PowerShell window, with the stand-ins in place.
     * `extraEnv` adds to the environment (FAKE_NPM_FAIL, FAKE_BACKUP_FAIL, ...).
     */
    run(command: string, extraEnv: Record<string, string> = {}): Promise<Run> {
      return new Promise((resolve, reject) => {
        const child = spawn(
          "pwsh",
          ["-NoProfile", "-NonInteractive", "-Command", `. '${join(dir, "prelude.ps1")}'; ${command}; exit $LASTEXITCODE`],
          { cwd: dir, env: { ...env(), ...extraEnv } },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
    },

    close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
