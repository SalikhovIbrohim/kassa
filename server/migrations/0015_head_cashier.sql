-- The head cashier is a cashier who also reconciles the cash desk ("Сверить кассу"); from now on only he does.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('cashier', 'head_cashier', 'admin', 'viewer'));
