// Web server: REST API (+ the web UI in Step 2, + MCP in Step 3).
const express = require('express');
const path = require('path');
const { migrate } = require('./db');
const svc = require('./service');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
// Shared files the browser needs
app.get('/sprint.js', (_req, res) => res.sendFile(path.join(__dirname, 'sprint.js')));
app.get('/vendor/sortable.js', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'node_modules', 'sortablejs', 'Sortable.min.js')));

// Wrap async handlers so errors become clean JSON responses.
const h = (fn) => (req, res) =>
  Promise.resolve(fn(req, res))
    .then((out) => (out === undefined ? res.status(204).end() : res.json(out)))
    .catch((e) => res.status(e.status || 500).json({ error: e.message, code: e.code }));

// Claude connector (MCP). GET/DELETE aren't needed in stateless mode.
const { handleMcp } = require('./mcp');
app.post('/mcp', handleMcp);
app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST' }));

// Health check (Render pings this)
app.get('/health', (_req, res) => res.json({ ok: true }));

// Sprints
app.get('/api/sprints/current', h(() => { const s = svc.sprintFor(); return svc.sprintRange(s.year, s.number); }));
app.get('/api/sprints/:year/:number', h((r) => svc.sprintRange(+r.params.year, +r.params.number)));
app.get('/api/summary', h(() => svc.summary()));

// Boss: work record
app.get('/api/work/today', h(() => svc.today()));
app.post('/api/work/clock-in', h(() => svc.clockIn()));
app.post('/api/work/clock-out', h(() => svc.clockOut()));
app.put('/api/work/commitments', h((r) => svc.setCommitments(r.body.ids)));
app.post('/api/work/eod', h((r) => svc.submitEod(r.body.report)));
app.get('/api/work/scorecard', h((r) => svc.scorecard(r.query.days)));
app.get('/api/work/excuses', h((r) => svc.excuses(r.query.days)));

// Categories
app.get('/api/categories', h(() => svc.listCategories()));
app.post('/api/categories', h((r) => svc.createCategory(r.body)));
app.patch('/api/categories/:id', h((r) => svc.updateCategory(+r.params.id, r.body)));
app.delete('/api/categories/:id', h((r) => svc.deleteCategory(+r.params.id)));

// Tasks
app.get('/api/tasks', h((r) => svc.listTasks(r.query)));
// Bulk (registered before /:id so "bulk" isn't read as an id)
app.post('/api/tasks/bulk-update', h((r) => svc.bulkUpdate(r.body.ids, { ...r.body.patch, reason: r.body.reason ?? r.body.patch?.reason })));
app.post('/api/tasks/bulk-delete', h((r) => svc.bulkDelete(r.body.ids)));
app.get('/api/tasks/:id', h((r) => svc.getTask(+r.params.id)));
app.post('/api/tasks', h((r) => svc.createTask(r.body)));
app.patch('/api/tasks/:id', h((r) => svc.updateTask(+r.params.id, r.body)));
app.delete('/api/tasks/:id', h((r) => svc.deleteTask(+r.params.id).then(() => undefined)));

const PORT = process.env.PORT || 3000;
migrate()
  .then(() => app.listen(PORT, () => console.log(`Task Manager on :${PORT}`)))
  .catch((e) => { console.error('Migration failed:', e); process.exit(1); });

module.exports = app;
