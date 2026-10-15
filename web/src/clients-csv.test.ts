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
});
