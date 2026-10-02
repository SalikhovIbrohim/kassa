-- Which categories the Telegram group is told about (the owner ticks them), and which topic of the group a message goes to
-- (the incomes have one, the expenses another). The owner wants every expense, and of the incomes the payments of clients.
ALTER TABLE categories ADD COLUMN notify_group boolean NOT NULL DEFAULT true;
UPDATE categories SET notify_group = false WHERE kind = 'income' AND code <> 'client_payment';

ALTER TABLE telegram_outbox ADD COLUMN thread_id integer CHECK (thread_id IS NULL OR thread_id >= 1);
