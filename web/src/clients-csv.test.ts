import { describe, expect, it } from "vitest";
import { clientsOfCsv, clientsWithDebtsOfCsv, csvCells } from "./clients-csv";

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

  it("reads the price of a kilogram and what a client owed at the start, where the business keeps trips", () => {
    const text = 'Код,Имя,Телефон,Цена,Долг\n132,Иброхим,,"1,5","1200,50"\n70;Лочин;7 999;1.55;-50\n3,Рахимберди\n10,Фарух,,,0\n';
    expect(clientsWithDebtsOfCsv(text, "digits")).toEqual({
      clients: [
        { code: "132", name: "Иброхим", priceMilli: 1500, openingDebtMinor: 120_050 },
        { code: "70", name: "Лочин", phone: "7 999", priceMilli: 1550, openingDebtMinor: -5_000 },
        { code: "3", name: "Рахимберди" },
        { code: "10", name: "Фарух" },
      ],
      bad: [],
    });
    // A price or a debt that is not a number: the place of the line in the file is said, and it is not a client.
    expect(clientsWithDebtsOfCsv("Код,Имя\n132,Иброхим,,полтора\n70,Лочин,,1.5,много\n3,Рахимберди,,2\n", "digits")).toEqual({
      clients: [{ code: "3", name: "Рахимберди", priceMilli: 2000 }],
      bad: [2, 3],
    });
  });
});
