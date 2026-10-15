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

-- 2b. Sprint-based planning (replaces exact dates; start_date/deadline are kept only as legacy data)
--     A sprint is stored as one comparable number: year*100 + sprint, e.g. 2026-S22 = 202622.
CREATE OR REPLACE FUNCTION sprint_key(d DATE) RETURNS INT IMMUTABLE LANGUAGE sql AS $$
  SELECT extract(year FROM d)::int * 100 + least((extract(doy FROM d)::int - 1) / 14 + 1, 26)
$$;
CREATE OR REPLACE FUNCTION current_sprint_key() RETURNS INT STABLE LANGUAGE sql AS $$
  SELECT sprint_key((now() AT TIME ZONE 'Europe/London')::date)
$$;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_sprint   INT;            -- e.g. 202621
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_sprint     INT;            -- deadline, as a sprint
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimate_hours NUMERIC(6,2) CHECK (estimate_hours >= 0);
ALTER TABLE tasks ALTER COLUMN start_date DROP NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_due_sprint_idx ON tasks (due_sprint);

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
  dl_slip    BOOLEAN := OLD.due_sprint IS NOT NULL AND (NEW.due_sprint IS NULL OR NEW.due_sprint > OLD.due_sprint);
  sp_slip    BOOLEAN := (NEW.sprint_year, NEW.sprint_number) > (OLD.sprint_year, OLD.sprint_number);
BEGIN
  IF (dl_slip OR sp_slip) AND OLD.status <> 'done' AND why IS NULL THEN
    RAISE EXCEPTION 'REASON_REQUIRED: "%" is being pushed back', OLD.name;
  END IF;

  IF NEW.due_sprint IS DISTINCT FROM OLD.due_sprint AND OLD.due_sprint IS NOT NULL THEN
    INSERT INTO task_events (task_id, task_name, kind, old_value, new_value, reason)
    VALUES (NEW.id, NEW.name, 'deadline_moved',
            (OLD.due_sprint / 100) || '-S' || lpad((OLD.due_sprint % 100)::text, 2, '0'),
            CASE WHEN NEW.due_sprint IS NULL THEN 'none' ELSE (NEW.due_sprint / 100) || '-S' || lpad((NEW.due_sprint % 100)::text, 2, '0') END,
            CASE WHEN dl_slip THEN why END);
  END IF;
  IF (NEW.sprint_year, NEW.sprint_number) IS DISTINCT FROM (OLD.sprint_year, OLD.sprint_number) THEN
    INSERT INTO task_events (task_id, task_name, kind, old_value, new_value, reason)
    VALUES (NEW.id, NEW.name, 'sprint_moved',
            OLD.sprint_year || '-S' || lpad(OLD.sprint_number::text, 2, '0'),
            NEW.sprint_year || '-S' || lpad(NEW.sprint_number::text, 2, '0'), CASE WHEN sp_slip THEN why END);
  END IF;
  IF NEW.status = 'done' AND OLD.status <> 'done' THEN
    INSERT INTO task_events (task_id, task_name, kind, new_value, on_time)
    VALUES (NEW.id, NEW.name, 'completed',
            CASE WHEN NEW.due_sprint IS NULL THEN NULL ELSE (NEW.due_sprint / 100) || '-S' || lpad((NEW.due_sprint % 100)::text, 2, '0') END,
            NEW.due_sprint IS NULL OR current_sprint_key() <= NEW.due_sprint);   -- on time = done by the end of the due sprint
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

-- =====================================================================
-- 6. Scrum ceremonies (summaries of what Jawad told the boss)
-- =====================================================================
CREATE TABLE IF NOT EXISTS ceremonies (
  id             SERIAL PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('daily_scrum', 'sprint_planning', 'sprint_review', 'retrospective')),
  day            DATE NOT NULL,                 -- London date it was held
  sprint_year    INT  NOT NULL,
  sprint_number  INT  NOT NULL,
  summary        TEXT NOT NULL,                 -- Claude's short summary
  details        JSONB NOT NULL DEFAULT '{}',   -- structured answers (yesterday/today/blockers, goal, went_well…)
  task_ids       INT[] NOT NULL DEFAULT '{}',   -- tasks discussed / committed
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One daily scrum per day; one planning/review/retro per sprint (re-recording updates it)
CREATE UNIQUE INDEX IF NOT EXISTS ceremonies_daily_uq  ON ceremonies (day) WHERE kind = 'daily_scrum';
CREATE UNIQUE INDEX IF NOT EXISTS ceremonies_sprint_uq ON ceremonies (kind, sprint_year, sprint_number) WHERE kind <> 'daily_scrum';

-- =====================================================================
-- 7. One-off conversion of existing tasks from dates to sprints
--    (runs only while some task is missing a start/due sprint; triggers paused so
--     "last updated" and the audit log aren't touched by the conversion)
-- =====================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tasks WHERE start_sprint IS NULL OR due_sprint IS NULL) THEN
    ALTER TABLE tasks DISABLE TRIGGER tasks_before_update;
    ALTER TABLE tasks DISABLE TRIGGER tasks_audit;
    UPDATE tasks SET
      start_sprint = COALESCE(start_sprint, sprint_key(start_date), sprint_year * 100 + sprint_number),
      due_sprint   = COALESCE(due_sprint, sprint_key((deadline AT TIME ZONE 'Europe/London')::date), sprint_year * 100 + sprint_number)
    WHERE start_sprint IS NULL OR due_sprint IS NULL;
    ALTER TABLE tasks ENABLE TRIGGER tasks_before_update;
    ALTER TABLE tasks ENABLE TRIGGER tasks_audit;
  END IF;
END $$;
