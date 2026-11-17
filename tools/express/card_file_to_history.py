#!/usr/bin/env python3
"""
Makes the history file that `import-history` loads (see server/src/admin/history.ts) from the spreadsheets one
business keeps: its card file of clients («Картотека клиентов 2026 (по дням).xlsx») and the waybills of the trips that
are still on the road («247 ... 06.11.2026.xlsx»). Nothing is written but the JSON file; the spreadsheets are only read.

    python3 -I tools/express/card_file_to_history.py --card <card file.xlsx> --out history.json \
        [--waybill <waybill.xlsx> ...] [--name 413=Ахмад ...]

What it reads from the card file:
  «Рейсы 2026»      a row to a client (№, name, code), a column to a trip («67 Рейс / 03.01.26»: the number and the day
                    it arrived), in a cell what the client owes for the trip. Columns named after months are subtotals.
  «Январь 26» ...   a row to a client, a column to a day: what the client paid that day. The color of the letters says
                    where: blue in Tashkent, green in Andijan, any other in Moscow. A cell that adds a payment of
                    Moscow to one of another city («=939+3000») says which is which in its note.
                    «Остаток прошлого месяца» of the first month a client is on is what they owed at the start.
  «Контроль»        the debts of all the clients month by month: copied into the file, for `import-history` to compare
                    what it loaded with.
A client is a code and a name: a row without a name that owes nothing and has nothing is passed over; one that has
anything needs its name said with --name.

What it reads from a waybill (the sheet «ДС»): the lines under the header (ПОЛУЧАТЕЛЬ, КОД, ...), the day of loading
above it, the driver and the plates below. The day the truck left is the day in the name of the file. The first column
says where on the truck a line lies («ГОЛОВА 3», «ПРИЦЕП 5») and, for cargo that is not of the first warehouse, which
warehouse («КУКОН ГОЛОВА 1» is Kokand, «ТОШКЕНТ ...» Tashkent). «РАСХОД» and «ВЕС» are not taken: the weight is
«ОБЩИЙ ВЕС».
"""
import argparse
import datetime
import json
import re
import sys

import openpyxl

MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"]
# The letters of a payment: where it was taken.
BLUE, GREEN = "FF0000FF", "FF00B050"
CITY_OF_COLOR = {BLUE: "tashkent", GREEN: "andijan"}
CITY_OF_WORD = {"москв": "moscow", "ташкент": "tashkent", "тошкент": "tashkent", "андижан": "andijan", "андижон": "andijan"}


def fail(message):
    sys.exit(f"Error: {message}")


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def text(value):
    return "" if value is None else str(value).replace("\n", " ").strip()


def cents(value):
    """Dollars as a spreadsheet has them into whole cents, half up."""
    return int((value * 100 + 0.5) // 1) if value >= 0 else -int((-value * 100 + 0.5) // 1)


def font_city(cell):
    color = cell.font.color if cell.font else None
    rgb = color.rgb if color is not None and isinstance(color.rgb, str) else None
    return CITY_OF_COLOR.get(rgb, "moscow")


def read_card(path, names):
    values = openpyxl.load_workbook(path, data_only=True)
    raw = openpyxl.load_workbook(path, data_only=False)
    trips_sheet = next((name for name in values.sheetnames if name.startswith("Рейсы")), None)
    if trips_sheet is None:
        fail(f"{path} has no sheet «Рейсы ...»")
    year = 2000 + int(re.search(r"(\d{2,4})\s*$", trips_sheet).group(1)[-2:])

    # ---- the clients and the trips
    sheet, raw_sheet = values[trips_sheet], raw[trips_sheet]
    header = [text(cell.value) for cell in sheet[1]]
    trip_columns = []
    for index, title in enumerate(header):
        found = re.match(r"^(\d+)\s*Рейс\s*(\d{2})\.(\d{2})\.(\d{2})$", title)
        if found:
            trip_columns.append((index, int(found.group(1)), f"20{found.group(4)}-{found.group(3)}-{found.group(2)}"))
        elif index >= 3 and title and title not in MONTHS:
            fail(f"«{trips_sheet}»: the column «{title}» is neither a trip («67 Рейс 03.01.26») nor a month")
    clients = {}
    order = []
    sums = {number_: [] for _, number_, _ in trip_columns}
    for row, raw_row in zip(sheet.iter_rows(min_row=2), raw_sheet.iter_rows(min_row=2)):
        if not number(row[0].value):
            continue
        code = row[2].value
        if not number(code) or int(code) != code:
            fail(f"«{trips_sheet}», row {row[0].row}: the code «{code}» is not a whole number")
        code = str(int(code))
        if code in clients:
            fail(f"«{trips_sheet}»: the code {code} is there twice")
        clients[code] = {"code": code, "name": names.get(code) or text(row[1].value), "openingDebtMinor": None, "has": False}
        order.append(code)
        for index, trip, _ in trip_columns:
            value = row[index].value
            if value is None or value == 0:
                continue
            if not number(value) or value < 0:
                fail(f"trip {trip}, client {code}: «{value}» is not a sum")
            note = raw_row[index].comment.text.strip() if raw_row[index].comment else None
            sums[trip].append({"code": code, "amountMicro": int(round(value * 1_000_000)), **({"note": note} if note else {})})
            clients[code]["has"] = True

    # ---- the payments, month by month
    payments = []
    for month_index, month in enumerate(MONTHS, start=1):
        name = next((candidate for candidate in values.sheetnames if candidate.startswith(month + " ")), None)
        if name is None:
            continue
        sheet, raw_sheet = values[name], raw[name]
        header = [text(cell.value) for cell in sheet[1]]
        days = [(index, int(title[:2])) for index, title in enumerate(header) if re.match(r"^\d{2}\.", title)]
        opening_at = header.index("Остаток прошлого месяца")
        for row, raw_row in zip(sheet.iter_rows(min_row=2), raw_sheet.iter_rows(min_row=2)):
            if not number(row[0].value):
                continue
            code = str(int(row[2].value))
            if code not in clients:
                fail(f"«{name}», row {row[0].row}: the client {code} is not on «{trips_sheet}»")
            client = clients[code]
            if client["openingDebtMinor"] is None:
                # The first month the client is on: what they owed when it began is what they owed at the start.
                client["openingDebtMinor"] = cents(row[opening_at].value or 0)
                if client["openingDebtMinor"]:
                    client["has"] = True
                    client["openingMonth"] = month_index
            for index, day in days:
                value = row[index].value
                if value is None or value == 0:
                    continue
                if not number(value) or value < 0:
                    fail(f"«{name}», client {code}, day {day}: «{value}» is not a payment")
                when = f"{year}-{month_index:02d}-{day:02d}"
                cell = raw_row[index]
                note = cell.comment.text.strip() if cell.comment else None
                parts = split_cities(cell.value, note) if isinstance(cell.value, str) and cell.value.startswith("=") else None
                if parts and sum(amount for amount, _ in parts) == cents(value):
                    for amount, city in parts:
                        payments.append({"code": code, "day": when, "amountMinor": amount, "kassa": city})
                else:
                    payments.append({"code": code, "day": when, "amountMinor": cents(value), "kassa": font_city(cell), **({"note": note} if note else {})})
                client["has"] = True

    # ---- the control sheet
    control = []
    if "Контроль" in values.sheetnames:
        for row in values["Контроль"].iter_rows(min_row=2, values_only=True):
            if text(row[0]) in MONTHS and all(number(value) for value in row[1:5]):
                control.append({
                    "month": f"{year}-{MONTHS.index(text(row[0])) + 1:02d}",
                    "openingMinor": cents(row[1]), "chargedMinor": cents(row[2]), "paidMinor": cents(row[3]), "closingMinor": cents(row[4]),
                })

    # ---- a client is a code and a name
    kept, passed_over, nameless = [], [], []
    for code in order:
        client = clients[code]
        if client["name"]:
            kept.append({"code": code, "name": client["name"], "openingDebtMinor": client["openingDebtMinor"] or 0})
        elif client["has"]:
            nameless.append(code)
        else:
            passed_over.append(code)
    if nameless:
        fail(f"these clients have trips or payments and no name: {', '.join(nameless)}. Say their names: --name {nameless[0]}=Имя")
    late = [(code, clients[code]["openingMonth"]) for code in order if clients[code].get("openingMonth", 1) > 1]
    trips = [{"number": trip, "arrivalDay": day, "sums": sums[trip]} for _, trip, day in trip_columns]
    return {"clients": kept, "trips": trips, "payments": payments, "control": control}, passed_over, late


def split_cities(formula, note):
    """«=939+3000» with the note «939 — оплата в Москве, 3000 — оплата в Андижане»: two payments, each with its city."""
    amounts = re.fullmatch(r"=\s*(\d+(?:[.,]\d+)?)\s*\+\s*(\d+(?:[.,]\d+)?)\s*", formula)
    if not amounts or not note:
        return None
    parts = []
    for amount in amounts.groups():
        found = re.search(rf"(?<![\d.,]){re.escape(amount)}\s*[—–-]\s*оплата в (\w+)", note)
        city = next((kassa for word, kassa in CITY_OF_WORD.items() if found and found.group(1).lower().startswith(word)), None)
        if city is None:
            return None
        parts.append((cents(float(amount.replace(",", "."))), city))
    return parts


def read_waybill(path, clients):
    name = re.sub(r"^.*[\\/]", "", path)
    name = re.sub(r"^[0-9a-f]{8}-", "", name)  # the mark an upload puts before the name of a file
    found = re.match(r"^(\d+)", name)
    if not found:
        fail(f"{path}: the name of the file does not begin with the number of the trip")
    trip = int(found.group(1))
    dated = re.search(r"(\d{2})\.(\d{2})\.(\d{4})(?=\.xlsx$)", name)
    departure = f"{dated.group(3)}-{dated.group(2)}-{dated.group(1)}" if dated else None

    sheet = openpyxl.load_workbook(path, data_only=True).worksheets[0]
    rows = [[cell for cell in row] for row in sheet.iter_rows(values_only=True)]
    head_at = next((index for index, row in enumerate(rows) if any(text(value).upper() == "ПОЛУЧАТЕЛЬ" for value in row)), None)
    if head_at is None:
        fail(f"{path}: no header with «ПОЛУЧАТЕЛЬ»")
    head = [text(value).upper() for value in rows[head_at]]
    at = lambda title: next((index for index, value in enumerate(head) if value.startswith(title)), None)
    col = {"receiver": at("ПОЛУЧАТЕЛЬ"), "code": at("КОД"), "phone": at("ТЕЛЕФОН"), "item": at("НАИМЕНОВАНИЕ"), "bags": at("МЕСТА"), "packaging": at("ВИД"),
           "pieces": at("КОЛ-ВО"), "weight": at("ОБЩИЙ ВЕС"), "price": at("ЦЕНА"), "sender": at("ОТПРАВИТЕЛЬ"), "day": at("ДАТА")}
    missing = [key for key, index in col.items() if index is None]
    if missing:
        fail(f"{path}: the header has no column for {', '.join(missing)}")
    brand_at = col["phone"] + 1  # the column without a title between the phone and the goods

    loading = next((value for row in rows[:head_at] for value in row if isinstance(value, datetime.datetime)), None)
    loading_day = loading.date() if loading else None
    direction = next((text(row[index + 1]) for row in rows[:head_at] for index, value in enumerate(row[:-1]) if text(value).lower().startswith("направление")), None)

    lines = []
    for row in rows[head_at + 1:]:
        code, weight, price = row[col["code"]], row[col["weight"]], row[col["price"]]
        if not (number(code) and number(weight) and number(price)):
            continue
        code = str(int(code))
        if code not in clients:
            fail(f"waybill {trip}: the client {code} is not in the card file")
        place = text(row[0]).upper()
        warehouse = "kokand" if re.search(r"КУКОН|КОКАН|КОКОН|ҚЎҚОН", place) else "tashkent" if re.search(r"ТОШКЕНТ|ТАШКЕНТ", place) else "andijan"
        part = "head" if "ГОЛОВА" in place else "trailer" if "ПРИЦЕП" in place else None
        accepted = None
        if number(row[col["day"]]) and loading_day:
            day = int(row[col["day"]])
            # The day of the month the cargo was taken in: of the month of the loading, or of the one before it.
            month = loading_day.replace(day=1)
            if day > loading_day.day + 7:
                month = (month - datetime.timedelta(days=1)).replace(day=1)
            try:
                accepted = month.replace(day=day).isoformat()
            except ValueError:
                accepted = None
        whole = lambda value: int(round(value)) if number(value) else None
        lines.append({
            "warehouse": warehouse, "truckPart": part, "acceptedDay": accepted, "code": code,
            "receiver": re.sub(r"\s*\d+\s*$", "", text(row[col["receiver"]])) or None,
            "receiverPhone": text(row[col["phone"]]) or None, "brand": text(row[brand_at]) or None, "item": text(row[col["item"]]) or None,
            "bags": whole(row[col["bags"]]), "packaging": text(row[col["packaging"]]) or None, "pieces": whole(row[col["pieces"]]),
            "weightG": int(round(weight * 1000)), "priceMilli": int(round(price * 1000)), "sender": text(row[col["sender"]]) or None,
        })
    if not lines:
        fail(f"{path}: no line of cargo was found")

    # Under the lines: «Общий: 735 мест - 22629 кг.», then the driver with a phone, then the plates of the truck.
    foot = [text(value) for row in rows[head_at + 1:] for value in row if isinstance(value, str) and text(value)]
    total_at = next((index for index, value in enumerate(foot) if value.lower().startswith("общий")), None)
    driver, phone, plates = None, None, None
    if total_at is not None and total_at + 1 < len(foot):
        split = re.match(r"^(.*?)\s*(\+?\d[\d\s]{6,})$", foot[total_at + 1])
        driver, phone = (split.group(1).strip() or None, split.group(2).strip()) if split else (foot[total_at + 1], None)
        plates = foot[total_at + 2] if total_at + 2 < len(foot) else None
    return {
        "number": trip, "status": "in_transit", "loadingDay": loading_day.isoformat() if loading_day else None, "departureDay": departure or (loading_day.isoformat() if loading_day else None),
        "direction": direction, "driverName": driver, "driverPhone": phone, "truckPlates": plates, "lines": lines,
    }


def main():
    parser = argparse.ArgumentParser(description="The card file and the waybills of a business as one history file for import-history.")
    parser.add_argument("--card", required=True, help="the card file of clients (.xlsx)")
    parser.add_argument("--waybill", action="append", default=[], help="the waybill of a trip that is on the road (.xlsx); may be given many times")
    parser.add_argument("--name", action="append", default=[], help="CODE=NAME: the name of a client the card file has without one")
    parser.add_argument("--out", required=True, help="the history file to write (.json)")
    args = parser.parse_args()
    names = dict(item.split("=", 1) for item in args.name)

    history, passed_over, late = read_card(args.card, names)
    codes = {client["code"] for client in history["clients"]}
    history["waybills"] = sorted((read_waybill(path, codes) for path in args.waybill), key=lambda waybill: waybill["number"])
    arrived = {trip["number"] for trip in history["trips"]}
    both = [waybill["number"] for waybill in history["waybills"] if waybill["number"] in arrived]
    if both:
        fail(f"these trips are in the card file as arrived and among the waybills on the road: {both}")
    with open(args.out, "w", encoding="utf-8") as out:
        json.dump(history, out, ensure_ascii=False, separators=(",", ":"))

    # What was read, and whether it adds up the way the cash desk will add it up: a client owes for a trip to the cent.
    money = lambda minor: f"{minor / 100:,.2f}".replace(",", " ")
    print(f"clients: {len(history['clients'])} (passed over, empty and nameless: {', '.join(passed_over) or 'none'})")
    print(f"opening debts: {money(sum(client['openingDebtMinor'] for client in history['clients']))}")
    if late:
        print(f"note: clients whose opening debt is of a later month than the first: {late}")
    print(f"trips of before: {len(history['trips'])} ({history['trips'][0]['number']}–{history['trips'][-1]['number']}), sums of clients: {sum(len(trip['sums']) for trip in history['trips'])}")
    by_city = {}
    for payment in history["payments"]:
        by_city[payment["kassa"]] = by_city.get(payment["kassa"], 0) + payment["amountMinor"]
    print(f"payments of before: {len(history['payments'])}: " + ", ".join(f"{city} {money(total)}" for city, total in sorted(by_city.items())))
    for waybill in history["waybills"]:
        micro = sum(line["weightG"] * line["priceMilli"] for line in waybill["lines"])
        print(f"waybill {waybill['number']}: loaded {waybill['loadingDay']}, left {waybill['departureDay']}, {len(waybill['lines'])} lines, "
              f"{sum(line['weightG'] for line in waybill['lines']) / 1000:g} kg, {money((micro + 5000) // 10000)}; {waybill['driverName']} {waybill['driverPhone']}, {waybill['truckPlates']}")
    debt = sum(client["openingDebtMinor"] for client in history["clients"])
    print("month      opening        charged           paid        closing   the control sheet")
    for month in sorted({trip["arrivalDay"][:7] for trip in history["trips"]} | {payment["day"][:7] for payment in history["payments"]}):
        charged = sum((amount["amountMicro"] + 5000) // 10000 for trip in history["trips"] if trip["arrivalDay"][:7] == month for amount in trip["sums"])
        paid = sum(payment["amountMinor"] for payment in history["payments"] if payment["day"][:7] == month)
        said = next((item for item in history["control"] if item["month"] == month), None)
        closing = debt + charged - paid
        print(f"{month} {money(debt):>14} {money(charged):>14} {money(paid):>14} {money(closing):>14}   "
              + (f"{money(said['closingMinor']):>14}  {'the same' if said['closingMinor'] == closing else 'apart by ' + money(closing - said['closingMinor'])}" if said else "(not there)"))
        debt = closing
    print(f"written: {args.out}")


if __name__ == "__main__":
    main()
