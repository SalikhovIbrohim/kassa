import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorld, havePowerShell, type World } from "./helpers/ps-world.js";

/**
 * The scripts of deploy/windows, run with PowerShell 7 on a make-believe machine (see helpers/ps-world.ts):
 * what they decide, in what order, and what they print and return. How Windows PowerShell 5.1, a real
 * service and a real icacls behave is not shown by these tests, and docs/deploy-windows.md says so.
 */
describe.skipIf(!havePowerShell)("the PowerShell scripts of deploy/windows, on a make-believe machine", () => {
  let world: World;

  beforeEach(() => {
    world = createWorld();
  });

  afterEach(() => {
    world.close();
  });

  /**
   * A script, typed the way the documents tell the owner to type it, with this machine's folder at the end (the
   * default, C:\kassa, is only a folder name on Linux, which PowerShell reads as another path).
   */
  const typed = (name: string, rest = "") => `& '${world.script(name)}' ${rest} -Root '${world.root}'`;

  describe("kassa.ps1: the admin commands", () => {
    it("hands every word after its name to the admin command, as typed in the window", async () => {
      const run = await world.run(typed("kassa.ps1", 'create-user --login ivan --role cashier --name "Ivan Petrov"'));

      expect(run.code, run.stdout + run.stderr).toBe(0);
      const call = world.calls().find((line) => line.startsWith("cli "));
      expect(call).toContain('["create-user","--login","ivan","--role","cashier","--name","Ivan Petrov"]');
      expect(call).toContain(`--env-file=${world.root}/config/kassa.env`);
    }, 60_000);

    it("does not take the command word for the folder: list-users and help work too", async () => {
      for (const word of ["list-users", "help"]) {
        const run = await world.run(typed("kassa.ps1", word));
        expect(run.code, run.stdout + run.stderr).toBe(0);
        expect(run.stdout).not.toContain("settings file");
      }
      expect(world.calls().filter((line) => line.startsWith("cli "))).toHaveLength(2);
    }, 60_000);

    it("still takes -Root when it is given first", async () => {
      const run = await world.run(`& '${world.script("kassa.ps1")}' -Root '${world.root}' list-users`);
      expect(run.code, run.stdout + run.stderr).toBe(0);
    }, 60_000);

    it("looks in C:\\kassa, and not in a folder named like the command, when no folder is given", async () => {
      const run = await world.run(`& '${world.script("kassa.ps1")}' list-users`);
      expect(run.code).toBe(1);
      expect(run.stdout).toContain("C:\\kassa");
      expect(run.stdout).toContain("Run setup.ps1 first");
      expect(run.stdout).not.toContain("list-users/config");
    }, 60_000);
  });

  describe("Wait-Application: does the application answer?", () => {
    const ask = async () => {
      const run = await world.run(
        `. '${world.script("common.ps1")}'; $answer = Wait-Application -Layout (Get-KassaLayout -Root '${world.root}'); ` +
          `Write-Output ('RESULT type=' + $answer.GetType().Name + ' value=' + $answer)`,
      );
      return { run, result: /RESULT (.*)$/m.exec(run.stdout)?.[1] };
    };

    it("says yes, as one true or false, when it answers", async () => {
      const { run, result } = await ask();
      expect(run.code, run.stdout + run.stderr).toBe(0);
      expect(result).toBe("type=Boolean value=True");
    }, 60_000);

    it("says no, as one true or false and nothing else, when it never answers", async () => {
      world.write("../service.state", "Stopped\n");
      const { run, result } = await ask();
      // The lines the check prints are for the person to read; they must not become part of the answer, which
      // `if (-not (Wait-Application))` reads: a list of lines is "true".
      expect(result, run.stdout).toBe("type=Boolean value=False");
      expect(run.stdout).toContain("FAIL  the application does not answer");
    }, 60_000);
  });

  describe("update.ps1", () => {
    const before = () => world.head();
    const short = (sha: string) => sha.slice(0, 7);

    it("goes to the newest version, starts it, checks it and says so", async () => {
      const a = before();
      const b = world.commit("Version B", { "fake/changed": "b\n" });

      const run = await world.run(typed("update.ps1"));

      expect(run.code, run.stdout + run.stderr).toBe(0);
      expect(run.stdout).toContain("Updated:");
      expect(world.head()).toBe(b);
      expect(world.service()).toBe("Running");
      expect(world.calls()).toContain(`Start-Service KassaApp at ${short(b)}`);
      expect(world.calls().filter((line) => line.startsWith("Start-Service"))).toEqual([`Start-Service KassaApp at ${short(b)}`]);
      expect(world.startMode()).toBe("delayed-auto");
      expect(world.read("logs/update.log")).toContain("Updated:");
      expect(a).not.toBe(b);
    }, 60_000);

    it("goes back to the version that ran before when the new one does not answer, and says that the update failed", async () => {
      const a = before();
      const b = world.commit("Version B crashes at start", { "fake/crash": "1\n" });

      const run = await world.run(typed("update.ps1"));

      expect(run.stdout).toContain("The update failed: The new version does not answer");
      expect(run.stdout).toContain("The version that ran before is running again");
      expect(run.stdout).not.toContain("Updated:");
      expect(run.code).toBe(1);
      expect(world.head()).toBe(a);
      expect(world.service()).toBe("Running");
      // started with the new version, then with the old one
      expect(world.calls().filter((line) => line.startsWith("Start-Service"))).toEqual([
        `Start-Service KassaApp at ${short(b)}`,
        `Start-Service KassaApp at ${short(a)}`,
      ]);
      expect(world.startMode()).toBe("delayed-auto");
      const log = world.read("logs/update.log");
      expect(log).toContain("FAILED");
      expect(log).toContain("Went back");
      expect(log).not.toContain("Updated:");
    }, 60_000);

    it("does not go back when the new version changed the database and does not answer: it says how to put the copy back", async () => {
      const a = before();
      const b = world.commit("Version B: a migration, and it crashes", {
        "server/migrations/0002.sql": "-- second\n",
        "fake/crash": "1\n",
      });

      const run = await world.run(typed("update.ps1"));

      expect(run.code).toBe(1);
      expect(run.stdout).toContain("The update failed");
      expect(run.stdout).toContain("restore.ps1 -From");
      expect(run.stdout).toContain(`update.ps1 -Ref ${a}`);
      expect(world.head()).toBe(b);
      expect(world.read("logs/update.log")).toContain("FAILED");
    }, 60_000);

    it("goes back when a migration failed and none was applied: the database is as it was, so the old version can run", async () => {
      const a = before();
      world.commit("Version B: a migration that fails", { "server/migrations/0002.sql": "-- second\n", "fake/migrate": "4\n" });

      const run = await world.run(typed("update.ps1"));

      expect(run.code).toBe(1);
      expect(run.stdout).toContain("The update failed");
      expect(run.stdout).toContain("The version that ran before is running again");
      expect(run.stdout).not.toContain("restore.ps1 -From");
      expect(world.head()).toBe(a);
      expect(world.service()).toBe("Running");
      expect(world.startMode()).toBe("delayed-auto");
    }, 60_000);

    it("says to put the copy back when a migration failed after others were applied", async () => {
      before();
      const b = world.commit("Version B: two migrations, the second fails", {
        "server/migrations/0002.sql": "-- second\n",
        "server/migrations/0003.sql": "-- third\n",
        "fake/migrate": "1\n",
      });

      const run = await world.run(typed("update.ps1"));

      expect(run.code).toBe(1);
      expect(run.stdout).toContain("restore.ps1 -From");
      expect(world.head()).toBe(b);
    }, 60_000);

    it("goes back when the database refuses the new version, and tells how to go back to an older one", async () => {
      const a = before();
      world.commit("Version B", { "fake/migrate": "3\n" });

      const run = await world.run(typed("update.ps1"));

      expect(run.code).toBe(1);
      expect(run.stdout).toContain("This version will not run on this database");
      expect(world.head()).toBe(a);
      expect(world.service()).toBe("Running");
    }, 60_000);

    it("changes nothing when the copy of the database cannot be made", async () => {
      const a = before();
      world.commit("Version B", { "fake/changed": "b\n" });

      const run = await world.run(typed("update.ps1"), { FAKE_BACKUP_FAIL: "1" });

      expect(run.code).toBe(1);
      expect(run.stdout).toContain("so nothing was changed");
      expect(world.head()).toBe(a);
      expect(world.service()).toBe("Running");
      expect(world.startMode()).toBe("delayed-auto");
    }, 60_000);

    it("stops the service before it builds the old version over a new one that crashes, and starts it again after", async () => {
      before();
      world.commit("Version B crashes at start", { "fake/crash": "1\n" });

      await world.run(typed("update.ps1"));

      const services = world.calls().filter((line) => /^(Stop|Start)-Service/.test(line));
      expect(services.map((line) => line.replace(/ at \w+$/, ""))).toEqual([
        "Stop-Service KassaApp",
        "Start-Service KassaApp",
        "Stop-Service KassaApp", // the service itself starts a crashed version again: it must not while the old one is built
        "Start-Service KassaApp",
      ]);
    }, 60_000);

    it("makes the copy before the update as a copy of its own kind, apart from the nightly ones", async () => {
      before();
      world.commit("Version B", { "fake/changed": "b\n" });

      const run = await world.run(typed("update.ps1"));

      expect(run.code, run.stdout + run.stderr).toBe(0);
      expect(run.stdout).toMatch(/The copy of the database made before the update: .*kassa-\d{8}-\d{6}-before-update\.dump/);
      expect(world.calls().some((line) => line.startsWith("pg_dump") && /-before-update\.dump\.partial/.test(line))).toBe(true);
    }, 60_000);

    it("installs the packages when they changed, after finding out that the registry can be reached", async () => {
      before();
      world.commit("Version B changes the packages", { "package-lock.json": '{"changed":true}\n' });

      const run = await world.run(typed("update.ps1"));

      expect(run.code, run.stdout + run.stderr).toBe(0);
      const npm = world.calls().filter((line) => line.startsWith("npm "));
      expect(npm).toEqual(["npm ping", "npm ci", "npm run build"]);
    }, 60_000);

    it("changes nothing when the packages changed and the registry cannot be reached: npm ci deletes the packages first", async () => {
      const a = before();
      world.commit("Version B changes the packages", { "package-lock.json": '{"changed":true}\n' });

      const run = await world.run(typed("update.ps1"), { FAKE_NPM_FAIL: "ping" });

      expect(run.code).toBe(1);
      expect(run.stdout).toContain("The npm registry cannot be reached");
      expect(run.stdout).toContain("Nothing was changed");
      expect(world.head()).toBe(a);
      expect(world.service()).toBe("Running");
      expect(world.calls().filter((line) => /^(Stop|Start)-Service/.test(line))).toEqual([]);
      expect(world.calls().some((line) => line.startsWith("pg_dump"))).toBe(false);
    }, 60_000);

    it("sets the service to start with the computer again after a restore that left it not starting by itself", async () => {
      before();
      world.commit("Version B", { "fake/changed": "b\n" });
      world.write("backups/kassa-20261001-030000.dump", "fake");
      const restored = await world.run(typed("restore.ps1", `-From '${world.root}/backups/kassa-20261001-030000.dump' -Replace -NoStart`), { PGPASSWORD: "x" });
      expect(restored.code, restored.stdout + restored.stderr).toBe(0);
      expect(world.startMode()).toBe("demand");

      const run = await world.run(typed("update.ps1"));

      expect(run.code, run.stdout + run.stderr).toBe(0);
      expect(world.startMode()).toBe("delayed-auto");
    }, 60_000);

    it("leaves a checkout that was moved to one version on the newest version of its branch when there is nothing to update", async () => {
      const a = before();
      const b = world.commit("Version B", { "fake/changed": "b\n" });
      // The way back from a rollback, or from a branch that was deleted: one named version.
      const named = await world.run(typed("update.ps1", "-Ref main"));
      expect(named.code, named.stdout + named.stderr).toBe(0);
      expect(world.head()).toBe(b);
      expect(world.git(world.app, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");

      const plain = await world.run(typed("update.ps1"));

      expect(plain.code, plain.stdout + plain.stderr).toBe(0);
      expect(plain.stdout).toContain("Nothing to update");
      // not on the old commit of a stale local branch, with no build, while the message says it is the new one
      expect(world.head()).toBe(b);
      expect(world.git(world.app, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      expect(a).not.toBe(b);
    }, 60_000);
  });

  describe("restore.ps1: a copy back into the database", () => {
    const copyFile = () => `${world.root}/backups/kassa-20261001-030000.dump`;
    const restore = (flags: string, env: Record<string, string> = { PGPASSWORD: "x" }) => {
      world.write("backups/kassa-20261001-030000.dump", "fake");
      return world.run(typed("restore.ps1", `-From '${copyFile()}' ${flags}`), env);
    };
    const restoreCalls = () => world.calls().filter((line) => line.startsWith("restore.mjs"));

    it("does nothing, and says what to choose, when it is not told -Check or -Replace", async () => {
      const run = await restore("");

      expect(run.code).toBe(1);
      expect(run.stdout).toContain("-Check tries it in a scratch database and changes nothing; -Replace puts it in place of the live database");
      expect(restoreCalls()).toEqual([]);
      expect(world.calls().filter((line) => /-Service/.test(line))).toEqual([]);
      expect(world.service()).toBe("Running");
    }, 60_000);

    it("refuses -Check and -Replace together", async () => {
      const run = await restore("-Check -Replace");

      expect(run.code).toBe(1);
      expect(run.stdout).toContain("not both");
      expect(restoreCalls()).toEqual([]);
    }, 60_000);

    it("tries the copy with -Check and leaves the application alone", async () => {
      const run = await restore("-Check");

      expect(run.code, run.stdout + run.stderr).toBe(0);
      expect(run.stdout).toContain("The copy can be restored");
      expect(restoreCalls()).toHaveLength(1);
      expect(restoreCalls()[0]).toContain("--check");
      expect(world.calls().filter((line) => /-Service/.test(line))).toEqual([]);
    }, 60_000);

    it("stops the application, puts the copy in place with -Replace, and starts the application again", async () => {
      const run = await restore("-Replace");

      expect(run.code, run.stdout + run.stderr).toBe(0);
      expect(restoreCalls()[0]).toContain("--replace");
      expect(world.calls().filter((line) => /-Service/.test(line)).map((line) => line.replace(/ at \w+$/, ""))).toEqual([
        "Stop-Service KassaApp",
        "Start-Service KassaApp",
      ]);
      expect(world.service()).toBe("Running");
      expect(world.startMode()).toBeUndefined();
    }, 60_000);

    it("starts the application again, and says why, when the copy could not be restored: the live database is still live", async () => {
      const run = await restore("-Replace", { PGPASSWORD: "x", FAKE_RESTORE_FAIL: "1" });

      expect(run.code).toBe(1);
      expect(run.stdout).toContain("failed with exit code 1");
      expect(world.service()).toBe("Running");
      expect(world.calls().filter((line) => line.startsWith("Start-Service"))).toHaveLength(1);
    }, 60_000);

    it("with -NoStart leaves the application stopped, and not starting by itself with the computer until update.ps1 has run", async () => {
      const run = await restore("-Replace -NoStart");

      expect(run.code, run.stdout + run.stderr).toBe(0);
      expect(world.service()).toBe("Stopped");
      expect(world.calls().filter((line) => line.startsWith("Start-Service"))).toEqual([]);
      expect(world.startMode()).toBe("demand");
      expect(run.stdout).toContain("update.ps1 -Ref");
      expect(run.stdout).toContain("sc.exe config KassaApp start= delayed-auto");
    }, 60_000);

    it("says what is missing for a file that is not there", async () => {
      const run = await world.run(typed("restore.ps1", `-From '${world.root}/backups/nothing.dump' -Check`), { PGPASSWORD: "x" });

      expect(run.code).toBe(1);
      expect(run.stdout).toContain("There is no file");
    }, 60_000);
  });

  describe("backup.ps1: where the copies go, and who may read them", () => {
    const backup = (flags = "", env: Record<string, string> = {}) => world.run(typed("backup.ps1", flags), env);
    const icacls = () => world.calls().filter((line) => line.startsWith("icacls.exe"));
    const settings = (extra: string) => world.write("config/kassa.env", `DATABASE_URL=postgres://kassa:secret@127.0.0.1:5432/kassa\nPORT=3000\n${extra}`);

    it("makes the copy in the folder under the root when the settings name none, and locks that folder to the administrators", async () => {
      const run = await backup();

      expect(run.code, run.stdout + run.stderr).toBe(0);
      expect(run.stdout.trim().split("\n").at(-1)).toMatch(new RegExp(`^${world.root}/backups/kassa-\\d{8}-\\d{6}\\.dump$`));
      expect(icacls()).toHaveLength(1);
      expect(icacls()[0]).toContain(`${world.root}/backups`);
      expect(icacls()[0]).toContain("*S-1-5-18:(OI)(CI)F");
      expect(icacls()[0]).toContain("*S-1-5-32-544:(OI)(CI)F");
    }, 60_000);

    it("makes the copy in BACKUP_DIR of the settings file, and locks that folder when it is new", async () => {
      const folder = `${world.dir}/second disk/copies`;
      settings(`BACKUP_DIR=${folder}\n`);

      const run = await backup();

      expect(run.code, run.stdout + run.stderr).toBe(0);
      expect(run.stdout).toContain(`Copy made: ${folder}/kassa-`);
      expect(world.exists(`${world.root}/backups`)).toBe(false);
      expect(icacls()).toHaveLength(1);
      expect(icacls()[0]).toContain(folder);
    }, 60_000);

    it("does not change the access to a folder that was there before: it may be a disk with other things on it", async () => {
      const folder = `${world.dir}/a disk`;
      world.write("../a disk/other-file.txt", "x");
      settings(`BACKUP_DIR=${folder}\n`);

      const run = await backup();

      expect(run.code, run.stdout + run.stderr).toBe(0);
      expect(icacls()).toEqual([]);
    }, 60_000);

    it("goes on and says so, in the window and in the log, when the folder cannot be locked (a disk that is not NTFS)", async () => {
      const run = await backup("", { FAKE_ICACLS_EXIT: "1" });

      expect(run.code, run.stdout + run.stderr).toBe(0);
      expect(run.stdout).toContain("could not be restricted to the administrators");
      expect(run.stdout).toContain("Copy made:");
      expect(world.read("logs/backup.log")).toContain("WARNING");
    }, 60_000);

    it("takes -To before BACKUP_DIR", async () => {
      settings(`BACKUP_DIR=${world.dir}/not-this\n`);

      const run = await backup(`-To '${world.dir}/this one'`);

      expect(run.code, run.stdout + run.stderr).toBe(0);
      expect(run.stdout).toContain(`${world.dir}/this one/kassa-`);
      expect(world.exists(`${world.dir}/not-this`)).toBe(false);
    }, 60_000);

    it("names the purpose of a copy in its file name with -Label", async () => {
      const run = await backup("-Label before-update");

      expect(run.code, run.stdout + run.stderr).toBe(0);
      expect(run.stdout).toMatch(/kassa-\d{8}-\d{6}-before-update\.dump/);
    }, 60_000);

    it("fails with the reason, in the window and in the log, when BACKUP_DIR has a # in it outside quotes", async () => {
      settings(`BACKUP_DIR=${world.dir}/copies #1\n`);

      const run = await backup();

      expect(run.code).toBe(1);
      expect(run.stdout + run.stderr).toContain("single quotes");
      expect(world.read("logs/backup.log")).toContain("FAILED");
      expect(world.read("logs/backup.log")).toContain("single quotes");
    }, 60_000);

    it("takes a path with a # in it when it is in single quotes", async () => {
      const folder = `${world.dir}/copies #1`;
      settings(`BACKUP_DIR='${folder}'\n`);

      const run = await backup();

      expect(run.code, run.stdout + run.stderr).toBe(0);
      expect(run.stdout).toContain(`Copy made: ${folder}/kassa-`);
    }, 60_000);

    it("says that the copy was not made, and why, when it fails", async () => {
      const run = await backup("", { FAKE_BACKUP_FAIL: "1" });

      expect(run.code).toBe(1);
      expect(run.stdout + run.stderr).toContain("The copy was not made");
    }, 60_000);
  });

  describe("what the scripts share (common.ps1)", () => {
    const evaluate = async (code: string) => {
      const run = await world.run(`. '${world.script("common.ps1")}'; ${code}`);
      expect(run.code, run.stdout + run.stderr).toBe(0);
      return run.stdout.trim();
    };

    it("takes the last PORT line of the settings file, as the application does, also in quotes or with a comment", async () => {
      for (const [lines, port] of [
        ["PORT=3000\nPORT=3001\n", "3001"],
        ['PORT="3002"\n', "3002"],
        ["PORT=3003 # the second instance\n", "3003"],
        ["# PORT=3004\n", "3000"],
        ["", "3000"],
      ] as const) {
        world.write("config/kassa.env", lines);
        expect(await evaluate(`Get-AppPort -Layout (Get-KassaLayout -Root '${world.root}')`)).toBe(port);
      }
    }, 90_000);

    it("keeps what a program prints out of the answer of the function that runs it", async () => {
      const answer = await evaluate(
        "function Ask { Invoke-Native -File 'echo' -Arguments @('noise'); return $true }; $x = Ask; Write-Output ('type=' + $x.GetType().Name + ' value=' + $x)",
      );
      expect(answer).toContain("type=Boolean value=True");
    }, 60_000);

    it("sees a firewall rule that opens a port, whether the rule names it alone or in a range", async () => {
      const answer = await evaluate(
        "$r = @(); foreach ($case in @(@('3000', 3000), @('3000-3010', 3005), @('49152-65535', 3000), @('Any', 3000), @(@('80', '3000'), 3000), @('1-65535', 5432), @('3001', 3000))) " +
          "{ $r += [string](Test-PortListed -Values $case[0] -Port $case[1]) }; $r -join ','",
      );
      expect(answer).toBe("True,True,False,False,True,True,False");
    }, 60_000);

    it("makes the folder a full path, so that a script that changes folders still finds it", async () => {
      const answer = await evaluate("Set-Location '/tmp'; (Get-KassaLayout -Root 'relative/kassa').Root");
      expect(answer).toBe("/tmp/relative/kassa");
    }, 60_000);
  });

  describe("lint.ps1: what the scripts must keep to", () => {
    it("passes on the scripts as they are", async () => {
      const run = await world.run(`& '${world.script("lint.ps1")}'`);

      expect(run.code, run.stdout + run.stderr).toBe(0);
      expect(run.stdout).toContain("OK:");
    }, 60_000);

    it("fails for a script that lets a word typed after its name become the value of its first parameter", async () => {
      const path = world.script("kassa.ps1");
      const original = readFileSync(path, "utf8");
      writeFileSync(path, original.replace("[CmdletBinding(PositionalBinding = $false)]", "[CmdletBinding()]"));

      const run = await world.run(`& '${world.script("lint.ps1")}'`);

      expect(run.code).toBe(1);
      expect(run.stdout).toContain("kassa.ps1");
      expect(run.stdout).toContain("PositionalBinding");
    }, 60_000);
  });

  describe("setup.ps1 and the others", () => {
    it("setup.ps1 refuses to reinstall the packages while the application is running", async () => {
      const run = await world.run(typed("setup.ps1"));

      expect(run.code).toBe(1);
      expect(run.stdout).toContain("The service KassaApp is running");
      expect(world.calls().filter((line) => line.startsWith("npm "))).toEqual([]);
    }, 60_000);

    it("the nightly task may start, and goes on, when the computer runs on its battery", () => {
      const text = readFileSync(world.script("schedule-backup.ps1"), "utf8");
      expect(text).toContain("-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries");
    });
  });
});
