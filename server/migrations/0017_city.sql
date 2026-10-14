-- A city a category or a person belongs to (Андижан, Москва), for the reports and for 1C. None means everywhere.
-- The cashiers do not see it: it changes nothing in their forms.
ALTER TABLE categories ADD COLUMN city text CHECK (city IN ('andijan', 'moscow'));
ALTER TABLE users ADD COLUMN city text CHECK (city IN ('andijan', 'moscow'));
