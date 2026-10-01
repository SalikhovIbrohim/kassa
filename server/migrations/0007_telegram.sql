-- A Telegram account linked to a login: from then on the Mini App signs that person in by itself. One account per
-- login and one login per account.
ALTER TABLE users ADD COLUMN telegram_id bigint;
CREATE UNIQUE INDEX users_telegram_id_key ON users (telegram_id) WHERE telegram_id IS NOT NULL;
