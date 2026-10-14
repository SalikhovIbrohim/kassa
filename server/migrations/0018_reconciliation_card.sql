-- What lay on the cards in rubles when the cash was counted. The rubles are one (cash and cards together), so the
-- rubles counted include it; it says only how they are split. Null for the counts of before.
ALTER TABLE reconciliations ADD COLUMN card_minor bigint CHECK (card_minor IS NULL OR card_minor >= 0);
