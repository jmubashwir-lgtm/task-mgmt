// All task/category logic lives here. Both the web API and (Step 3) the
// Claude MCP endpoint call these same functions, so behaviour is identical.
const { pool } = require('./db');
const { sprintFor, sprintRange } = require('./sprint');

// Brand accents. Order spreads contrast; the guideline's 'Green' hex (#5C47C7) is a typo,
// so the swatch colour is used instead.
const ACCENTS = ['#383AFF', '#FB7C46', '#8146FF', '#7CFE86', '#FF3CE1', '#7BFDFD', '#FC3A5D', '#FCED67'];
const STATUSES = ['todo', 'in_progress', 'done'];
const EDITABLE = ['name', 'category_id', 'status', 'notes', 'start_date', 'deadline',
                  'sprint_year', 'sprint_number', 'position', 'calendar_event_id'];

class BadRequest extends Error { constructor(m) { super(m); this.status = 400; } }
class NotFound extends Error { constructor(m) { super(m); this.status = 404; } }

const TASK_SELECT = `
  SELECT t.*, c.name AS category_name, c.color AS category_color
  FROM tasks t LEFT JOIN categories c ON c.id = t.category_id`;

// ---------- categories ----------
async function listCategories() {
  return (await pool.query('SELECT * FROM categories ORDER BY name')).rows;
}

async function createCategory({ name, color }) {
  if (!name || !name.trim()) throw new BadRequest('Category name is required');
  const count = (await pool.query('SELECT count(*)::int AS n FROM categories')).rows[0].n;
  const { rows } = await pool.query(
    `INSERT INTO categories (name, color) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING *`,
    [name.trim(), color || ACCENTS[count % ACCENTS.length]]);
  return rows[0];
}

async function updateCategory(id, { name, color }) {
  const { rows } = await pool.query(
    `UPDATE categories SET name = COALESCE($2, name), color = COALESCE($3, color)
     WHERE id = $1 RETURNING *`, [id, name, color]);
  if (!rows[0]) throw new NotFound('Category not found');
  return rows[0];
}

async function deleteCategory(id) {
  await pool.query('DELETE FROM categories WHERE id = $1', [id]);
}

// Accept either category_id or a category name (creates the category if new).
async function resolveCategory(input) {
  if (input.category && !input.category_id) {
    input.category_id = (await createCategory({ name: input.category })).id;
  }
  delete input.category;
}

// ---------- tasks ----------
// A deadline with no timezone ("2026-10-20 17:00" or "2026-10-20") means London time.
function londonToIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(String(s).trim());
  if (!m) return s;                                   // already has Z / +01:00 etc.
  const [, y, mo, d, h = '17', mi = '00'] = m;        // date only → 5pm
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi);
  // London offset at that moment (0 in winter, +60 min in summer)
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asLondon = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(guess - (asLondon - guess)).toISOString();
}

function validate(t) {
  if (t.deadline) {
    t.deadline = londonToIso(t.deadline);
    if (Number.isNaN(Date.parse(t.deadline))) throw new BadRequest('deadline is not a valid date');
  }
  if (t.status !== undefined && !STATUSES.includes(t.status)) throw new BadRequest(`status must be one of ${STATUSES.join(', ')}`);
  if (t.sprint_number !== undefined && (t.sprint_number < 1 || t.sprint_number > 26)) throw new BadRequest('sprint_number must be 1-26');
}

async function listTasks(f = {}) {
  const where = [], args = [];
  const add = (sql, v) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
  if (f.status) add('t.status = ?', f.status);
  if (f.category_id) add('t.category_id = ?', Number(f.category_id));
  if (f.sprint_year) add('t.sprint_year = ?', Number(f.sprint_year));
  if (f.sprint_number) add('t.sprint_number = ?', Number(f.sprint_number));
  if (f.overdue === 'true' || f.overdue === true) where.push(`t.deadline < now() AND t.status <> 'done'`);
  if (f.q) add('t.name ILIKE ?', `%${f.q}%`);
  const sql = `${TASK_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY t.position, t.id`;
  return (await pool.query(sql, args)).rows;
}

async function getTask(id) {
  const { rows } = await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [id]);
  if (!rows[0]) throw new NotFound('Task not found');
  return rows[0];
}

async function createTask(input) {
  if (!input.name || !input.name.trim()) throw new BadRequest('Task name is required');
  await resolveCategory(input);
  validate(input);
  // Default sprint = the sprint containing the deadline, else today's sprint.
  if (!input.sprint_number) {
    const s = sprintFor(input.deadline ? new Date(input.deadline) : new Date());
    input.sprint_year = s.year; input.sprint_number = s.number;
  }
  if (!input.sprint_year) input.sprint_year = sprintFor().year;
  // Start date defaults to today in London (the DB server runs in UTC).
  if (!input.start_date) {
    input.start_date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  }
  // New tasks go to the bottom of their column.
  if (input.position === undefined) {
    input.position = (await pool.query('SELECT COALESCE(max(position), 0) + 1 AS p FROM tasks')).rows[0].p;
  }
  const cols = EDITABLE.filter((k) => input[k] !== undefined);
  const { rows } = await pool.query(
    `INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    cols.map((k) => input[k]));
  return getTask(rows[0].id);
}

async function updateTask(id, input) {
  await resolveCategory(input);
  validate(input);
  const cols = EDITABLE.filter((k) => input[k] !== undefined);
  if (!cols.length) return getTask(id);
  const { rowCount } = await pool.query(
    `UPDATE tasks SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [id, ...cols.map((k) => input[k])]);
  if (!rowCount) throw new NotFound('Task not found');
  return getTask(id);
}

async function deleteTask(id) {
  const { rows } = await pool.query('DELETE FROM tasks WHERE id = $1 RETURNING id, calendar_event_id', [id]);
  if (!rows[0]) throw new NotFound('Task not found');
  return rows[0];
}

// Overview used by Claude and the UI header.
async function summary() {
  const cur = sprintFor();
  const { rows } = await pool.query(`
    SELECT
      (count(*) FILTER (WHERE status <> 'done' AND deadline < now()))::int                        AS overdue,
      (count(*) FILTER (WHERE status <> 'done' AND deadline >= now()
                         AND deadline < now() + interval '7 days'))::int                          AS due_this_week,
      (count(*) FILTER (WHERE sprint_year = $1 AND sprint_number = $2 AND status <> 'done'))::int AS open_in_sprint,
      (count(*) FILTER (WHERE sprint_year = $1 AND sprint_number = $2 AND status = 'done'))::int  AS done_in_sprint
    FROM tasks`, [cur.year, cur.number]);
  return { current_sprint: sprintRange(cur.year, cur.number), ...rows[0] };
}

module.exports = {
  listCategories, createCategory, updateCategory, deleteCategory,
  listTasks, getTask, createTask, updateTask, deleteTask, summary,
  sprintFor, sprintRange, STATUSES,
};
