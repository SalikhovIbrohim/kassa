import { parseDebtInput, parsePriceInput } from "./cargo";

/** One line of a CSV file: the cells, with quotes as a spreadsheet writes them ("a, b" and "say ""hi"""). */
export function csvCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === "," || char === ";") {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells.map((item) => item.trim());
}

/**
 * The clients of a CSV file: code, name, phone, one to a line; a first line of names of columns is passed over. A line
 * is a client when it starts the way a code does: with the letter А and a digit in it, or, where the codes are digits
 * alone, with a digit.
 */
export function clientsOfCsv(text: string, codes: "letter" | "digits" = "letter"): Array<{ code: string; name: string; phone?: string }> {
  const isCode = (cell: string) => (codes === "digits" ? /^\d/.test(cell) : /^[AaАа]/.test(cell) && /\d/.test(cell));
  return text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map(csvCells)
    .filter((cells) => isCode(cells[0] ?? ""))
    .map(([code, name, phone]) => ({ code: code!, name: name ?? "", ...(phone ? { phone } : {}) }));
}

/** A client of a file of a business that keeps trips: with what a kilogram costs them and what they owed at the start. */
export type ClientOfCsv = { code: string; name: string; phone?: string; priceMilli?: number; openingDebtMinor?: number };

/**
 * The same file for a business that keeps trips: after the phone a line may say the price of a kilogram («1,5») and
 * what the client owed at the start («1200,50»; with a minus, money paid ahead), each left empty when there is none.
 * `bad` are the lines whose price or debt is not a number, by their place in the file: nothing of such a file is
 * loaded, since a debt read wrongly is worse than a list loaded a minute later.
 */
export function clientsWithDebtsOfCsv(text: string, codes: "letter" | "digits" = "letter"): { clients: ClientOfCsv[]; bad: number[] } {
  const isCode = (cell: string) => (codes === "digits" ? /^\d/.test(cell) : /^[AaАа]/.test(cell) && /\d/.test(cell));
  const clients: ClientOfCsv[] = [];
  const bad: number[] = [];
  text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .forEach((line, index) => {
      const [code, name, phone, price, debt] = csvCells(line);
      if (!isCode(code ?? "")) return;
      const priceMilli = price ? parsePriceInput(price) : undefined;
      const openingDebtMinor = debt ? parseDebtInput(debt) : undefined;
      if (priceMilli === null || openingDebtMinor === null) return void bad.push(index + 1);
      clients.push({
        code: code!,
        name: name ?? "",
        ...(phone ? { phone } : {}),
        ...(priceMilli === undefined ? {} : { priceMilli }),
        ...(openingDebtMinor === undefined || openingDebtMinor === 0 ? {} : { openingDebtMinor }),
      });
    });
  return { clients, bad };
}
