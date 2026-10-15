// All task/category logic lives here. Both the web API and (Step 3) the
// Claude MCP endpoint call these same functions, so behaviour is identical.
const { pool } = require('./db');
const { sprintFor, sprintRange, workingDays, key, keyLabel, currentKey, parseSprint } = require('./sprint');

// Brand accents. Order spreads contrast; the guideline's 'Green' hex (#5C47C7) is a typo,
// so the swatch colour is used instead.
const ACCENTS = ['#383AFF', '#FB7C46', '#8146FF', '#7CFE86', '#FF3CE1', '#7BFDFD', '#FC3A5D', '#FCED67'];
const STATUSES = ['todo', 'in_progress', 'done'];
const EDITABLE = ['name', 'category_id', 'status', 'notes', 'start_sprint', 'due_sprint', 'estimate_hours',
                  'sprint_year', 'sprint_number', 'position', 'calendar_event_id'];
const HOURS_PER_DAY = 8;   // capacity assumption for sprint planning

class BadRequest extends Error { constructor(m) { super(m); this.status = 400; } }
class NotFound extends Error { constructor(m) { super(m); this.status = 404; } }

// Run writes in one transaction, handing the "reason" to the database trigger.
// The trigger refuses any deadline/sprint slip that arrives without one.
async function tx(reason, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL TIME ZONE 'Europe/London'`);
    await client.query(`SELECT set_config('app.reason', $1, true)`, [reason ? String(reason).trim() : '']);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (/REASON_REQUIRED/.test(e.message)) {
      const err = new BadRequest(`${e.message.replace(/^.*REASON_REQUIRED:\s*/, '')}. A reason is required to push a deadline or sprint back.`);
      err.code = 'REASON_REQUIRED';
      throw err;
    }
    throw e;
  } finally { client.release(); }
}

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
  // Legacy inputs: an exact date is converted to the sprint it falls in
  if (t.deadline !== undefined && t.due_sprint === undefined) t.due_sprint = t.deadline ? key(...Object.values(sprintFor(String(t.deadline).slice(0, 10)))) : null;
  if (t.start_date !== undefined && t.start_sprint === undefined) t.start_sprint = t.start_date ? key(...Object.values(sprintFor(String(t.start_date).slice(0, 10)))) : null;
  delete t.deadline; delete t.start_date;
  try {
    if (t.start_sprint !== undefined) t.start_sprint = parseSprint(t.start_sprint);
    if (t.due_sprint !== undefined) t.due_sprint = parseSprint(t.due_sprint);
  } catch (e) { throw new BadRequest(e.message); }
  if (t.start_sprint && t.due_sprint && t.start_sprint > t.due_sprint) throw new BadRequest('Start sprint must not be after the due sprint');
  if (t.estimate_hours !== undefined && t.estimate_hours !== null) {
    const h = Number(t.estimate_hours);
    if (!Number.isFinite(h) || h < 0 || h > 9999) throw new BadRequest('estimate_hours must be a number of hours (0 or more)');
    t.estimate_hours = Math.round(h * 4) / 4;   // quarter-hour precision
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
  if (f.overdue === 'true' || f.overdue === true) where.push(`t.due_sprint < current_sprint_key() AND t.status <> 'done'`);
  if (f.due_sprint) add('t.due_sprint = ?', parseSprint(f.due_sprint));
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
  // Defaults: worked in the current sprint, starting and due in that same sprint.
  // If only a due sprint is given, the task is planned into that sprint.
  if (!input.sprint_number) {
    const k = input.due_sprint || currentKey();
    input.sprint_year = Math.floor(k / 100); input.sprint_number = k % 100;
  }
  if (!input.sprint_year) input.sprint_year = sprintFor().year;
  const planned = key(input.sprint_year, input.sprint_number);
  if (!input.start_sprint) input.start_sprint = Math.min(planned, input.due_sprint || planned);
  if (input.due_sprint === undefined) input.due_sprint = Math.max(planned, input.start_sprint);
  if (input.due_sprint && input.start_sprint > input.due_sprint) throw new BadRequest('Start sprint must not be after the due sprint');
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
  const { rowCount } = await tx(input.reason, (c) => c.query(
    `UPDATE tasks SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [id, ...cols.map((k) => input[k])]));
  if (!rowCount) throw new NotFound('Task not found');
  return getTask(id);
}

async function deleteTask(id) {
  const { rows } = await pool.query('DELETE FROM tasks WHERE id = $1 RETURNING id, calendar_event_id', [id]);
  if (!rows[0]) throw new NotFound('Task not found');
  return rows[0];
}

// ---------- bulk ----------
// One UPDATE statement changes every selected task at once (all-or-nothing).
// Supported changes: status, category, sprint (set, or "next" relative to each task),
// due sprint (set, or shift each task's due sprint by N sprints), estimate.
function checkIds(ids) {
  if (!Array.isArray(ids) || !ids.length) throw new BadRequest('ids must be a non-empty array');
  if (ids.length > 500) throw new BadRequest('At most 500 tasks at a time');
  return ids.map((x) => { const n = Number(x); if (!Number.isInteger(n)) throw new BadRequest('ids must be integers'); return n; });
}

async function bulkUpdate(ids, input = {}) {
  ids = checkIds(ids);
  input = { ...input };
  await resolveCategory(input);
  validate(input);
  const set = [], args = [ids];
  const param = (v) => { args.push(v); return `$${args.length}`; };

  if (input.status !== undefined) set.push(`status = ${param(input.status)}`);
  if (input.category_id !== undefined) set.push(`category_id = ${param(input.category_id)}`);
  if (input.sprint_next) {
    // Every task moves one sprint forward from wherever it is (S26 rolls into next year's S01)
    set.push(`sprint_number = CASE WHEN sprint_number = 26 THEN 1 ELSE sprint_number + 1 END`);
    set.push(`sprint_year   = CASE WHEN sprint_number = 26 THEN sprint_year + 1 ELSE sprint_year END`);
  } else if (input.sprint_number !== undefined) {
    set.push(`sprint_number = ${param(input.sprint_number)}`);
    set.push(`sprint_year = ${param(input.sprint_year || sprintFor().year)}`);
  }
  if (input.due_sprint !== undefined) set.push(`due_sprint = ${param(input.due_sprint)}`);
  else if (input.due_shift_sprints) {
    const n = Number(input.due_shift_sprints);
    if (!Number.isInteger(n)) throw new BadRequest('due_shift_sprints must be an integer');
    // sprint key -> running sprint count -> shifted -> back to key (handles year boundaries)
    const ord = `((due_sprint / 100) * 26 + (due_sprint % 100) - 1 + ${param(n)})`;
    set.push(`due_sprint = CASE WHEN due_sprint IS NULL THEN NULL ELSE (${ord} / 26) * 100 + (${ord} % 26) + 1 END`);
  }
  if (input.estimate_hours !== undefined) set.push(`estimate_hours = ${param(input.estimate_hours)}`);
  if (!set.length) throw new BadRequest('Nothing to change');

  // London time zone inside tx(): "+1 day" keeps the same clock time across clock changes
  const { rows } = await tx(input.reason, (c) => c.query(`UPDATE tasks SET ${set.join(', ')} WHERE id = ANY($1) RETURNING id`, args));
  return { updated: rows.length, ids: rows.map((r) => r.id) };
}

async function bulkDelete(ids) {
  ids = checkIds(ids);
  const { rows } = await pool.query('DELETE FROM tasks WHERE id = ANY($1) RETURNING id, name, calendar_event_id', [ids]);
  return { deleted: rows.length, calendar_events_to_remove: rows.filter((r) => r.calendar_event_id) };
}

// ---------- boss: work record ----------
const WORK_START = process.env.WORK_START || '10:00';   // daily scrum time = clock-in deadline
const WORK_END = process.env.WORK_END || '18:00';
const TODAY = `(now() AT TIME ZONE 'Europe/London')::date`;
const londonYmd = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(d);
const londonHm = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(d));

async function upsertToday(setSql, args = []) {
  await pool.query(`INSERT INTO workdays (day) VALUES (${TODAY}) ON CONFLICT (day) DO NOTHING`);
  const { rows } = await pool.query(`UPDATE workdays SET ${setSql} WHERE day = ${TODAY} RETURNING *`, args);
  return rows[0];
}

// First clock-in of the day sticks — it can't be redone to look punctual.
const clockIn = () => upsertToday('clock_in = COALESCE(clock_in, now())').then(() => today());
const clockOut = () => upsertToday('clock_out = now(), clock_in = COALESCE(clock_in, now())').then(() => today());

async function setCommitments(ids) {
  ids = checkIds(ids);
  const found = (await pool.query('SELECT id FROM tasks WHERE id = ANY($1)', [ids])).rows.map((r) => r.id);
  if (found.length !== ids.length) throw new BadRequest('Some task ids do not exist');
  await upsertToday('commitments = $1', [ids]);
  return today();
}

async function submitEod(report) {
  if (!report || report.trim().length < 10) throw new BadRequest('End-of-day report is required (what shipped, what did not, why).');
  await upsertToday('eod_report = $1, eod_at = now()', [report.trim()]);
  return today();
}

// Everything the boss needs about today in one call
async function today() {
  const day = londonYmd();
  const wd = (await pool.query(`SELECT * FROM workdays WHERE day = ${TODAY}`)).rows[0] || { day, clock_in: null, clock_out: null, commitments: [], eod_report: null };
  const commit = wd.commitments?.length ? (await pool.query(`${TASK_SELECT} WHERE t.id = ANY($1)`, [wd.commitments])).rows : [];
  const dueSprint = (await pool.query(`${TASK_SELECT} WHERE t.due_sprint = current_sprint_key() ORDER BY t.status DESC, t.position`)).rows;
  const overdue = (await pool.query(`${TASK_SELECT} WHERE t.due_sprint < current_sprint_key() AND t.status <> 'done' ORDER BY t.due_sprint, t.position`)).rows;
  const brief = (t) => ({ id: t.id, name: t.name, status: t.status, due_sprint: keyLabel(t.due_sprint), estimate_hours: t.estimate_hours });
  const nowHm = londonHm(new Date());
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return {
    date: day, now_london: nowHm, workday: dow >= 1 && dow <= 5, work_hours: `${WORK_START}-${WORK_END}`,
    clock_in: wd.clock_in ? londonHm(wd.clock_in) : null,
    clock_out: wd.clock_out ? londonHm(wd.clock_out) : null,
    late: wd.clock_in ? londonHm(wd.clock_in) > WORK_START : nowHm > WORK_START,
    current_sprint: keyLabel(currentKey()),
    commitments: commit.map(brief),
    commitments_estimate_hours: commit.reduce((a, t) => a + (t.estimate_hours || 0), 0),
    eod_report: wd.eod_report || null,
    due_this_sprint: dueSprint.map(brief),
    overdue: overdue.map((t) => ({ ...brief(t), sprint_moved_count: t.sprint_update_count })),
    ceremonies_due: await ceremoniesDue(day),
  };
}

// Scorecard over the last N days (weekdays only)
async function scorecard(days = 30) {
  days = Math.min(Math.max(Number(days) || 30, 1), 365);
  // Count only from the first day you ever clocked in (no penalties for days before the boss existed)
  const first = (await pool.query('SELECT min(day) AS d FROM workdays')).rows[0].d || londonYmd();
  let start = londonYmd(new Date(Date.now() - (days - 1) * 864e5));
  if (first > start) { start = first; days = Math.round((Date.parse(londonYmd()) - Date.parse(first)) / 864e5) + 1; }
  const wds = Object.fromEntries((await pool.query('SELECT * FROM workdays WHERE day >= $1', [start])).rows.map((r) => [r.day, r]));
  const ev = (await pool.query(`SELECT * FROM task_events WHERE created_at >= $1::date`, [start])).rows;
  const doneOn = {};   // task id -> London date it was completed
  ev.filter((e) => e.kind === 'completed').forEach((e) => { doneOn[e.task_id] = londonYmd(e.created_at); });

  const todayYmd = londonYmd(), nowHm = londonHm(new Date());
  let expected = 0, onTime = 0, late = 0, absent = 0, leftEarly = 0, eodDue = 0, eodFiled = 0, committed = 0, kept = 0;
  const ledger = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = londonYmd(new Date(Date.now() - i * 864e5));
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (d === todayYmd && nowHm <= WORK_START && !wds[d]?.clock_in) continue;   // today hasn't started yet
    const w = wds[d] || {};
    const inHm = w.clock_in ? londonHm(w.clock_in) : null;
    expected++;
    if (!inHm) absent++; else if (inHm <= WORK_START) onTime++; else late++;
    const past = d < todayYmd;
    if (past && w.clock_out && londonHm(w.clock_out) < WORK_END) leftEarly++;
    if (past) { eodDue++; if (w.eod_report) eodFiled++; }
    const c = w.commitments || [];
    if (past) { committed += c.length; kept += c.filter((id) => doneOn[id] && doneOn[id] <= d).length; }
    ledger.push({ date: d, in: inHm, out: w.clock_out ? londonHm(w.clock_out) : null, committed: c.length,
      kept: c.filter((id) => doneOn[id] && doneOn[id] <= d).length, eod: !!w.eod_report });
  }
  // Streak: consecutive working days (most recent first) clocked in on time
  let streak = 0;
  for (const l of [...ledger].reverse()) { if (l.in && l.in <= WORK_START) streak++; else if (l.date === todayYmd && !l.in) continue; else break; }

  const completed = ev.filter((e) => e.kind === 'completed');
  const slips = ev.filter((e) => e.reason);
  const overdueNow = (await pool.query(`SELECT count(*)::int AS n FROM tasks WHERE due_sprint < current_sprint_key() AND status <> 'done'`)).rows[0].n;
  return {
    period: `${start} to ${todayYmd}`, work_hours: `${WORK_START}-${WORK_END}`,
    attendance: { working_days: expected, on_time: onTime, late, absent, left_early: leftEarly,
      on_time_pct: expected ? Math.round((onTime / expected) * 100) : null, streak_on_time: streak },
    delivery: { completed: completed.length, on_time: completed.filter((e) => e.on_time).length,
      late: completed.filter((e) => !e.on_time).length, slips_with_excuses: slips.length, overdue_now: overdueNow },
    commitments: { committed, kept, kept_pct: committed ? Math.round((kept / committed) * 100) : null },
    eod_reports: { due: eodDue, filed: eodFiled },
    daily_scrums: { held: (await pool.query(`SELECT count(*)::int AS n FROM ceremonies WHERE kind = 'daily_scrum' AND day >= $1`, [start])).rows[0].n, working_days: expected },
    ledger: ledger.reverse(),
  };
}

async function excuses(days = 30) {
  const { rows } = await pool.query(
    `SELECT task_id, task_name, kind, old_value, new_value, reason, created_at FROM task_events
     WHERE reason IS NOT NULL AND created_at >= now() - make_interval(days => $1) ORDER BY created_at DESC`, [Number(days) || 30]);
  return rows;
}

// ---------- scrum ceremonies ----------
const KINDS = ['daily_scrum', 'sprint_planning', 'sprint_review', 'retrospective'];
// Review + retro are run by Jawad from his own calendar, so they're never listed as "due".

// Random check-in times for today: n times inside [from, to] London, at least gapMin apart, all in the future
function randomCheckTimes(n = 2, from = '12:00', to = '16:00', gapMin = 60) {
  const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
  const nowMin = toMin(londonHm(new Date())) + 10;            // leave a little slack
  const lo = Math.max(toMin(from), nowMin), hi = toMin(to);
  if (hi - lo < gapMin * (n - 1)) return [];
  let picks;
  for (let tries = 0; tries < 200; tries++) {
    picks = Array.from({ length: n }, () => lo + Math.floor(Math.random() * (hi - lo + 1))).sort((a, b) => a - b);
    if (picks.every((p, i) => i === 0 || p - picks[i - 1] >= gapMin)) break;
  }
  const day = londonYmd();
  return picks.map((m) => {
    const hm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return { london: hm, utc: londonToIso(`${day} ${hm}`) };
  });
}
const label = (y, n) => `${y}-S${String(n).padStart(2, '0')}`;

// Which ceremonies are due on a date, and whether they've been recorded yet
async function ceremoniesDue(day = londonYmd()) {
  const sp = sprintFor(day), wd = workingDays(sp.year, sp.number);
  if (!wd.includes(day)) return [];
  const held = (await pool.query(
    `SELECT kind FROM ceremonies WHERE (kind = 'daily_scrum' AND day = $1)
        OR (kind <> 'daily_scrum' AND sprint_year = $2 AND sprint_number = $3)`, [day, sp.year, sp.number])).rows.map((r) => r.kind);
  const due = [{ kind: 'daily_scrum', at: WORK_START }];
  const planningMissing = !held.includes('sprint_planning');
  if (day === wd[0] || planningMissing) due.push({ kind: 'sprint_planning', overdue: day !== wd[0] });
  return due.map((d) => ({ ...d, sprint: label(sp.year, sp.number), recorded: held.includes(d.kind) }));
}

async function recordCeremony({ kind, summary, details = {}, task_ids = [], date, sprint_year, sprint_number }) {
  if (!KINDS.includes(kind)) throw new BadRequest(`kind must be one of ${KINDS.join(', ')}`);
  if (!summary || !summary.trim()) throw new BadRequest('summary is required');
  const day = date || londonYmd();
  const sp = sprint_number ? { year: sprint_year || sprintFor(day).year, number: sprint_number } : sprintFor(day);
  const ids = [...new Set([...(task_ids || []), ...Object.entries(details).filter(([k]) => k.endsWith('task_ids')).flatMap(([, v]) => v || [])])].map(Number);
  if (ids.length) {
    const found = (await pool.query('SELECT id FROM tasks WHERE id = ANY($1)', [ids])).rows.length;
    if (found !== ids.length) throw new BadRequest('Some task ids do not exist');
  }
  const where = kind === 'daily_scrum' ? 'kind = $1 AND day = $2' : 'kind = $1 AND sprint_year = $3 AND sprint_number = $4';
  const vals = [kind, day, sp.year, sp.number, summary.trim(), JSON.stringify(details), ids];
  let { rows } = await pool.query(
    `UPDATE ceremonies SET summary = $5, details = $6, task_ids = $7, updated_at = now(), day = $2, sprint_year = $3, sprint_number = $4
     WHERE ${where} RETURNING *`, vals);
  if (!rows[0]) {
    ({ rows } = await pool.query(
      `INSERT INTO ceremonies (kind, day, sprint_year, sprint_number, summary, details, task_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, vals));
  }
  // Daily scrum "today" items become today's commitments (what the boss holds you to)
  if (kind === 'daily_scrum' && day === londonYmd() && details.today_task_ids?.length) await setCommitments(details.today_task_ids);
  return rows[0];
}

async function listCeremonies({ kind, sprint_year, sprint_number, limit = 100 } = {}) {
  const where = [], args = [];
  const add = (sql, v) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
  if (kind) add('kind = ?', kind);
  if (sprint_year) add('sprint_year = ?', Number(sprint_year));
  if (sprint_number) add('sprint_number = ?', Number(sprint_number));
  args.push(Math.min(Number(limit) || 100, 500));
  const { rows } = await pool.query(
    `SELECT * FROM ceremonies ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY day DESC, id DESC LIMIT $${args.length}`, args);
  const ids = [...new Set(rows.flatMap((r) => r.task_ids))];
  const tasks = ids.length ? Object.fromEntries((await pool.query('SELECT id, name, status FROM tasks WHERE id = ANY($1)', [ids])).rows.map((t) => [t.id, t])) : {};
  return rows.map((r) => ({ ...r, sprint: label(r.sprint_year, r.sprint_number),
    tasks: r.task_ids.map((id) => tasks[id] || { id, name: '(deleted task)', status: null }) }));
}

// Everything needed to run planning, review or retro for a sprint
async function sprintStatus(year, number) {
  if (!year || !number) { const c = sprintFor(); year = c.year; number = c.number; }
  const r = sprintRange(year, number), wd = workingDays(year, number);
  const tasks = (await pool.query(`${TASK_SELECT} WHERE t.sprint_year = $1 AND t.sprint_number = $2 ORDER BY t.position`, [year, number])).rows;
  const ev = (await pool.query(
    `SELECT * FROM task_events WHERE created_at >= $1::date AND created_at < ($2::date + 1)`, [r.start, r.end])).rows;
  const cer = (await pool.query('SELECT kind, day FROM ceremonies WHERE sprint_year = $1 AND sprint_number = $2', [year, number])).rows;
  const today = londonYmd(), elapsed = wd.filter((d) => d <= today);
  const t = (x) => ({ id: x.id, name: x.name, status: x.status, category: x.category_name, due_sprint: keyLabel(x.due_sprint),
    estimate_hours: x.estimate_hours, slipped: x.sprint_update_count });
  const hrs = (list) => list.reduce((a, x) => a + (x.estimate_hours || 0), 0);
  const dueHere = (await pool.query(`${TASK_SELECT} WHERE t.due_sprint = $1 AND NOT (t.sprint_year = $2 AND t.sprint_number = $3)`, [key(year, number), year, number])).rows;
  const planning = (await pool.query(`SELECT details FROM ceremonies WHERE kind = 'sprint_planning' AND sprint_year = $1 AND sprint_number = $2`, [year, number])).rows[0];
  return {
    sprint: r.label, start: r.start, end: r.end, working_days: wd.length, working_days_elapsed: elapsed.length,
    first_working_day: wd[0], last_working_day: wd[wd.length - 1],
    goal: planning?.details?.goal || null,
    done: tasks.filter((x) => x.status === 'done').map(t),
    in_progress: tasks.filter((x) => x.status === 'in_progress').map(t),
    todo: tasks.filter((x) => x.status === 'todo').map(t),
    hours: { estimated_total: hrs(tasks), estimated_open: hrs(tasks.filter((x) => x.status !== 'done')),
      unestimated_tasks: tasks.filter((x) => x.estimate_hours == null).length,
      capacity: wd.length * HOURS_PER_DAY, capacity_note: `${wd.length} working days × ${HOURS_PER_DAY}h` },
    due_here_but_planned_elsewhere: dueHere.map(t),
    completed_in_window: { on_time: ev.filter((e) => e.kind === 'completed' && e.on_time).length, late: ev.filter((e) => e.kind === 'completed' && !e.on_time).length },
    excuses_in_window: ev.filter((e) => e.reason).map((e) => ({ task: e.task_name, change: `${e.old_value} → ${e.new_value}`, reason: e.reason })),
    ceremonies: {
      sprint_planning: cer.some((c) => c.kind === 'sprint_planning'),
      daily_scrums: `${cer.filter((c) => c.kind === 'daily_scrum').length}/${elapsed.length}`,
      sprint_review: cer.some((c) => c.kind === 'sprint_review'),
      retrospective: cer.some((c) => c.kind === 'retrospective'),
    },
  };
}

// Overview used by Claude and the UI header.
async function summary() {
  const cur = sprintFor();
  const { rows } = await pool.query(`
    SELECT
      (count(*) FILTER (WHERE status <> 'done' AND due_sprint < current_sprint_key()))::int       AS overdue,
      (count(*) FILTER (WHERE status <> 'done' AND due_sprint = current_sprint_key()))::int       AS due_this_sprint,
      COALESCE(sum(estimate_hours) FILTER (WHERE sprint_year = $1 AND sprint_number = $2 AND status <> 'done'), 0)::float AS open_hours_in_sprint,
      (count(*) FILTER (WHERE sprint_year = $1 AND sprint_number = $2 AND status <> 'done'))::int AS open_in_sprint,
      (count(*) FILTER (WHERE sprint_year = $1 AND sprint_number = $2 AND status = 'done'))::int  AS done_in_sprint
    FROM tasks`, [cur.year, cur.number]);
  return { current_sprint: sprintRange(cur.year, cur.number), sprint_capacity_hours: workingDays(cur.year, cur.number).length * HOURS_PER_DAY, ...rows[0] };
}

module.exports = {
  listCategories, createCategory, updateCategory, deleteCategory,
  listTasks, getTask, createTask, updateTask, deleteTask, summary, bulkUpdate, bulkDelete,
  clockIn, clockOut, setCommitments, submitEod, today, scorecard, excuses,
  ceremoniesDue, recordCeremony, randomCheckTimes, listCeremonies, sprintStatus, WORK_START, WORK_END,
  sprintFor, sprintRange, STATUSES,
};
