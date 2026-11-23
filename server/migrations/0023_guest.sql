-- The guest is shown the cash desk without being able to change it: he reads what the owner reads (but not the
-- directory of clients) and sees the entry forms, which save nothing for him. No route that writes lets him in.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('cashier', 'head_cashier', 'admin', 'viewer', 'guest'));
