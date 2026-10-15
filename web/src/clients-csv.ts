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

/** The clients of a CSV file: code, name, phone, one to a line; a first line of names of columns is passed over. */
export function clientsOfCsv(text: string): Array<{ code: string; name: string; phone?: string }> {
  return text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map(csvCells)
    .filter((cells) => /^[AaАа]/.test(cells[0] ?? "") && /\d/.test(cells[0] ?? ""))
    .map(([code, name, phone]) => ({ code: code!, name: name ?? "", ...(phone ? { phone } : {}) }));
}
