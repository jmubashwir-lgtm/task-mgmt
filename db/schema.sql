-- Polygon Tasks: database schema
-- Safe to run more than once (IF NOT EXISTS / OR REPLACE).

-- 1. Categories: created on the fly by the user
CREATE TABLE IF NOT EXISTS categories (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  color       TEXT NOT NULL DEFAULT '#65BC7B',   -- one of the brand accent colours
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Tasks
CREATE TABLE IF NOT EXISTS tasks (
  id                   SERIAL PRIMARY KEY,
  name                 TEXT NOT NULL,
  category_id          INT REFERENCES categories(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'todo'
                         CHECK (status IN ('todo', 'in_progress', 'done')),
  notes                TEXT,
  start_date           DATE NOT NULL DEFAULT CURRENT_DATE,  -- left edge of the Gantt bar
  deadline             TIMESTAMPTZ,                         -- right edge of the Gantt bar
  sprint_year          INT NOT NULL,
  sprint_number        INT NOT NULL CHECK (sprint_number BETWEEN 1 AND 26),
  sprint_update_count  INT NOT NULL DEFAULT 0,
  position             DOUBLE PRECISION NOT NULL DEFAULT 0, -- order inside a column (drag & drop)
  calendar_event_id    TEXT,                                -- Google Calendar block linked to this task
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_sprint_idx   ON tasks (sprint_year, sprint_number);
CREATE INDEX IF NOT EXISTS tasks_deadline_idx ON tasks (deadline);

-- 3. Trigger: keeps "last updated" and "sprint updated count" correct
--    no matter who edits the task (web UI, Claude, or SQL).
CREATE OR REPLACE FUNCTION tasks_before_update() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  IF (NEW.sprint_year, NEW.sprint_number) IS DISTINCT FROM (OLD.sprint_year, OLD.sprint_number) THEN
    NEW.sprint_update_count := OLD.sprint_update_count + 1;
  END IF;
  -- created_at and the counter can never be overwritten directly
  NEW.created_at := OLD.created_at;
  IF (NEW.sprint_year, NEW.sprint_number) IS NOT DISTINCT FROM (OLD.sprint_year, OLD.sprint_number) THEN
    NEW.sprint_update_count := OLD.sprint_update_count;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tasks_before_update ON tasks;
CREATE TRIGGER tasks_before_update
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_before_update();
