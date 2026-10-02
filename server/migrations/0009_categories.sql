-- The categories of incomes and expenses move from the code into the database, so that the owner keeps
-- the lists himself. An operation names its category by code and the code is never reused: a category that
-- is no longer wanted is archived (hidden from the lists of new entries) and old entries keep reading it.
CREATE TABLE categories (
  code text PRIMARY KEY CHECK (code ~ '^[a-z0-9_]{1,40}$'),
  kind text NOT NULL CHECK (kind IN ('income', 'expense')),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 60),
  sort_order integer NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  -- An entry of this category names a client (the code of the client), and one of any other does not.
  requires_client boolean NOT NULL DEFAULT false,
  -- An expense that is not a cost of the business: money handed to the owner leaves the cash desk, nothing more.
  counts_as_cost boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'expense' OR counts_as_cost)
);
CREATE UNIQUE INDEX categories_label_key ON categories (kind, lower(btrim(label)));

-- The six expense categories that the code had (their codes are in the operations already), then the ones the
-- owner's own book has, then the incomes. The owner changes all of this from his screen.
INSERT INTO categories (code, kind, label, sort_order, requires_client, counts_as_cost) VALUES
  ('fuel_road', 'expense', 'Топливо и дорога', 1, false, true),
  ('salaries', 'expense', 'Зарплаты и выплаты', 2, false, true),
  ('household_repair', 'expense', 'Хозяйство и ремонт', 3, false, true),
  ('owner_handover', 'expense', 'Передача владельцу', 4, false, false),
  ('client_refund', 'expense', 'Возврат клиенту', 5, true, true),
  ('other', 'expense', 'Прочее', 6, false, true),
  ('freight_payment', 'expense', 'Оплата фура', 7, false, true),
  ('customs', 'expense', 'Таможня', 8, false, true),
  ('gazelle', 'expense', 'Оплата газель', 9, false, true),
  ('transport_taxi', 'expense', 'Транспорт и такси', 10, false, true),
  ('lunch_warehouse', 'expense', 'Обед Склад', 11, false, true),
  ('lunch_market', 'expense', 'Обед Рынок', 12, false, true),
  ('iftar', 'expense', 'Ифтор', 13, false, true),
  ('apartment', 'expense', 'Квартира расход', 14, false, true),
  ('office', 'expense', 'Офис расход', 15, false, true),
  ('warehouse', 'expense', 'Склад', 16, false, true),
  ('phone', 'expense', 'Связь (телефон)', 17, false, true),
  ('card', 'expense', 'Карта (комиссия и расходы)', 18, false, true),
  ('documents', 'expense', 'Документы', 19, false, true),
  ('car_repair', 'expense', 'Машина ремонт', 20, false, true),
  ('police', 'expense', 'Расход милиция', 21, false, true),
  ('tickets', 'expense', 'Билеты', 22, false, true),
  ('people_payout', 'expense', 'Выдача людям', 23, false, true),
  ('currency_dealer', 'expense', 'Перевод валютчик', 24, false, true),
  ('left_with', 'expense', 'Узда колган', 25, false, true),
  ('client_payment', 'income', 'Оплата от клиента', 1, true, true),
  ('debt_taken', 'income', 'Взяли долг', 2, false, true),
  ('sublease', 'income', 'Приход от субаренды', 3, false, true),
  ('debt_returned', 'income', 'Сотрудник вернул долг', 4, false, true),
  ('other_income', 'income', 'Прочее', 5, false, true);

-- The shape of an operation, with the category in the database: an expense has one (a row of the table), an income
-- has one too, except those written before there were categories of income; a client code and its search key
-- come together, and whether the category asks for one is for the application to check.
ALTER TABLE operations DROP CONSTRAINT operations_shape_check;
ALTER TABLE operations ADD CONSTRAINT operations_shape_check CHECK (
  (client_code IS NULL) = (client_code_key IS NULL)
  AND (
    (kind = 'income' AND recipient IS NULL)
    OR (kind = 'expense' AND category IS NOT NULL)
  )
);
ALTER TABLE operations ADD CONSTRAINT operations_category_fkey FOREIGN KEY (category) REFERENCES categories (code);
