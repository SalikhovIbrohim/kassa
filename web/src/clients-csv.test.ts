import { describe, expect, it } from "vitest";
import { clientsOfCsv, csvCells } from "./clients-csv";

describe("a list of clients from a CSV file", () => {
  it("splits a line at commas or semicolons, and keeps a comma inside quotes", () => {
    expect(csvCells(' А707 ; Карим ;"7 999, доб. 2"')).toEqual(["А707", "Карим", "7 999, доб. 2"]);
    expect(csvCells('А1,"Сказал ""да""",')).toEqual(["А1", 'Сказал "да"', ""]);
  });

  it("passes over the header and empty lines, and takes the phone only when there is one", () => {
    const text = "﻿Код,Имя,Телефон\r\nА707,Карим,7 999 000 00 00\r\n\r\na70;Самад\nА-45,,\n";
    expect(clientsOfCsv(text)).toEqual([
      { code: "А707", name: "Карим", phone: "7 999 000 00 00" },
      { code: "a70", name: "Самад" },
      { code: "А-45", name: "" },
    ]);
  });

  it("takes the lines that start with a digit where the codes are digits alone, and only there", () => {
    const text = "Код,Имя,Телефон\n707,Карим,7 999 000 00 00\n34-2;Эркин\nА45,Самад\n";
    expect(clientsOfCsv(text, "digits")).toEqual([
      { code: "707", name: "Карим", phone: "7 999 000 00 00" },
      { code: "34-2", name: "Эркин" },
    ]);
    // With the letter, a line that starts with a digit is not a client (the number of the line of a table, say).
    expect(clientsOfCsv(text)).toEqual([{ code: "А45", name: "Самад" }]);
  });
});
