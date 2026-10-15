/* Task Manager — frontend (vanilla JS, no build step).
   Flow: load data from the API → filter → render the chosen view.
   Every edit (drag, drawer, Gantt) is a PATCH to the API, then a reload. */

const $ = (s, el = document) => el.querySelector(s);
const STATUS = { todo: 'To do', in_progress: 'In progress', done: 'Done' };

const state = {
  tasks: [], categories: [], summary: null,
  view: pref('view', 'board'), groupBy: pref('groupBy', 'status').replace('deadline', 'due'),
  filter: { category: '', sprint: '', q: '', showDone: true },
  editing: null,      // task being edited in the drawer (null = new)
  selected: new Set(), // ids ticked for bulk edits
  lastSel: null,      // anchor for shift-click range selection
  draft: {},          // prefilled values for a new task
};

// ---------- small helpers ----------
function pref(k, d) { try { return localStorage.getItem('pt.' + k) || d; } catch { return d; } }
function savePref(k, v) { try { localStorage.setItem('pt.' + k, v); } catch {} }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const dayDiff = (a, b) => { const A = parseYmd(a), B = parseYmd(b); return Math.round((Date.UTC(B.getFullYear(), B.getMonth(), B.getDate()) - Date.UTC(A.getFullYear(), A.getMonth(), A.getDate())) / 864e5); };
const fmtDate = (s) => parseYmd(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const dueLabel = (k) => (k ? Sprint.keyLabel(k) : '—');
const hoursIn = (list) => { const h = list.reduce((a, t) => a + (t.estimate_hours || 0), 0); return h ? `${+h.toFixed(2)}h` : ''; };
// <option>s for a sprint picker: 4 sprints back to 16 ahead (plus the selected one if outside)
function sprintOptions(selected, { none = false } = {}) {
  const cur = Sprint.currentKey(), keys = [];
  for (let i = -4; i <= 16; i++) keys.push(Sprint.addSprints(cur, i));
  if (selected && !keys.includes(selected)) keys.push(selected), keys.sort((a, b) => a - b);
  return (none ? `<option value="">No due sprint</option>` : '') + keys.map((k) => {
    const r = Sprint.sprintRange(...Object.values(Sprint.fromKey(k)));
    return `<option value="${k}" ${k === selected ? 'selected' : ''}>${r.label} · ${fmtDate(r.start)} – ${fmtDate(r.end)}${k === cur ? ' (current)' : ''}</option>`;
  }).join('');
}
const fmtStamp = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const sprintKey = (t) => `${t.sprint_year}-${t.sprint_number}`;
const sprintLabel = (y, n) => `${y}-S${pad(n)}`;
const isOverdue = (t) => !!t.due_sprint && t.status !== 'done' && t.due_sprint < Sprint.currentKey();
const today = () => ymd(new Date());
const currentSprint = () => Sprint.sprintFor(new Date());

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) {
    // The boss refuses silent slips: ask for a reason and retry once with it.
    if (data.code === 'REASON_REQUIRED' && body && !body.reason) {
      const why = prompt(`${data.error}\n\nWhy are you pushing this back? (Logged permanently.)`);
      if (why && why.trim()) return api(method, url, { ...body, reason: why.trim() });
      throw new Error('Not moved — no reason, no slip.');
    }
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- data ----------
async function load() {
  const [tasks, categories, summary, today] = await Promise.all([
    api('GET', '/api/tasks'), api('GET', '/api/categories'), api('GET', '/api/summary'), api('GET', '/api/work/today'),
  ]);
  Object.assign(state, { tasks, categories, summary, today });
  const ids = new Set(tasks.map((t) => t.id));
  state.selected.forEach((id) => { if (!ids.has(id)) state.selected.delete(id); }); // drop deleted tasks
  renderChrome();
  render();
  renderBulk();
}

async function patchTask(id, patch) {
  try { await api('PATCH', `/api/tasks/${id}`, patch); }
  catch (e) { toast(e.message); }
  await load();
}

function visibleTasks() {
  const f = state.filter;
  return state.tasks.filter((t) =>
    (!f.category || String(t.category_id ?? 'none') === f.category) &&
    (!f.sprint || sprintKey(t) === f.sprint) &&
    (!f.q || t.name.toLowerCase().includes(f.q.toLowerCase())) &&
    (f.showDone || t.status !== 'done'));
}

// ---------- grouping: one definition drives Board and List ----------
// Each group says: which tasks belong (match) and what to save when a task is dropped in (patch).
function groups(tasks) {
  const g = state.groupBy;
  if (g === 'status') {
    return Object.entries(STATUS).map(([key, title]) => ({ key, title, match: (t) => t.status === key, patch: { status: key } }));
  }
  if (g === 'category') {
    return [
      ...state.categories.map((c) => ({ key: String(c.id), title: c.name, color: c.color, match: (t) => t.category_id === c.id, patch: { category_id: c.id } })),
      { key: 'none', title: 'No category', color: '#B0B0B4', match: (t) => !t.category_id, patch: { category_id: null } },
    ];
  }
  if (g === 'sprint') {
    const cur = currentSprint();
    const nxt = cur.number === 26 ? { year: cur.year + 1, number: 1 } : { year: cur.year, number: cur.number + 1 };
    const keys = new Set([...tasks.map(sprintKey), `${cur.year}-${cur.number}`, `${nxt.year}-${nxt.number}`]);
    return [...keys]
      .map((k) => k.split('-').map(Number))
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .map(([y, n]) => {
        const r = Sprint.sprintRange(y, n);
        const isCur = y === cur.year && n === cur.number;
        return {
          key: `${y}-${n}`, title: r.label + (isCur ? ' · current' : ''),
          sub: `${fmtDate(r.start)} – ${fmtDate(r.end)}`, color: isCur ? '#65BC7B' : null,
          match: (t) => t.sprint_year === y && t.sprint_number === n, patch: { sprint_year: y, sprint_number: n },
        };
      });
  }
  // due-sprint buckets: reorder within a bucket only (due sprints change in the drawer, Gantt or bulk bar)
  const cur = Sprint.currentKey(), nxt = Sprint.addSprints(cur, 1);
  return [
    { key: 'overdue', title: 'Overdue', color: '#FC3A5D', match: (t) => isOverdue(t) },
    { key: 'this', title: `Due this sprint · ${Sprint.keyLabel(cur)}`, color: '#65BC7B', match: (t) => t.due_sprint === cur },
    { key: 'next', title: `Due next sprint · ${Sprint.keyLabel(nxt)}`, match: (t) => t.due_sprint === nxt },
    { key: 'later', title: 'Due later', match: (t) => t.due_sprint > nxt },
    { key: 'past-done', title: 'Earlier (done)', match: (t) => t.due_sprint && t.due_sprint < cur && t.status === 'done' },
    { key: 'none', title: 'No due sprint', color: '#B0B0B4', match: (t) => !t.due_sprint },
  ].map((x) => ({ ...x, locked: true }))
   .filter((x) => x.key !== 'past-done' || tasks.some(x.match));
}

// ---------- chrome: header, filters ----------
function renderChrome() {
  const s = state.summary;
  const r = s.current_sprint;
  $('#sprintPill').textContent = `${r.label} · ${fmtDate(r.start)} – ${fmtDate(r.end)}`;
  const total = s.open_in_sprint + s.done_in_sprint;
  $('#stats').innerHTML = `
    <button class="stat ${s.overdue ? 'alert' : ''}" data-jump="overdue"><b>${s.overdue}</b> overdue</button>
    <button class="stat" data-jump="due"><b>${s.due_this_sprint}</b> due this sprint</button>
    <button class="stat ${s.open_hours_in_sprint > s.sprint_capacity_hours ? 'alert' : ''}" data-jump="sprint" title="Open estimated hours in this sprint vs capacity"><b>${+s.open_hours_in_sprint.toFixed(1)}h</b> / ${s.sprint_capacity_hours}h load</button>
    <button class="stat" data-jump="sprint"><b>${s.done_in_sprint}/${total}</b> sprint done</button>`;

  const cat = $('#fCategory'), cv = cat.value;
  cat.innerHTML = `<option value="">All categories</option>` +
    state.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('') +
    `<option value="none">No category</option>`;
  cat.value = cv;

  const sp = $('#fSprint'), sv = sp.value;
  const keys = [...new Set(state.tasks.map(sprintKey))].sort((a, b) => { const [ay, an] = a.split('-'); const [by, bn] = b.split('-'); return ay - by || an - bn; });
  sp.innerHTML = `<option value="">All sprints</option>` + keys.map((k) => { const [y, n] = k.split('-'); return `<option value="${k}">${sprintLabel(y, +n)}</option>`; }).join('');
  sp.value = keys.includes(sv) ? sv : '';

  $('#catList').innerHTML = state.categories.map((c) => `<option value="${esc(c.name)}">`).join('');

  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  $('#groupBy').value = state.groupBy;
  $('#groupWrap').hidden = ['gantt', 'boss', 'scrum'].includes(state.view);
  document.querySelector('.filters').style.visibility = ['boss', 'scrum'].includes(state.view) ? 'hidden' : '';
  renderClock();
}

// ---------- shared card bits ----------
function catChip(t) {
  return t.category_name
    ? `<span class="chip cat"><span class="dot" style="background:${t.category_color}"></span>${esc(t.category_name)}</span>`
    : '';
}
function infoChips(t) {
  return [
    t.due_sprint ? `<span class="chip ${isOverdue(t) ? 'overdue' : ''}">${isOverdue(t) ? 'Overdue · ' : 'Due '}${Sprint.keyLabel(t.due_sprint)}</span>` : '',
    Sprint.key(t.sprint_year, t.sprint_number) !== t.due_sprint ? `<span class="chip" title="Sprint it's being worked in">In ${sprintLabel(t.sprint_year, t.sprint_number)}</span>` : '',
    t.estimate_hours != null ? `<span class="chip est" title="Estimated work hours">${t.estimate_hours}h</span>` : '',
    t.sprint_update_count ? `<span class="chip slipped" title="Sprint changed ${t.sprint_update_count} time(s)">Slipped ×${t.sprint_update_count}</span>` : '',
    t.notes ? `<span class="chip notes" title="Has notes">notes</span>` : '',
  ].join('');
}

const EMPTY = `<div class="empty">
  <svg viewBox="0 0 160 110" aria-hidden="true">${[[40,30],[80,30],[120,30],[60,64],[100,64],[80,98]].map(([x,y]) =>
    `<polygon points="${x},${y-18} ${x+16},${y-9} ${x+16},${y+9} ${x},${y+18} ${x-16},${y+9} ${x-16},${y-9}" fill="none" stroke="#65BC7B" stroke-width="4"/>`).join('')}</svg>
  <h3>Nothing here yet</h3><div>Add a task above, or ask Claude to add one.</div></div>`;

// ---------- selection (bulk edit) ----------
const selBox = (id) => `<button type="button" class="sel ${state.selected.has(id) ? 'on' : ''}" data-sel="${id}" aria-label="Select task"></button>`;
const groupSel = (items) => items.length
  ? `<button type="button" class="sel" data-selgroup="${items.map((t) => t.id).join(',')}" aria-label="Select all in group"></button>` : '';

function onItemClick(e, id) {
  if (e.shiftKey && state.lastSel != null) return selectRange(id);
  if (e.target.closest('.sel') || e.metaKey || e.ctrlKey || state.selected.size) return toggleSel(id);
  openDrawer(state.tasks.find((t) => t.id === id));
}
function toggleSel(id) {
  state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
  state.lastSel = id; refreshSel();
}
function selectRange(id) {
  const order = [...document.querySelectorAll('#view [data-sel]')].map((b) => +b.dataset.sel);
  const a = order.indexOf(state.lastSel), b = order.indexOf(id);
  if (a < 0 || b < 0) return toggleSel(id);
  order.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => state.selected.add(x));
  state.lastSel = id; refreshSel();
}
function toggleGroup(ids) {
  const all = ids.every((id) => state.selected.has(id));
  ids.forEach((id) => (all ? state.selected.delete(id) : state.selected.add(id)));
  refreshSel();
}
// Update ticks in place (no full re-render, so scroll position is kept)
function refreshSel() {
  document.querySelectorAll('#view [data-sel]').forEach((b) => {
    const on = state.selected.has(+b.dataset.sel);
    b.classList.toggle('on', on);
    b.closest('.card, .row, .g-label')?.classList.toggle('selected', on);
  });
  document.querySelectorAll('#view [data-selgroup]').forEach((b) => {
    const ids = b.dataset.selgroup.split(',').map(Number), n = ids.filter((id) => state.selected.has(id)).length;
    b.classList.toggle('on', n === ids.length); b.classList.toggle('partial', n > 0 && n < ids.length);
  });
  renderBulk();
}

// ---------- views ----------
function render() {
  const tasks = visibleTasks();
  const main = $('#view');
  if (!state.tasks.length) { main.innerHTML = EMPTY; return; }
  if (state.view === 'boss') return renderBoss(main);
  if (state.view === 'scrum') return renderScrum(main);
  if (state.view === 'gantt') return renderGantt(main, tasks);
  if (state.view === 'list') return renderList(main, tasks);
  return renderBoard(main, tasks);
}

function renderBoard(main, tasks) {
  const gs = groups(tasks);
  main.innerHTML = `<div class="board">${gs.map((g) => {
    const items = tasks.filter(g.match);
    return `<section class="col">
      <div class="col-head">
        <div class="col-title">${groupSel(items)}${g.color ? `<span class="dot" style="background:${g.color}"></span>` : ''}${esc(g.title)}
          <span class="count">${items.length}</span>${hoursIn(items.filter((t) => t.status !== 'done')) ? `<span class="hrs mono" title="Open estimated hours">${hoursIn(items.filter((t) => t.status !== 'done'))}</span>` : ''}</div>
        ${g.locked ? '' : `<button class="col-add" data-add="${g.key}" title="Add task here">+</button>`}
      </div>
      ${g.sub ? `<div class="col-sub" style="margin:-8px 4px 10px">${g.sub}</div>` : ''}
      <div class="drop" data-key="${g.key}">${items.map((t) => `
        <article class="card ${t.status === 'done' ? 'done' : ''} ${state.selected.has(t.id) ? 'selected' : ''}" data-id="${t.id}">
          ${selBox(t.id)}
          <div class="chips">${catChip(t)}${state.groupBy !== 'status' ? `<span class="status-tag ${t.status}">${STATUS[t.status]}</span>` : ''}</div>
          <div class="card-name">${esc(t.name)}</div>
          <div class="chips">${infoChips(t)}</div>
        </article>`).join('')}</div>
    </section>`;
  }).join('')}</div>`;
  wireDrag(main, gs, '.card');
}

function renderList(main, tasks) {
  const gs = groups(tasks);
  main.innerHTML = `<div class="row-head"><span></span><span>Task</span><span class="hide-m">Category</span><span class="hide-m">Status</span><span>Due</span><span class="hide-m">Sprint</span><span class="hide-m">Est.</span><span class="hide-m">Updated</span></div>` +
    gs.map((g) => {
      const items = tasks.filter(g.match);
      return `<section class="group">
        <div class="group-head">${groupSel(items)}${g.color ? `<span class="dot" style="background:${g.color}"></span>` : ''}${esc(g.title)}
          <span class="count">${items.length}</span>${hoursIn(items.filter((t) => t.status !== 'done')) ? `<span class="hrs mono">${hoursIn(items.filter((t) => t.status !== 'done'))}</span>` : ''}${g.sub ? `<span class="col-sub">${g.sub}</span>` : ''}
          ${g.locked ? '' : `<button class="col-add" data-add="${g.key}" title="Add task here">+</button>`}</div>
        <div class="list drop" data-key="${g.key}">${items.map((t) => `
          <div class="row ${t.status === 'done' ? 'done' : ''} ${state.selected.has(t.id) ? 'selected' : ''}" data-id="${t.id}">
            ${selBox(t.id)}
            <span class="name">${esc(t.name)}</span>
            <span class="cell hide-m">${catChip(t) || '—'}</span>
            <span class="cell hide-m"><span class="status-tag ${t.status}">${STATUS[t.status]}</span></span>
            <span class="cell" style="${isOverdue(t) ? 'color:var(--red)' : ''}">${dueLabel(t.due_sprint)}</span>
            <span class="cell hide-m">${sprintLabel(t.sprint_year, t.sprint_number)}${t.sprint_update_count ? ` <span class="chip slipped">×${t.sprint_update_count}</span>` : ''}</span>
            <span class="cell hide-m">${t.estimate_hours != null ? `${t.estimate_hours}h` : '—'}</span>
            <span class="cell hide-m">${new Date(t.updated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
          </div>`).join('') || ''}</div>
      </section>`;
    }).join('');
  wireDrag(main, gs, '.row');
}

// ---------- drag & drop for Board and List ----------
// Dropping into another group saves that group's value (status / category / sprint).
// Dropping between two tasks saves a position halfway between them, so order is kept.
function wireDrag(main, gs, itemSel) {
  const byKey = Object.fromEntries(gs.map((g) => [g.key, g]));
  main.querySelectorAll('.drop').forEach((el) => {
    const g = byKey[el.dataset.key];
    new Sortable(el, {
      group: g.locked ? { name: 'locked-' + g.key, pull: false, put: false } : 'tasks',
      draggable: itemSel, animation: 150,
      filter: '.sel', preventOnFilter: false,       // clicking a tick box never starts a drag
      delay: 160, delayOnTouchOnly: true,           // lets you scroll on a phone without grabbing
      onEnd: (evt) => {
        if (evt.from === evt.to && evt.oldIndex === evt.newIndex) return;
        const id = +evt.item.dataset.id;
        const posOf = (n) => n && n.dataset.id ? state.tasks.find((t) => t.id === +n.dataset.id).position : null;
        const prev = posOf(evt.item.previousElementSibling), next = posOf(evt.item.nextElementSibling);
        const position = prev != null && next != null ? (prev + next) / 2
          : prev != null ? prev + 1 : next != null ? next - 1 : 0;
        const patch = { position };
        if (evt.from !== evt.to) Object.assign(patch, byKey[evt.to.dataset.key].patch);
        if (patch.sprint_number) toast(`Moved to ${sprintLabel(patch.sprint_year, patch.sprint_number)} — slip count +1`);
        patchTask(id, patch);
      },
    });
  });
  main.querySelectorAll(itemSel).forEach((el) => el.addEventListener('click', (e) => onItemClick(e, +el.dataset.id)));
  main.querySelectorAll('[data-selgroup]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); toggleGroup(b.dataset.selgroup.split(',').map(Number)); }));
  refreshSel();
  main.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => openDrawer(null, { ...byKey[b.dataset.add].patch })));
}

// ---------- Gantt (sprint columns) ----------
// A bar runs from the start sprint to the due sprint. Drag the bar to move both,
// drag the left/right edge to change start/due by whole sprints. A tap opens the task.
function renderGantt(main, tasks) {
  const SW = window.innerWidth <= 760 ? 92 : 130;           // width of one sprint column
  const cur = Sprint.currentKey();
  const startOf = (t) => t.start_sprint || Sprint.key(t.sprint_year, t.sprint_number);
  const dueOf = (t) => Math.max(t.due_sprint || startOf(t), startOf(t));
  const rows = [...tasks].sort((a, b) => startOf(a) - startOf(b) || dueOf(a) - dueOf(b) || a.position - b.position);
  let from = Math.min(Sprint.addSprints(cur, -1), ...rows.map(startOf));
  let to = Math.max(Sprint.addSprints(cur, 4), ...rows.map(dueOf));
  const cols = []; for (let k = from; k <= to; k = Sprint.addSprints(k, 1)) cols.push(k);
  const idx = (k) => cols.indexOf(k);
  const W = cols.length * SW;

  // today's position inside the current sprint
  const r = Sprint.sprintRange(...Object.values(Sprint.fromKey(cur)));
  const span = dayDiff(r.start, r.end) + 1, into = dayDiff(r.start, today()) + 0.5;
  const todayX = idx(cur) * SW + (into / span) * SW;

  const head = cols.map((k, i) => {
    const rr = Sprint.sprintRange(...Object.values(Sprint.fromKey(k)));
    return `<div class="g-sp ${k === cur ? 'g-cur' : ''}" style="left:${i * SW}px;width:${SW}px">
      <b>${rr.label.slice(5)}</b> <span>${fmtDate(rr.start)}–${fmtDate(rr.end)}</span>
      <em>${hoursIn(rows.filter((t) => t.sprint_year * 100 + t.sprint_number === k && t.status !== 'done'))}</em></div>`;
  }).join('');
  const bg = cols.map((k, i) => `<div class="g-band ${k === cur ? 'g-cur' : ''}" style="left:${i * SW}px;width:${SW}px"></div>`).join('')
    + `<div class="g-todayline" style="left:${todayX}px"></div>`;

  main.innerHTML = `<div class="gantt"><div class="g-grid" style="width:calc(var(--lw) + ${W}px)">
    <div class="g-head"><div class="g-corner">Task</div><div class="g-scale" style="width:${W}px">${head}</div></div>
    <div style="position:relative">
      <div style="position:absolute;top:0;bottom:0;left:var(--lw);width:${W}px">${bg}</div>
      ${rows.map((t) => {
        const s0 = idx(startOf(t)), e0 = idx(dueOf(t));
        const col = t.category_color || '#0C0C0D';
        const dark = ['#7BFDFD', '#FCED67', '#7CFE86'].includes((col || '').toUpperCase());
        return `<div class="g-row">
          <div class="g-label ${state.selected.has(t.id) ? 'selected' : ''}" data-open="${t.id}">${selBox(t.id)}${t.category_color ? `<span class="dot" style="background:${t.category_color}"></span>` : ''}<span>${esc(t.name)}</span>${t.estimate_hours != null ? `<em class="mono">${t.estimate_hours}h</em>` : ''}</div>
          <div class="g-track" style="width:${W}px">
            <div class="g-bar ${t.due_sprint ? '' : 'nodeadline'} ${t.status === 'done' ? 'done' : ''} ${isOverdue(t) ? 'overdue' : ''}"
                 data-id="${t.id}" style="left:${s0 * SW + 4}px;width:${(e0 - s0 + 1) * SW - 8}px;background:${col};${dark ? 'color:#0C0C0D' : ''}"
                 title="${esc(t.name)} · ${Sprint.keyLabel(startOf(t))} → ${t.due_sprint ? Sprint.keyLabel(t.due_sprint) : 'no due sprint'}">
              <span class="g-handle l"></span>${esc(t.name)}<span class="g-handle r"></span>
            </div>
          </div></div>`;
      }).join('')}
    </div></div></div>`;
  $('.gantt').style.setProperty('--lw', window.innerWidth <= 760 ? '140px' : '260px');
  $('.gantt').scrollLeft = Math.max(0, (idx(cur) - 1) * SW);

  main.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', (e) => onItemClick(e, +el.dataset.open)));
  main.querySelectorAll('.g-bar').forEach((bar) => wireBar(bar, SW, startOf, dueOf));
}

function wireBar(bar, SW, startOf, dueOf) {
  bar.addEventListener('pointerdown', (e) => {
    const t = state.tasks.find((k) => k.id === +bar.dataset.id);
    const mode = e.target.classList.contains('l') ? 'start' : e.target.classList.contains('r') ? 'end' : 'move';
    const x0 = e.clientX, left0 = bar.offsetLeft, w0 = bar.offsetWidth;
    const s0 = startOf(t), d0 = dueOf(t);
    let n = 0, moved = false;
    const tip = document.createElement('div'); tip.className = 'g-tip';
    bar.setPointerCapture(e.pointerId);
    let span = 0; for (let k = s0; k < d0; k = Sprint.addSprints(k, 1)) span++;   // sprints between start and due

    const onMove = (ev) => {
      const dx = ev.clientX - x0;
      if (Math.abs(dx) > 4) moved = true;
      if (!moved) return;
      n = Math.round(dx / SW);
      if (mode === 'start') n = Math.min(n, span);
      if (mode === 'end') n = Math.max(n, -span);
      bar.classList.add('dragging');
      if (mode === 'move') bar.style.left = `${left0 + n * SW}px`;
      if (mode === 'start') { bar.style.left = `${left0 + n * SW}px`; bar.style.width = `${w0 - n * SW}px`; }
      if (mode === 'end') bar.style.width = `${w0 + n * SW}px`;
      const ns = mode === 'end' ? s0 : Sprint.addSprints(s0, n), nd = mode === 'start' ? d0 : Sprint.addSprints(d0, n);
      tip.textContent = `${Sprint.keyLabel(ns)} → ${Sprint.keyLabel(nd)}`;
      if (!tip.isConnected) document.body.append(tip);
      tip.style.left = ev.clientX + 12 + 'px'; tip.style.top = ev.clientY - 30 + 'px';
    };
    const onUp = () => {
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', onUp);
      tip.remove();
      if (!moved) return openDrawer(t);
      if (!n) return render();
      const patch = {};
      if (mode !== 'end') patch.start_sprint = Sprint.addSprints(s0, n);
      if (mode !== 'start') patch.due_sprint = Sprint.addSprints(d0, n);
      patchTask(t.id, patch);
    };
    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', onUp);
  });
}

// ---------- drawer (create / edit) ----------
function fillSprintSelects(year, number) {
  const f = $('#taskForm'), y0 = currentSprint().year;
  f.sprint_year.innerHTML = [y0 - 1, y0, y0 + 1].map((y) => `<option>${y}</option>`).join('');
  f.sprint_year.value = year;
  const fillNums = () => {
    const y = +f.sprint_year.value;
    f.sprint_number.innerHTML = Array.from({ length: 26 }, (_, i) => {
      const r = Sprint.sprintRange(y, i + 1);
      return `<option value="${i + 1}">S${pad(i + 1)} · ${fmtDate(r.start)} – ${fmtDate(r.end)}</option>`;
    }).join('');
  };
  fillNums();
  f.sprint_year.onchange = fillNums;
  f.sprint_number.value = number;
}

function setStatus(v) {
  $('#statusSeg').dataset.value = v;
  document.querySelectorAll('#statusSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
}

function openDrawer(task, draft = {}) {
  state.editing = task || null;
  const f = $('#taskForm');
  const t = task || {};
  const cur = currentSprint();
  const catName = task ? (task.category_name || '')
    : draft.category_id ? (state.categories.find((c) => c.id === draft.category_id)?.name || '') : '';
  $('#drawerTitle').textContent = task ? `Task #${task.id}` : 'New task';
  f.name.value = t.name || '';
  f.category.value = catName;
  setStatus(t.status || draft.status || 'todo');
  const planned = Sprint.key(t.sprint_year || draft.sprint_year || cur.year, t.sprint_number || draft.sprint_number || cur.number);
  f.start_sprint.innerHTML = sprintOptions(task ? t.start_sprint : planned);
  f.due_sprint.innerHTML = sprintOptions(task ? t.due_sprint : (draft.due_sprint || planned), { none: true });
  f.estimate_hours.value = t.estimate_hours ?? '';
  fillSprintSelects(t.sprint_year || draft.sprint_year || cur.year, t.sprint_number || draft.sprint_number || cur.number);
  f.notes.value = t.notes || '';
  $('#deleteBtn').hidden = !task;
  $('#meta').innerHTML = task ? `
    <dt>Created</dt><dd>${fmtStamp(task.created_at)}</dd>
    <dt>Last updated</dt><dd>${fmtStamp(task.updated_at)}</dd>
    <dt>Sprint moved</dt><dd>${task.sprint_update_count} time${task.sprint_update_count === 1 ? '' : 's'}</dd>
    <dt>Calendar</dt><dd>${task.calendar_event_id ? 'Time blocked' : '—'}</dd>` : '';
  $('#meta').hidden = !task;
  // New task: picking a due sprint plans the task into that sprint too
  f.due_sprint.onchange = () => {
    if (state.editing || !f.due_sprint.value) return;
    const s = Sprint.fromKey(+f.due_sprint.value);
    fillSprintSelects(s.year, s.number);
  };
  $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;
  setTimeout(() => f.name.focus(), 50);
}

function closeDrawer() {
  $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
}

async function saveDrawer(e) {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.name.value.trim(),
    status: $('#statusSeg').dataset.value,
    start_sprint: +f.start_sprint.value,
    due_sprint: f.due_sprint.value ? +f.due_sprint.value : null,
    estimate_hours: f.estimate_hours.value === '' ? null : +f.estimate_hours.value,
    sprint_year: +f.sprint_year.value,
    sprint_number: +f.sprint_number.value,
    notes: f.notes.value.trim() || null,
  };
  const cat = f.category.value.trim();
  if (cat) body.category = cat; else body.category_id = null;   // a new name creates the category
  try {
    if (state.editing) await api('PATCH', `/api/tasks/${state.editing.id}`, body);
    else await api('POST', '/api/tasks', body);
    closeDrawer(); toast(state.editing ? 'Saved' : 'Task added');
  } catch (err) { return toast(err.message); }
  load();
}

// ---------- events ----------
function wire() {
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.view; savePref('view', state.view); renderChrome(); render();
  }));
  $('#groupBy').addEventListener('change', (e) => { state.groupBy = e.target.value; savePref('groupBy', state.groupBy); render(); });
  $('#fCategory').addEventListener('change', (e) => { state.filter.category = e.target.value; render(); });
  $('#fSprint').addEventListener('change', (e) => { state.filter.sprint = e.target.value; render(); });
  $('#fSearch').addEventListener('input', (e) => { state.filter.q = e.target.value; render(); });
  $('#fDone').addEventListener('change', (e) => { state.filter.showDone = e.target.checked; render(); });

  $('#quickAdd').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#qaName').value.trim(); if (!name) return;
    const body = { name };
    if (state.filter.category && state.filter.category !== 'none') body.category_id = +state.filter.category;
    try { await api('POST', '/api/tasks', body); $('#qaName').value = ''; toast('Task added'); load(); }
    catch (err) { toast(err.message); }
  });

  $('#stats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-jump]'); if (!b) return;
    if (b.dataset.jump === 'sprint') { const c = currentSprint(); state.filter.sprint = `${c.year}-${c.number}`; $('#fSprint').value = state.filter.sprint; state.groupBy = 'status'; }
    else state.groupBy = 'due';
    if (state.view === 'gantt') state.view = 'list';
    renderChrome(); render();
  });

  $('#statusSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setStatus(b.dataset.v); });
  $('#taskForm').addEventListener('submit', saveDrawer);
  $('#closeDrawer').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('#drawer').classList.contains('open')) closeDrawer();
    else if (state.selected.size) { state.selected.clear(); refreshSel(); }
  });
  wireBulk();
  $('#deleteBtn').addEventListener('click', async () => {
    if (!state.editing || !confirm(`Delete "${state.editing.name}"?`)) return;
    await api('DELETE', `/api/tasks/${state.editing.id}`); closeDrawer(); toast('Deleted'); load();
  });

  $('#themeBtn').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    savePref('theme', document.documentElement.dataset.theme);
  });
  const th = pref('theme', ''); if (th) document.documentElement.dataset.theme = th;

  // Pick up changes Claude makes: refresh when you come back to the tab, and every minute.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  setInterval(() => { if (!document.hidden && !$('#drawer').classList.contains('open')) load(); }, 60000);
}

// ---------- boss: clock + work record ----------
function renderClock() {
  const t = state.today, b = $('#clockBtn');
  if (!t) return;
  b.classList.remove('in', 'late', 'out');
  if (!t.clock_in) { b.textContent = t.late && t.workday ? 'Clock in · late' : 'Clock in'; if (t.late && t.workday) b.classList.add('late'); }
  else if (!t.clock_out) { b.textContent = `In ${t.clock_in} · Clock out`; b.classList.add(t.late ? 'late' : 'in'); }
  else { b.textContent = `${t.clock_in}–${t.clock_out}`; b.classList.add('out'); }
}

async function clockAction() {
  const t = state.today;
  if (t.clock_in && !t.clock_out) {
    if (!t.eod_report && !confirm('No end-of-day report filed yet. Clock out anyway?')) { state.view = 'boss'; renderChrome(); return render(); }
    await api('POST', '/api/work/clock-out'); toast('Clocked out');
  } else if (!t.clock_in) {
    const r = await api('POST', '/api/work/clock-in');
    toast(r.late ? `Clocked in ${r.clock_in}. Late.` : `Clocked in ${r.clock_in}. On time.`);
  } else return;
  load();
}

const pct = (v) => (v == null ? '—' : `${v}%`);
const tile = (label, value, sub = '', tone = '') => `<div class="tile ${tone}"><div class="tile-v">${value}</div><div class="tile-l">${label}</div>${sub ? `<div class="tile-s">${sub}</div>` : ''}</div>`;
const taskLine = (t) => `<li class="tl ${t.status === 'done' ? 'done' : ''}" data-open="${t.id}"><span class="status-tag ${t.status || ''}">${STATUS[t.status] || 'Overdue'}</span><span>${esc(t.name)}</span><span class="mono muted">${t.estimate_hours != null ? `${t.estimate_hours}h · ` : ''}${t.due_sprint ? `due ${t.due_sprint}` : ''}</span></li>`;

async function renderBoss(main) {
  main.innerHTML = `<div class="empty"><div>Loading your record…</div></div>`;
  const [sc, ex] = await Promise.all([api('GET', '/api/work/scorecard?days=30'), api('GET', '/api/work/excuses?days=30')]);
  if (state.view !== 'boss') return;
  const t = state.today, a = sc.attendance, d = sc.delivery, c = sc.commitments;
  const dateLabel = new Date(`${t.date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const status = !t.workday ? 'Weekend.' :
    !t.clock_in ? (t.late ? `Not clocked in. Work started at ${t.work_hours.split('-')[0]}.` : `Work starts at ${t.work_hours.split('-')[0]}.`) :
    t.clock_out ? `Worked ${t.clock_in}–${t.clock_out}.` : `In since ${t.clock_in}${t.late ? ' — late' : ' — on time'}.`;
  const commits = t.commitments.length
    ? `<ul class="tlist">${t.commitments.map(taskLine).join('')}</ul>`
    : `<p class="muted">No commitments yet. They're set at the daily scrum — or tick tasks on the Board or List and press <b>Commit today</b>.</p>`;
  const dueAndOverdue = [...t.overdue.map((x) => ({ ...x, status: null })), ...t.due_this_sprint.filter((x) => x.status !== 'done')];

  main.innerHTML = `<div class="boss">
    <section class="boss-hero ${t.late && t.workday && !t.clock_out ? 'late' : ''}">
      <div>
        <div class="overline mono">${esc(dateLabel)} · hours ${t.work_hours}</div>
        <h2>${esc(status)}</h2>
        <div class="mono hero-sub">On-time streak: <b>${a.streak_on_time}</b> day${a.streak_on_time === 1 ? '' : 's'} · Daily scrums <b>${sc.daily_scrums.held}/${sc.daily_scrums.working_days}</b></div>
        ${t.ceremonies_due.length ? `<div class="due-cers">${t.ceremonies_due.map((c) => `<span class="cer ${c.recorded ? 'ok' : c.overdue ? 'bad' : ''}">${c.recorded ? '✓' : '○'} ${KIND[c.kind].label}${c.kind === 'daily_scrum' ? ` ${c.at}` : ''}${c.overdue && !c.recorded ? ' — overdue' : ''}</span>`).join('')}</div>` : ''}
      </div>
      <div class="hero-actions">
        ${!t.clock_in ? `<button class="btn green" data-clock>Clock in</button>` : !t.clock_out ? `<button class="btn ghost" data-clock>Clock out</button>` : ''}
      </div>
    </section>

    <div class="tiles">
      ${tile('On-time arrivals', pct(a.on_time_pct), `${a.on_time}/${a.working_days} days · ${a.absent} absent`, a.on_time_pct != null && a.on_time_pct < 80 ? 'bad' : '')}
      ${tile('Delivered on time', `${d.on_time}/${d.completed}`, `${d.late} late`, d.late ? 'bad' : '')}
      ${tile('Commitments kept', pct(c.kept_pct), `${c.kept}/${c.committed}`, c.kept_pct != null && c.kept_pct < 80 ? 'bad' : '')}
      ${tile('Excuses logged', d.slips_with_excuses, 'last 30 days', d.slips_with_excuses > 3 ? 'bad' : '')}
      ${tile('Overdue now', d.overdue_now, '', d.overdue_now ? 'bad' : '')}
      ${tile('EOD reports', `${sc.eod_reports.filed}/${sc.eod_reports.due}`, 'filed / due', sc.eod_reports.filed < sc.eod_reports.due ? 'bad' : '')}
    </div>

    <div class="boss-grid">
      <section class="panel"><h3>Today's commitments ${t.commitments_estimate_hours ? `<span class="hrs mono">${t.commitments_estimate_hours}h</span>` : ''}</h3>${commits}</section>
      <section class="panel"><h3>Overdue & due this sprint</h3>${dueAndOverdue.length ? `<ul class="tlist">${dueAndOverdue.map(taskLine).join('')}</ul>` : '<p class="muted">Nothing due. Get ahead.</p>'}</section>
      <section class="panel"><h3>End-of-day report</h3>
        ${t.eod_report ? `<p class="eod-filed">${esc(t.eod_report)}</p>` :
          `<textarea id="eodText" rows="5" placeholder="What shipped today? What didn't, and why? What's first tomorrow?"></textarea>
           <button class="btn primary" id="eodSubmit">File report</button>`}
      </section>
      <section class="panel"><h3>Excuse log <span class="count">${ex.length}</span></h3>
        ${ex.length ? `<ul class="xlist">${ex.slice(0, 12).map((e) => `<li><div><b>${esc(e.task_name)}</b> <span class="mono muted">${e.kind === 'sprint_moved' ? 'sprint' : 'due'} ${esc(e.old_value || '')} → ${esc(e.new_value || '')}</span></div>
          <div class="reason">“${esc(e.reason)}”</div><div class="mono muted">${fmtStamp(e.created_at)}</div></li>`).join('')}</ul>` : '<p class="muted">Clean. Keep it that way.</p>'}
      </section>
      <section class="panel wide"><h3>Last working days</h3>
        <table class="ledger mono"><tr><th>Date</th><th>In</th><th>Out</th><th>Kept</th><th>EOD</th></tr>
        ${sc.ledger.slice(0, 10).map((l) => `<tr><td>${fmtDate(l.date)}</td><td class="${!l.in ? 'bad' : l.in > t.work_hours.split('-')[0] ? 'warn' : ''}">${l.in || 'absent'}</td><td>${l.out || '—'}</td><td>${l.committed ? `${l.kept}/${l.committed}` : '—'}</td><td>${l.eod ? '✓' : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Starts the first day you clock in.</td></tr>'}
        </table>
      </section>
    </div>
  </div>`;
  main.querySelectorAll('[data-clock]').forEach((b) => b.addEventListener('click', clockAction));
  main.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => openDrawer(state.tasks.find((x) => x.id === +el.dataset.open))));
  $('#eodSubmit')?.addEventListener('click', async () => {
    try { await api('POST', '/api/work/eod', { report: $('#eodText').value }); toast('Report filed'); load(); }
    catch (e) { toast(e.message); }
  });
}

// ---------- scrum ceremonies view ----------
const KIND = {
  sprint_planning: { label: 'Sprint planning', cls: 'k-plan' },
  daily_scrum: { label: 'Daily scrum', cls: 'k-daily' },
  sprint_review: { label: 'Sprint review', cls: 'k-review' },
  retrospective: { label: 'Retrospective', cls: 'k-retro' },
};
const human = (k) => k.replace(/_task_ids$/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const taskChip = (id) => {
  const t = state.tasks.find((x) => x.id === id);
  return `<button class="tchip ${t ? t.status : 'gone'}" data-open="${id}">${t ? esc(t.name) : '(deleted task)'}${t ? `<span>${STATUS[t.status]}</span>` : ''}</button>`;
};
function detailsHtml(d) {
  return Object.entries(d || {}).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length)).map(([k, v]) => {
    let body;
    if (k.endsWith('task_ids')) body = `<div class="tchips">${v.map(Number).map(taskChip).join('')}</div>`;
    else if (Array.isArray(v)) body = `<ul>${v.map((x) => `<li>${esc(typeof x === 'object' ? JSON.stringify(x) : x)}</li>`).join('')}</ul>`;
    else body = `<p>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</p>`;
    return `<div class="dsec"><div class="dlabel mono">${esc(human(k))}</div>${body}</div>`;
  }).join('');
}

async function renderScrum(main) {
  if (!state.scrumSprint) state.scrumSprint = currentSprint();
  const { year, number } = state.scrumSprint;
  main.innerHTML = `<div class="empty"><div>Loading sprint…</div></div>`;
  const [st, cer] = await Promise.all([
    api('GET', `/api/sprint-status?year=${year}&number=${number}`),
    api('GET', `/api/ceremonies?sprint_year=${year}&sprint_number=${number}`),
  ]);
  if (state.view !== 'scrum') return;
  const total = st.done.length + st.in_progress.length + st.todo.length;
  const pctDone = total ? Math.round((st.done.length / total) * 100) : 0;
  const filt = state.scrumKind || '';
  const items = cer.filter((c) => !filt || c.kind === filt);
  const tick = (ok, text) => `<span class="cer ${ok ? 'ok' : ''}">${ok ? '✓' : '○'} ${text}</span>`;
  const [dHeld, dDue] = st.ceremonies.daily_scrums.split('/').map(Number);

  main.innerHTML = `<div class="scrum">
    <section class="sprint-head">
      <div class="sprint-nav">
        <button class="icon-btn" data-sp="-1" aria-label="Previous sprint">‹</button>
        <div><div class="overline mono">${fmtDate(st.start)} – ${fmtDate(st.end)} · ${st.working_days} working days</div>
          <h2>${st.sprint}${year === currentSprint().year && number === currentSprint().number ? ' <span class="cur mono">current</span>' : ''}</h2></div>
        <button class="icon-btn" data-sp="1" aria-label="Next sprint">›</button>
      </div>
      <div class="goal">${st.goal ? `<span class="dlabel mono">Sprint goal</span> ${esc(st.goal)}` : '<span class="muted">No sprint goal yet — set at sprint planning.</span>'}</div>
      <div class="progress"><div style="width:${pctDone}%"></div></div>
      <div class="mono prog-l">${st.done.length}/${total} tasks done · ${st.in_progress.length} in progress · ${st.todo.length} to do · ${st.completed_in_window.late} delivered late · ${st.excuses_in_window.length} excuses</div>
      <div class="mono prog-l ${st.hours.estimated_open > st.hours.capacity ? 'over' : ''}">Load: ${+st.hours.estimated_open.toFixed(1)}h open of ${+st.hours.estimated_total.toFixed(1)}h estimated · capacity ${st.hours.capacity}h (${st.hours.capacity_note})${st.hours.unestimated_tasks ? ` · ${st.hours.unestimated_tasks} task${st.hours.unestimated_tasks === 1 ? '' : 's'} without an estimate` : ''}</div>
      <div class="cers">
        ${tick(st.ceremonies.sprint_planning, 'Planning')}
        ${tick(dDue && dHeld >= dDue, `Daily scrums ${st.ceremonies.daily_scrums}`)}
        ${tick(st.ceremonies.sprint_review, 'Review')}
        ${tick(st.ceremonies.retrospective, 'Retro')}
      </div>
    </section>

    <div class="kind-filter">
      <button class="kf ${!filt ? 'on' : ''}" data-kind="">All <span class="count">${cer.length}</span></button>
      ${Object.entries(KIND).map(([k, v]) => `<button class="kf ${filt === k ? 'on' : ''}" data-kind="${k}"><span class="kdot ${v.cls}"></span>${v.label} <span class="count">${cer.filter((c) => c.kind === k).length}</span></button>`).join('')}
    </div>

    ${items.length ? `<div class="cer-list">${items.map((c) => `
      <article class="cer-card">
        <div class="cer-top"><span class="kbadge ${KIND[c.kind].cls}">${KIND[c.kind].label}</span>
          <span class="mono muted">${new Date(`${c.day}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</span></div>
        <p class="cer-sum">${esc(c.summary)}</p>
        <div class="dgrid">${detailsHtml(c.details)}</div>
        ${c.task_ids.length && !Object.keys(c.details || {}).some((k) => k.endsWith('task_ids')) ? `<div class="tchips">${c.task_ids.map(taskChip).join('')}</div>` : ''}
      </article>`).join('')}</div>`
      : `<div class="empty"><h3>No ceremonies recorded${filt ? ' of this type' : ''} in ${st.sprint}</h3><div>They're recorded when you run them with your boss in Claude.</div></div>`}
  </div>`;

  main.querySelectorAll('[data-sp]').forEach((b) => b.addEventListener('click', () => {
    let { year: y, number: n } = state.scrumSprint;
    n += +b.dataset.sp;
    if (n < 1) { y--; n = 26; } if (n > 26) { y++; n = 1; }
    state.scrumSprint = { year: y, number: n }; render();
  }));
  main.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => { state.scrumKind = b.dataset.kind; render(); }));
  main.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => {
    const t = state.tasks.find((x) => x.id === +el.dataset.open); if (t) openDrawer(t);
  }));
}

// ---------- bulk action bar ----------
function renderBulk() {
  const n = state.selected.size;
  document.body.classList.toggle('selecting', n > 0);
  $('#bulkBar').hidden = !n;
  if (!n) return;
  $('#bulkCount').textContent = `${n} selected`;
  // Sprint choices: current sprint + the next 12
  const sel = $('#bSprint');
  if (!sel.dataset.filled) {
    let { year, number } = currentSprint(); const opts = [];
    for (let i = 0; i < 13; i++) {
      const r = Sprint.sprintRange(year, number);
      opts.push(`<option value="${year}-${number}">${r.label} · ${fmtDate(r.start)}</option>`);
      number === 26 ? (year++, number = 1) : number++;
    }
    sel.innerHTML = `<option value="">Sprint…</option><option value="next">→ Next sprint (each)</option>` + opts.join('');
    sel.dataset.filled = '1';
    $('#bDue').innerHTML = `<option value="">Due…</option>` + sprintOptions(null) + `<option value="none">No due sprint</option>`;
  }
}

async function bulk(patch, label) {
  const ids = [...state.selected];
  try {
    const r = await api('POST', '/api/tasks/bulk-update', { ids, patch });
    toast(`${label} · ${r.updated} task${r.updated === 1 ? '' : 's'}`);
  } catch (e) { toast(e.message); }
  load();
}

function wireBulk() {
  $('#bStatus').addEventListener('change', (e) => {
    const v = e.target.value; e.target.value = '';
    if (v) bulk({ status: v }, `Status → ${STATUS[v]}`);
  });
  const setCat = () => {
    const v = $('#bCategory').value.trim(); $('#bCategory').value = '';
    bulk(v ? { category: v } : { category_id: null }, v ? `Category → ${v}` : 'Category cleared');
  };
  $('#bCatApply').addEventListener('click', setCat);
  $('#bCategory').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); setCat(); } });
  $('#bSprint').addEventListener('change', (e) => {
    const v = e.target.value; e.target.value = '';
    if (!v) return;
    if (v === 'next') return bulk({ sprint_next: true }, 'Moved to next sprint (slip +1)');
    const [y, n] = v.split('-').map(Number);
    bulk({ sprint_year: y, sprint_number: n }, `Sprint → ${sprintLabel(y, n)}`);
  });
  $('#bDue').addEventListener('change', (e) => {
    const v = e.target.value; e.target.value = '';
    if (v === 'none') return bulk({ due_sprint: null }, 'Due sprint cleared');
    if (v) bulk({ due_sprint: +v }, `Due → ${Sprint.keyLabel(+v)}`);
  });
  document.querySelectorAll('[data-shift]').forEach((b) => b.addEventListener('click', () => {
    const n = +b.dataset.shift;
    bulk({ due_shift_sprints: n }, `Due sprints ${n > 0 ? '+' : ''}${n}`);
  }));
  $('#bEstimate').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = e.target.value; e.target.value = '';
    bulk({ estimate_hours: v === '' ? null : +v }, v === '' ? 'Estimates cleared' : `Estimate → ${v}h each`);
  });
  $('#bDelete').addEventListener('click', async () => {
    const n = state.selected.size;
    if (!confirm(`Delete ${n} task${n === 1 ? '' : 's'}? This can't be undone.`)) return;
    try {
      const r = await api('POST', '/api/tasks/bulk-delete', { ids: [...state.selected] });
      state.selected.clear();
      const cal = r.calendar_events_to_remove.length;
      toast(`Deleted ${r.deleted}${cal ? ` · ${cal} had calendar blocks — ask Claude to remove them` : ''}`);
    } catch (e) { toast(e.message); }
    load();
  });
  $('#bClear').addEventListener('click', () => { state.selected.clear(); refreshSel(); });
  $('#bCommit').addEventListener('click', async () => {
    const ids = [...state.selected];
    try {
      await api('PUT', '/api/work/commitments', { ids });
      toast(`Committed to ${ids.length} task${ids.length === 1 ? '' : 's'} today`);
      state.selected.clear(); load();
    } catch (e) { toast(e.message); }
  });
  $('#clockBtn').addEventListener('click', clockAction);
}

wire();
load().catch((e) => { $('#view').innerHTML = `<div class="empty"><h3>Couldn't load tasks</h3><div>${esc(e.message)}</div></div>`; });
