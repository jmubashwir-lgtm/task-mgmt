// MCP endpoint: lets Claude read and change tasks.
// Claude connects to https://<your-app>/mcp as a custom connector.
// "Stateless" mode: every request builds a fresh server, so nothing is held in memory
// between calls — ideal for Render, which can restart the app at any time.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const svc = require('./service');
const boss = require('./boss');
const telegram = require('./telegram');
const { keyLabel, currentKey, addSprints, key } = require('./sprint');

const londonNow = () =>
  new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

// Shape each task the way Claude finds easiest to read.
const brief = (t) => ({
  id: t.id, name: t.name, category: t.category_name, status: t.status,
  start_sprint: keyLabel(t.start_sprint),
  due_sprint: keyLabel(t.due_sprint),
  overdue: !!(t.due_sprint && t.due_sprint < currentKey() && t.status !== 'done'),
  estimate_hours: t.estimate_hours,
  due_moved_count: t.sprint_update_count,
  notes: t.notes, calendar_event_id: t.calendar_event_id,
  created: t.created_at, last_updated: t.updated_at,
});

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] });
const run = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };

// Fields shared by create and update
const sprintRef = z.union([z.string(), z.number().int()]);
const dueDesc = 'The task\'s sprint = its deadline: "2026-S22", "S22" or 22 (current year). Required (defaults to the current sprint). Pushing it later needs a reason.';
const taskFields = {
  category: z.string().optional().describe('Category name. A new name creates the category.'),
  status: z.enum(['todo', 'in_progress', 'done']).optional(),
  notes: z.string().nullable().optional(),
  start_sprint: sprintRef.optional().describe('Sprint the work starts, e.g. "2026-S21". Defaults to the current sprint.'),
  due_sprint: sprintRef.optional().describe(dueDesc),
  estimate_hours: z.number().min(0).nullable().optional().describe('Jawad\'s estimate of work hours to deliver it. Only set what he says.'),
};

function buildServer() {
  // Standing instructions: every Claude session using this connector gets the boss persona
  const server = new McpServer({ name: 'task-mgmt', version: '1.1.0' },
    { instructions: `${boss.persona(svc.WORK_START, svc.WORK_END)}\n\nAt the start of a conversation call get_today. Scheduled check-ins call run_checkpoint.` });

  server.registerTool('get_overview', {
    title: 'Overview',
    description: 'Start here. Current London date/time, current sprint and its dates, counts of overdue / due-this-week tasks, and the category list.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, run(async () => ({ now_london: londonNow(), ...(await svc.summary()), categories: (await svc.listCategories()).map((c) => c.name) })));

  server.registerTool('list_tasks', {
    title: 'List tasks',
    description: 'List tasks with optional filters. Done tasks are excluded unless include_done is true.',
    inputSchema: {
      status: z.enum(['todo', 'in_progress', 'done']).optional(),
      category: z.string().optional().describe('Category name'),
      sprint_number: z.number().int().optional().describe('Only tasks due in this sprint (1-26)'),
      sprint_year: z.number().int().optional(),
      overdue_only: z.boolean().optional().describe('Tasks whose due sprint has passed'),
      due_sprint: sprintRef.optional().describe('Only tasks due in this sprint'),
      search: z.string().optional().describe('Text to find in task names'),
      include_done: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true },
  }, run(async (a) => {
    const f = { status: a.status, sprint_number: a.sprint_number, sprint_year: a.sprint_year, overdue: a.overdue_only, q: a.search, due_sprint: a.due_sprint };
    if (a.category) {
      const c = (await svc.listCategories()).find((x) => x.name.toLowerCase() === a.category.toLowerCase());
      if (!c) return [];
      f.category_id = c.id;
    }
    let rows = await svc.listTasks(f);
    if (!a.include_done && a.status !== 'done') rows = rows.filter((t) => t.status !== 'done');
    return rows.map(brief);
  }));

  server.registerTool('get_task', {
    title: 'Get task',
    description: 'Full details of one task by id.',
    inputSchema: { id: z.number().int() },
    annotations: { readOnlyHint: true },
  }, run(async ({ id }) => brief(await svc.getTask(id))));

  server.registerTool('create_task', {
    title: 'Create task',
    description: 'Create a task. A task has one sprint: its due sprint (its deadline). Dates are sprints, never exact days. Defaults: due = current sprint, start = current sprint. Ask Jawad for an estimate in hours.',
    inputSchema: { name: z.string(), ...taskFields },
  }, run(async (a) => brief(await svc.createTask({ ...a }))));

  server.registerTool('update_task', {
    title: 'Update task',
    description: 'Change any fields of a task. Changing the sprint increases its "sprint moved" count. ' +
      'After blocking calendar time, save the Google Calendar event id here as calendar_event_id.',
    inputSchema: { id: z.number().int(), name: z.string().optional(), ...taskFields,
      calendar_event_id: z.string().nullable().optional().describe('Google Calendar event id of the time block'),
  reason: z.string().optional().describe('Required when pushing a deadline later or moving to a later sprint. Get it from Jawad — never invent one.'),
    },
    annotations: { idempotentHint: true },
  }, run(async ({ id, ...a }) => brief(await svc.updateTask(id, a))));

  server.registerTool('move_to_sprint', {
    title: 'Move to sprint',
    description: 'Move a task\'s due sprint ("next" = one sprint later). Moving it later is a slip: needs a reason and increases the moved count.',
    inputSchema: { id: z.number().int(), sprint: z.union([z.literal('next'), z.number().int().min(1).max(27)]), sprint_year: z.number().int().optional(),
  reason: z.string().optional().describe('Required when pushing a deadline later or moving to a later sprint. Get it from Jawad — never invent one.'),
    },
  }, run(async ({ id, sprint, sprint_year, reason }) => {
    const t = await svc.getTask(id);
    const due = sprint === 'next' ? addSprints(t.due_sprint, 1) : key(sprint_year || Math.floor(t.due_sprint / 100), sprint);
    return brief(await svc.updateTask(id, { due_sprint: due, reason }));
  }));

  server.registerTool('complete_task', {
    title: 'Complete task',
    description: 'Mark a task as done.',
    inputSchema: { id: z.number().int() },
    annotations: { idempotentHint: true },
  }, run(async ({ id }) => brief(await svc.updateTask(id, { status: 'done' }))));

  server.registerTool('delete_task', {
    title: 'Delete task',
    description: 'Permanently delete a task. Returns its calendar_event_id so the linked calendar block can be removed too.',
    inputSchema: { id: z.number().int() },
    annotations: { destructiveHint: true },
  }, run(async ({ id }) => ({ deleted: true, ...(await svc.deleteTask(id)) })));

  server.registerTool('bulk_update_tasks', {
    title: 'Bulk update tasks',
    description: 'Apply the same change to several tasks at once (use list_tasks first to get ids). ' +
      'Use move_to_next_sprint to push each task one sprint forward, or shift_due_sprints to move each due sprint by N sprints.',
    inputSchema: {
      ids: z.array(z.number().int()).min(1),
      status: z.enum(['todo', 'in_progress', 'done']).optional(),
      category: z.string().optional().describe('Category name; a new name creates it'),
      move_to_next_sprint: z.boolean().optional().describe('Due one sprint later for each task (slip: needs reason)'),
      due_sprint: sprintRef.optional().describe(dueDesc),
      shift_due_sprints: z.number().int().optional().describe('Move each task\'s due sprint by N sprints (positive = later, needs reason)'),
      estimate_hours: z.number().min(0).nullable().optional(),
  reason: z.string().optional().describe('Required when pushing a deadline later or moving to a later sprint. Get it from Jawad — never invent one.'),
    },
  }, run(async ({ ids, move_to_next_sprint, shift_due_sprints, ...a }) =>
    svc.bulkUpdate(ids, { ...a, sprint_next: move_to_next_sprint, due_shift_sprints: shift_due_sprints })));

  server.registerTool('bulk_delete_tasks', {
    title: 'Bulk delete tasks',
    description: 'Permanently delete several tasks. Returns linked calendar event ids so those blocks can be removed too.',
    inputSchema: { ids: z.array(z.number().int()).min(1) },
    annotations: { destructiveHint: true },
  }, run(async ({ ids }) => svc.bulkDelete(ids)));

  // ---------- boss: work record ----------
  server.registerTool('get_today', {
    title: 'Today (work record)',
    description: 'Jawad\'s work record for today: clock-in/out times, whether he is late, his committed tasks (with estimates) and their status, tasks due this sprint, overdue tasks (due sprint passed), ceremonies due. Use at every check-in.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, run(() => svc.today()));

  server.registerTool('clock_in', {
    title: 'Clock in', description: 'Record arrival at work now. The first clock-in of the day cannot be changed.',
    inputSchema: {},
  }, run(() => svc.clockIn()));

  server.registerTool('clock_out', {
    title: 'Clock out', description: 'Record finishing work now.', inputSchema: {},
  }, run(() => svc.clockOut()));

  server.registerTool('set_today_commitments', {
    title: 'Set today\'s commitments', description: 'Record the task ids Jawad commits to delivering today (what he said at daily scrum).',
    inputSchema: { ids: z.array(z.number().int()).min(1) },
  }, run(({ ids }) => svc.setCommitments(ids)));

  server.registerTool('submit_eod_report', {
    title: 'Submit end-of-day report', description: 'Record the end-of-day report: what shipped, what did not, and why.',
    inputSchema: { report: z.string() },
  }, run(({ report }) => svc.submitEod(report)));

  server.registerTool('get_scorecard', {
    title: 'Scorecard', description: 'Attendance (on-time/late/absent, streak), delivery (on-time vs late, slips, overdue), commitments kept and EOD reports for the last N days, plus a per-day ledger.',
    inputSchema: { days: z.number().int().min(1).max(365).optional() }, annotations: { readOnlyHint: true },
  }, run(({ days }) => svc.scorecard(days)));

  server.registerTool('get_excuse_log', {
    title: 'Excuse log', description: 'Every deadline/sprint push-back with the reason given, newest first. Use it to call out repeated excuses.',
    inputSchema: { days: z.number().int().min(1).max(365).optional() }, annotations: { readOnlyHint: true },
  }, run(({ days }) => svc.excuses(days)));

  // ---------- scrum ceremonies ----------
  server.registerTool('run_checkpoint', {
    title: 'Run boss checkpoint',
    description: 'Used by scheduled check-ins. Returns the boss persona, the instructions for this checkpoint, and all the data needed (today, ceremonies due, sprint status, 30-day scorecard). Follow the instructions exactly.',
    inputSchema: { name: z.enum(boss.CHECKPOINT_NAMES) },
    annotations: { readOnlyHint: true },
  }, run(async ({ name }) => {
    const today = await svc.today();
    const sc = await svc.scorecard(30); delete sc.ledger;
    const needsSprint = ['daily_scrum', 'sprint_planning'].includes(name);
    return {
      persona: boss.persona(svc.WORK_START, svc.WORK_END),
      checkpoint: name, instructions: boss.checkpoint(name, svc.WORK_START, svc.WORK_END),
      skip_reason: today.workday ? null : 'Weekend: send nothing more than "Weekend. Rest."',
      today, scorecard_30d: sc,
      sprint_status: needsSprint ? await svc.sprintStatus() : undefined,
    };
  }));

  server.registerTool('random_check_times', {
    title: 'Random check-in times',
    description: 'Truly random times for today\'s unannounced spot checks (default: 2 between 12:00 and 16:00 London, at least 60 minutes apart, all in the future). Returns London and UTC (RFC3339) times for scheduling.',
    inputSchema: { count: z.number().int().min(1).max(4).optional(), from: z.string().optional(), to: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, run(({ count, from, to }) => svc.randomCheckTimes(count || 2, from || '12:00', to || '16:00', 60)));

  server.registerTool('record_ceremony', {
    title: 'Record scrum ceremony',
    description: 'Store a summary of a scrum ceremony Jawad just did with you, linked to tasks. Re-recording the same ceremony updates it. ' +
      'daily_scrum details: {yesterday, today, blockers, today_task_ids, yesterday_task_ids} — today_task_ids also become today\'s commitments. ' +
      'sprint_planning: {goal, backlog_task_ids, capacity_notes}. sprint_review: {goal, delivered_task_ids, not_delivered_task_ids, notes}. ' +
      'retrospective: {went_well[], to_improve[], actions[], action_task_ids}.',
    inputSchema: {
      kind: z.enum(['daily_scrum', 'sprint_planning', 'sprint_review', 'retrospective']),
      summary: z.string().describe('2-4 sentence summary in plain English, written for Jawad to reread later'),
      details: z.record(z.string(), z.any()).optional(),
      task_ids: z.array(z.number().int()).optional().describe('Any other tasks discussed'),
      date: z.string().optional().describe('YYYY-MM-DD; defaults to today (London)'),
      sprint_number: z.number().int().min(1).max(27).optional().describe('Defaults to the sprint containing the date'),
      sprint_year: z.number().int().optional(),
    },
  }, run((a) => svc.recordCeremony(a)));

  server.registerTool('list_ceremonies', {
    title: 'List ceremonies',
    description: 'Past ceremony summaries (newest first), optionally filtered by kind and sprint. Use to recall what he committed to, blockers raised, and retro actions.',
    inputSchema: { kind: z.enum(['daily_scrum', 'sprint_planning', 'sprint_review', 'retrospective']).optional(),
      sprint_number: z.number().int().optional(), sprint_year: z.number().int().optional(), limit: z.number().int().optional() },
    annotations: { readOnlyHint: true },
  }, run((a) => svc.listCeremonies(a)));

  server.registerTool('get_sprint_status', {
    title: 'Sprint status',
    description: 'For planning/review/retro: sprint dates and goal, tasks done / in progress / to do with estimates, estimated hours vs capacity, tasks due here but planned elsewhere, on-time vs late completions, excuses, and ceremonies held. Defaults to the current sprint.',
    inputSchema: { sprint_number: z.number().int().optional(), sprint_year: z.number().int().optional() },
    annotations: { readOnlyHint: true },
  }, run(({ sprint_number, sprint_year }) => svc.sprintStatus(sprint_year || (sprint_number && svc.sprintFor().year), sprint_number)));

  server.registerTool('sprint_for_date', {
    title: 'Sprint for date',
    description: 'Which sprint a date (YYYY-MM-DD) falls in, with its start and end dates.',
    inputSchema: { date: z.string() },
    annotations: { readOnlyHint: true },
  }, run(async ({ date }) => { const s = svc.sprintFor(date); return svc.sprintRange(s.year, s.number); }));

  // ---------- messaging ----------
  server.registerTool('send_message', {
    title: 'Send message to Jawad',
    description: 'Send the boss\'s message to Jawad\'s Telegram. Scheduled check-ins use this to deliver their message. Plain text, no markdown. ' +
      'His replies in Telegram are answered by the boss automatically.',
    inputSchema: { text: z.string().min(1) },
  }, run(({ text }) => telegram.sendMessage(text)));

  return server;
}

// Express handler for POST /mcp
async function handleMcp(req, res) {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('MCP error', e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
}

module.exports = { handleMcp, buildServer };
