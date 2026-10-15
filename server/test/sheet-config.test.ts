import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

/** The copy of the journal to a spreadsheet is a side job: its settings never keep the cash desk from starting. */
describe("the settings of the Google spreadsheet", () => {
  const base = { DATABASE_URL: "postgres://x@localhost/x" };

  it("are off when not set", () => {
    expect(loadConfig(base)).toMatchObject({ sheet: undefined, sheetProblem: undefined });
  });

  it("turn the copy off, with the reason, when the key cannot be read, and the cash desk still starts", () => {
    const config = loadConfig({ ...base, GOOGLE_SHEET_ID: "1gfan8zPUFEX07ZUMVcGBWYREeTIg633VYtbTZy9kEJQ", GOOGLE_SHEETS_KEY_FILE: "/no/such/key.json" });
    expect(config.sheet).toBeUndefined();
    expect(config.sheetProblem).toContain("cannot be read");
    expect(config.sheetProblem).toContain("NT SERVICE\\KassaApp:R");
  });

  it("turn the copy off when only half of it is set", () => {
    expect(loadConfig({ ...base, GOOGLE_SHEET_ID: "1gfan8zPUFEX07ZUMVcGBWYREeTIg633VYtbTZy9kEJQ" }).sheetProblem).toContain("GOOGLE_SHEETS_KEY_FILE is required");
  });
});
