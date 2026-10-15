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

-- =====================================================================
-- 4. "Boss" work record
-- =====================================================================

-- One row per working day (London date)
CREATE TABLE IF NOT EXISTS workdays (
  day          DATE PRIMARY KEY,
  clock_in     TIMESTAMPTZ,                  -- first clock-in; can't be overwritten
  clock_out    TIMESTAMPTZ,
  commitments  INT[] NOT NULL DEFAULT '{}',  -- task ids committed for the day
  eod_report   TEXT,
  eod_at       TIMESTAMPTZ
);

-- Permanent history of deadline/sprint/status changes, with reasons
CREATE TABLE IF NOT EXISTS task_events (
  id          SERIAL PRIMARY KEY,
  task_id     INT,                 -- no FK: history survives task deletion
  task_name   TEXT,
  kind        TEXT NOT NULL,       -- deadline_moved | sprint_moved | completed | reopened
  old_value   TEXT,
  new_value   TEXT,
  reason      TEXT,
  on_time     BOOLEAN,             -- for "completed": delivered by the deadline?
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_events_created_idx ON task_events (created_at);

-- 5. Trigger: no silent slipping.
--    Pushing a deadline later, clearing it, or moving to a later sprint
--    is refused unless a reason is supplied (app.reason, set by the server
--    for the current transaction). Every change is written to task_events.
CREATE OR REPLACE FUNCTION tasks_audit() RETURNS trigger AS $$
DECLARE
  why        TEXT := NULLIF(current_setting('app.reason', true), '');
  dl_slip    BOOLEAN := OLD.deadline IS NOT NULL AND (NEW.deadline IS NULL OR NEW.deadline > OLD.deadline);
  sp_slip    BOOLEAN := (NEW.sprint_year, NEW.sprint_number) > (OLD.sprint_year, OLD.sprint_number);
BEGIN
  IF (dl_slip OR sp_slip) AND OLD.status <> 'done' AND why IS NULL THEN
    RAISE EXCEPTION 'REASON_REQUIRED: "%" is being pushed back', OLD.name;
  END IF;

  IF NEW.deadline IS DISTINCT FROM OLD.deadline THEN
    INSERT INTO task_events (task_id, task_name, kind, old_value, new_value, reason)
    VALUES (NEW.id, NEW.name, 'deadline_moved', OLD.deadline::text, NEW.deadline::text, CASE WHEN dl_slip THEN why END);
  END IF;
  IF (NEW.sprint_year, NEW.sprint_number) IS DISTINCT FROM (OLD.sprint_year, OLD.sprint_number) THEN
    INSERT INTO task_events (task_id, task_name, kind, old_value, new_value, reason)
    VALUES (NEW.id, NEW.name, 'sprint_moved',
            OLD.sprint_year || '-S' || lpad(OLD.sprint_number::text, 2, '0'),
            NEW.sprint_year || '-S' || lpad(NEW.sprint_number::text, 2, '0'), CASE WHEN sp_slip THEN why END);
  END IF;
  IF NEW.status = 'done' AND OLD.status <> 'done' THEN
    INSERT INTO task_events (task_id, task_name, kind, new_value, on_time)
    VALUES (NEW.id, NEW.name, 'completed', NEW.deadline::text, NEW.deadline IS NULL OR now() <= NEW.deadline);
  ELSIF OLD.status = 'done' AND NEW.status <> 'done' THEN
    INSERT INTO task_events (task_id, task_name, kind) VALUES (NEW.id, NEW.name, 'reopened');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tasks_audit ON tasks;
CREATE TRIGGER tasks_audit
  AFTER UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_audit();
