-- What lay on the cards in rubles when the cash was counted. Only for the record and the message to the group: the
-- book of the cash desk does not count it. Null for the counts of before.
ALTER TABLE reconciliations ADD COLUMN card_minor bigint CHECK (card_minor IS NULL OR card_minor >= 0);
