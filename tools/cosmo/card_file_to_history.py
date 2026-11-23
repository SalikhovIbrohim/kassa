#!/usr/bin/env python3
"""
Makes the history file that `import-history` loads (see server/src/admin/history.ts) from the card file one business
keeps in a spreadsheet: a sheet to a client, the trips on the left of it, the payments on the right. Nothing is written
but the JSON file and, when asked, the list of what a person has to look at; the spreadsheet is only read.

    python3 -I tools/cosmo/card_file_to_history.py --card <card file.xlsx> --out history.json \
        [--until 2026-11-01] [--problems problems.csv] [--name А413=Ахмад ...]

What it reads:
  a sheet of a client   named «А54 Тимур» (the code, then the name; «А-54», «A54» and «Тимур А54» are read too).
                        Row 2 names the columns, row 3 has what the client owed at the start (the first cell) and the
                        totals, the rows under it are the trips («ДАТА, РЕЙС, ..., СУММА Карго») and, to the right of
                        them, the payments («ДАТА, ОПЛАТА ЗА КАРГО, СКИДКА %»). A trip is a number («412») or a number
                        of the new count («Р204»); a line named «остаток» is owed from before and goes to the start.
                        A discount (a negative sum in «СКИДКА %») is taken off the debt like a payment, with the note
                        «Скидка». A sheet with nothing on it beside another of the same code is passed over.
  «Однаразовые»         the clients who came once: a line to a cargo with the code, the name, the sum and its payment.
  «КЛИЕНТЫ»             the list of all the clients with their totals: what is read is compared with it at the end.
The sheets «ИТОГО» and «склатга» (the rent of the warehouse) are no part of the debts for cargo and are not read.

--until DAY leaves out the trips and the payments of that day and later: from that day on the cash desk keeps them
itself, and they must not be counted twice.

What cannot be read as it stands is listed (and written to --problems): a date that is no date or is outside the time
of the card file, a trip that is no number, a total of a sheet that is not the sum of its lines. The history is written
only when nothing of that is left, or with --force, which leaves the lines in question out and says how much they were.
"""
import argparse
import collections
import csv
import datetime
import json
import re
import sys
import warnings

import openpyxl

FIRST_DAY = datetime.date(2025, 1, 1)
SKIPPED_SHEETS = {"итого", "клиенты", "однаразовые", "склатга"}


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def text(value):
    return "" if value is None else str(value).replace("\n", " ").strip()


def cents(value):
    """Dollars as a spreadsheet has them into whole cents, half up."""
    return int((value * 100 + 0.5) // 1) if value >= 0 else -int((-value * 100 + 0.5) // 1)


def code_of(value):
    """«А54», «а-54», «A54 Тимур», «А34-2»: the code as the cash desk writes it, «А54». None when there is none."""
    found = re.search(r"(?<![А-Яа-яA-Za-z])[АAаa]\s*-?\s*(\d{1,5})(?:-(\d{1,3}))?(?!\d)", text(value))
    if not found:
        return None
    return "А" + str(int(found.group(1))) + (f"-{found.group(2)}" if found.group(2) else "")


def code_and_name(title):
    code = code_of(title)
    if code is None:
        # «174 Тимур»: the letter was left out.
        bare = re.match(r"^\s*(\d{1,5})\s+(\S.*)$", title)
        return (f"А{int(bare.group(1))}", bare.group(2).strip()) if bare else (None, title.strip())
    name = re.sub(r"(?<![А-Яа-яA-Za-z])[АAаa]\s*-?\s*\d{1,5}(?:-\d{1,3})?(?!\d)", " ", title)
    return code, re.sub(r"\s+", " ", name).strip()


def trip_of(value):
    """The number of a trip: 412, «Р204» (the new count, written with a Russian or a Latin letter) is 204. «остаток» is "opening"."""
    if number(value):
        return int(value) if float(value) == int(value) else None
    said = text(value).lower()
    if said.startswith("остат"):
        return "opening"
    found = re.fullmatch(r"[рrp]\s*-?\s*(\d{1,3})", said)
    return int(found.group(1)) if found else None


class Problems:
    def __init__(self):
        self.rows = []

    def add(self, sheet, row, what, value="", money=0.0):
        self.rows.append({"sheet": sheet, "row": row, "what": what, "value": text(value)[:60], "money": round(money, 2)})


def columns(head):
    titles = [text(value).lower() for value in head]
    find = lambda key, start=0: next((index for index in range(start, len(titles)) if key in titles[index]), None)
    total = find("сумма карго")
    if total is None:
        return None
    found = {"trip": find("рейс"), "sum": total, "pay_day": find("дата", total + 1), "pay": find("оплата"), "discount": find("скидка")}
    return None if any(index is None for index in found.values()) else found


def read_day(value, until, problems, sheet, row, what, money):
    if not isinstance(value, datetime.datetime):
        problems.add(sheet, row, f"{what}: нет даты" if value is None else f"{what}: дата записана не как дата", value, money)
        return None
    day = value.date()
    if day < FIRST_DAY or day > until:
        problems.add(sheet, row, f"{what}: дата вне времени картотеки (опечатка в годе?)", day.isoformat(), money)
        return None
    return day


def read_card(path, until, cut, names, problems):
    book = openpyxl.load_workbook(path, read_only=True, data_only=True)
    clients = {}  # code -> {name, opening, sheet}
    lines = []  # {code, trip, day, sum, sheet, row}
    payments = []  # {code, day, amount, note}
    passed_over = []

    def client(code, name, sheet):
        known = clients.get(code)
        if known is None:
            known = clients[code] = {"code": code, "name": names.get(code) or name, "opening": 0.0, "sheet": sheet, "card": None}
        elif not known["name"]:
            known["name"] = names.get(code) or name
        return known

    seen_sheets = collections.defaultdict(list)
    for sheet in book.worksheets:
        title = sheet.title
        if title.strip().lower() in SKIPPED_SHEETS:
            continue
        rows = [list(row) for row in sheet.iter_rows(values_only=True, max_col=16)]
        code, name = code_and_name(title)
        if code is None and rows and rows[0]:
            code, name = code_and_name(text(rows[0][0]))
        if code is None:
            problems.add(title, 1, "лист без кода клиента в названии")
            continue
        col = columns(rows[1]) if len(rows) > 2 else None
        if col is None:
            problems.add(title, 2, "в строке 2 нет колонок «РЕЙС», «СУММА Карго», «ДАТА», «ОПЛАТА ЗА КАРГО», «СКИДКА»")
            continue
        body = [(index + 1, row + [None] * 16) for index, row in enumerate(rows) if index >= 3]
        opening = rows[2][0] if number(rows[2][0]) else 0.0
        if rows[2][0] is not None and not number(rows[2][0]):
            problems.add(title, 3, "долг на начало записан не числом", rows[2][0])
        has = bool(opening) or any(number(row[col[key]]) and row[col[key]] for _, row in body for key in ("sum", "pay", "discount"))
        seen_sheets[code].append((title, has))
        if not has and (code in clients or any(other_has for _, other_has in seen_sheets[code][:-1])):
            passed_over.append(title)
            continue
        if has and any(other_has for _, other_has in seen_sheets[code][:-1]):
            problems.add(title, 1, f"код {code} уже есть на другом листе с записями: «{seen_sheets[code][0][0]}»")
            continue
        entry = client(code, name, title)
        entry["opening"] += opening

        charged = paid = discounted = 0.0
        last_day = None
        for at, row in body:
            total, pay, discount = row[col["sum"]], row[col["pay"]], row[col["discount"]]
            for label, value in (("сумма карго", total), ("оплата", pay), ("скидка", discount)):
                if value is not None and not number(value) and text(value) and not set(text(value)) <= set("-—– "):
                    problems.add(title, at, f"{label} записана не числом", value)
            if number(total) and total:
                charged += total
                trip = trip_of(row[col["trip"]])
                if total < 0:
                    problems.add(title, at, "сумма карго меньше нуля", total, total)
                elif trip == "opening":
                    entry["opening"] += total
                elif trip is None:
                    problems.add(title, at, "рейс записан не номером («412» или «Р204»)", row[col["trip"]], total)
                else:
                    day = row[0].date() if isinstance(row[0], datetime.datetime) else None
                    if isinstance(row[0], datetime.datetime) and not (FIRST_DAY <= day <= until):
                        problems.add(title, at, "рейс: дата вне времени картотеки (опечатка в годе?)", day.isoformat(), total)
                        day = "bad"
                    lines.append({"code": code, "trip": trip, "day": day, "sum": total, "sheet": title, "row": at})
            if number(pay) and pay:
                paid += pay
                if pay < 0:
                    problems.add(title, at, "оплата меньше нуля", pay, pay)
                else:
                    day = read_day(row[col["pay_day"]], until, problems, title, at, "оплата", pay)
                    if day:
                        last_day = day
                        payments.append({"code": code, "day": day, "amount": pay, "note": None})
            if number(discount) and discount:
                discounted += discount
                if discount > 0:
                    problems.add(title, at, "скидка записана со знаком плюс (скидки в картотеке с минусом)", discount, discount)
                else:
                    # A discount stands on a row of its own, often without a day: it is of the day of the payment above it.
                    own = row[col["pay_day"]]
                    day = own.date() if isinstance(own, datetime.datetime) and FIRST_DAY <= own.date() <= until else last_day
                    if day is None:
                        problems.add(title, at, "скидка: нет даты, и нет оплаты выше, по которой её датировать", discount, discount)
                    else:
                        payments.append({"code": code, "day": day, "amount": -discount, "note": "Скидка"})
        # What the sheet itself comes to, with every line as it stands: the list «КЛИЕНТЫ» is compared with this.
        entry["card"] = opening + charged - paid + discounted
        said = rows[2] + [None] * 16
        for label, key, counted in (("сумма карго", "sum", charged), ("оплата", "pay", paid), ("скидка", "discount", discounted)):
            if number(said[col[key]]) and abs(said[col[key]] - counted) > 0.005:
                problems.add(title, 3, f"итог «{label}» в строке 3 не равен сумме строк (в строках {counted:.2f})", said[col[key]], counted - said[col[key]])

    # ---- the clients who came once
    once = next((sheet for sheet in book.worksheets if sheet.title.strip().lower() == "однаразовые"), None)
    if once is not None:
        last_day = {}
        for at, row in enumerate(once.iter_rows(values_only=True, max_col=14), start=1):
            row = list(row) + [None] * 14
            total, pay = row[7], row[10]
            if at < 5 or not ((number(total) and total) or (number(pay) and pay)):
                continue
            code = code_of(row[2]) or (f"А{int(row[2])}" if number(row[2]) and float(row[2]) == int(row[2]) else None)
            if code is None:
                problems.add(once.title, at, "нет кода клиента", row[2], total if number(total) else 0)
                continue
            client(code, text(row[3]), once.title)
            if number(total) and total:
                trip = trip_of(row[1])
                if total < 0:
                    problems.add(once.title, at, "сумма карго меньше нуля", total, total)
                elif trip is None or trip == "opening":
                    problems.add(once.title, at, "рейс записан не номером («412» или «Р204»)", row[1], total)
                else:
                    day = row[0].date() if isinstance(row[0], datetime.datetime) else None
                    if isinstance(row[0], datetime.datetime) and not (FIRST_DAY <= day <= until):
                        problems.add(once.title, at, "рейс: дата вне времени картотеки (опечатка в годе?)", day.isoformat(), total)
                        day = "bad"
                    lines.append({"code": code, "trip": trip, "day": day, "sum": total, "sheet": once.title, "row": at})
            if number(pay) and pay:
                if pay < 0:
                    problems.add(once.title, at, "оплата меньше нуля", pay, pay)
                else:
                    day = read_day(row[9], until, problems, once.title, at, "оплата", pay)
                    if day:
                        payments.append({"code": code, "day": day, "amount": pay, "note": None})

    # ---- a trip arrived on one day: the day most of its lines say; a line without a day takes it
    days = collections.defaultdict(collections.Counter)
    for line in lines:
        if isinstance(line["day"], datetime.date):
            days[line["trip"]][line["day"]] += 1
    arrival = {trip: sorted(counter.items(), key=lambda item: (-item[1], item[0]))[0][0] for trip, counter in days.items()}
    kept = []
    for line in lines:
        if line["day"] == "bad":
            continue
        if line["trip"] not in arrival:
            problems.add(line["sheet"], line["row"], "рейс: нет даты ни в этой строке, ни у других клиентов этого рейса", line["trip"], line["sum"])
            continue
        kept.append(line)
    spread = {trip: (min(counter), max(counter)) for trip, counter in days.items() if (max(counter) - min(counter)).days > 31}

    # ---- the list of all the clients, to compare with
    listed = {}
    index = next((sheet for sheet in book.worksheets if sheet.title.strip().lower() == "клиенты"), None)
    if index is not None:
        for row in index.iter_rows(values_only=True, min_row=3, max_col=8):
            code = code_of(row[0])
            if code and all(number(value) or value is None for value in row[2:7]):
                opening, charged, paid, discount, closing = (value or 0 for value in row[2:7])
                known = listed.setdefault(code, {"name": text(row[1]), "opening": 0.0, "charged": 0.0, "paid": 0.0, "discount": 0.0, "closing": 0.0})
                for key, value in (("opening", opening), ("charged", charged), ("paid", paid), ("discount", discount), ("closing", closing)):
                    known[key] += value

    for code, entry in clients.items():
        if not entry["name"]:
            entry["name"] = listed.get(code, {}).get("name", "")
    nameless = [code for code, entry in clients.items() if not entry["name"]]
    for code in nameless:
        problems.add(clients[code]["sheet"], 1, f"у клиента {code} нет имени (скажите его: --name {code}=Имя)")

    if cut is not None:
        kept = [line for line in kept if arrival[line["trip"]] < cut]
        payments = [payment for payment in payments if payment["day"] < cut]
    return clients, kept, arrival, payments, listed, passed_over, spread


def main():
    parser = argparse.ArgumentParser(description="The card file of a business (a sheet to a client) as one history file for import-history.")
    parser.add_argument("--card", required=True, help="the card file of clients (.xlsx)")
    parser.add_argument("--out", required=True, help="the history file to write (.json)")
    parser.add_argument("--until", help="YYYY-MM-DD: leave out the trips and the payments of this day and later (the cash desk keeps them itself from then on)")
    parser.add_argument("--today", help="YYYY-MM-DD: the last day the card file can speak of (today unless said); a later date is a slip of the pen")
    parser.add_argument("--problems", help="write what a person has to look at to this file (.csv, opens in Excel)")
    parser.add_argument("--name", action="append", default=[], help="CODE=NAME: the name of a client the card file has without one")
    parser.add_argument("--force", action="store_true", help="write the history although lines are in question: they are left out")
    args = parser.parse_args()
    names = {code_of(item.split("=", 1)[0]) or item.split("=", 1)[0]: item.split("=", 1)[1] for item in args.name}
    cut = datetime.date.fromisoformat(args.until) if args.until else None
    today = datetime.date.fromisoformat(args.today) if args.today else datetime.date.today()

    warnings.simplefilter("ignore")  # dates that are no dates are reported line by line below
    problems = Problems()
    clients, lines, arrival, payments, listed, passed_over, spread = read_card(args.card, today, cut, names, problems)

    money = lambda value: f"{value:,.2f}".replace(",", " ")
    # ---- what each client comes to, next to what the list «КЛИЕНТЫ» says of them (only where nothing was cut off)
    charged = collections.Counter()
    paid = collections.Counter()
    for line in lines:
        charged[line["code"]] += line["sum"]
    for payment in payments:
        paid[payment["code"]] += payment["amount"]
    for code, entry in clients.items():
        said = listed.get(code)
        if said is not None and entry["card"] is not None and abs(said["closing"] - entry["card"]) > 0.5:
            problems.add(entry["sheet"], 0, f"долг клиента {code} на его листе {entry['card']:.2f}, а в списке «КЛИЕНТЫ» {said['closing']:.2f}", "", entry["card"] - said["closing"])
    for code in listed:
        if (code not in clients or clients[code]["card"] is None) and abs(listed[code]["closing"]) > 0.005:
            problems.add("КЛИЕНТЫ", 0, f"клиент {code} есть в списке с долгом, а листа у него нет", listed[code]["name"], listed[code]["closing"])

    if args.problems:
        with open(args.problems, "w", encoding="utf-8-sig", newline="") as out:
            writer = csv.writer(out, delimiter=";")
            writer.writerow(["Лист", "Строка", "Что не так", "Что записано", "Сумма, $"])
            for row in problems.rows:
                writer.writerow([row["sheet"], row["row"] or "", row["what"], row["value"], str(row["money"]).replace(".", ",") if row["money"] else ""])

    opening = sum(entry["opening"] for entry in clients.values())
    total_charged, total_paid = sum(charged.values()), sum(paid.values())
    print(f"clients: {len(clients)}; sheets passed over (empty, their code is on another sheet): {len(passed_over)}")
    print(f"opening debts: {money(opening)}")
    print(f"trips of before: {len({line['trip'] for line in lines})}, sums of clients: {len(lines)}, charged {money(total_charged)}")
    print(f"payments of before: {len([p for p in payments if not p['note']])}, {money(sum(p['amount'] for p in payments if not p['note']))}; discounts: {len([p for p in payments if p['note']])}, {money(sum(p['amount'] for p in payments if p['note']))}")
    print(f"the debts at the end of what was read: {money(opening + total_charged - total_paid)}")
    if listed and cut is None:
        print(f"the list «КЛИЕНТЫ» closes with {money(sum(entry['closing'] for entry in listed.values()))} (without the clients who came once)")
    if spread:
        print(f"note: trips whose lines are dated more than a month apart (the day most lines say is taken): {len(spread)}")
    kinds = collections.Counter(re.sub(r"\(.*?\)|«.*?»|\d+[.,]\d+|А\d+(-\d+)?", "", row["what"]).strip() for row in problems.rows)
    print(f"to look at: {len(problems.rows)}" + ("" if not problems.rows else ", in question " + money(sum(abs(row["money"]) for row in problems.rows))))
    for kind, count in kinds.most_common():
        print(f"  {count:4d}  {kind}")

    if problems.rows and not args.force:
        sys.exit(f"The history was not written: {len(problems.rows)} places need a person" + (f" (see {args.problems})" if args.problems else " (--problems <file.csv> lists them)") + ". With --force they are left out.")

    by_trip = collections.defaultdict(collections.Counter)
    for line in lines:
        by_trip[line["trip"]][line["code"]] += line["sum"]
    history = {
        "clientCodes": "letter",
        "clients": [{"code": code, "name": entry["name"], "openingDebtMinor": cents(entry["opening"])} for code, entry in clients.items() if entry["name"]],
        "trips": [
            {"number": trip, "arrivalDay": arrival[trip].isoformat(), "sums": [{"code": code, "amountMicro": int(round(total * 1_000_000))} for code, total in sums.items()]}
            for trip, sums in sorted(by_trip.items())
        ],
        "payments": [
            {"code": payment["code"], "day": payment["day"].isoformat(), "amountMinor": cents(payment["amount"]), **({"note": payment["note"]} if payment["note"] else {})}
            for payment in sorted(payments, key=lambda item: (item["day"], item["code"]))
        ],
        "waybills": [],
        "control": [],
    }
    with open(args.out, "w", encoding="utf-8") as out:
        json.dump(history, out, ensure_ascii=False, separators=(",", ":"))
    print(f"written: {args.out}")


if __name__ == "__main__":
    main()
