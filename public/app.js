/* Task Manager — frontend (vanilla JS, no build step).
   Flow: load data from the API → filter → render the chosen view.
   Every edit (drag, drawer, Gantt) is a PATCH to the API, then a reload. */

const $ = (s, el = document) => el.querySelector(s);
const STATUS = { todo: 'To do', in_progress: 'In progress', done: 'Done' };

const state = {
  tasks: [], categories: [], summary: null,
  view: pref('view', 'board'), groupBy: pref('groupBy', 'status'), zoom: +pref('zoom', 34),
  filter: { category: '', sprint: '', q: '', showDone: true },
  editing: null,      // task being edited in the drawer (null = new)
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
const shiftIso = (iso, n) => { const d = new Date(iso); d.setDate(d.getDate() + n); return d.toISOString(); };
const fmtDate = (s) => parseYmd(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const fmtDeadline = (iso) => { const d = new Date(iso); return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); };
const fmtStamp = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const sprintKey = (t) => `${t.sprint_year}-${t.sprint_number}`;
const sprintLabel = (y, n) => `${y}-S${pad(n)}`;
const isOverdue = (t) => t.deadline && t.status !== 'done' && new Date(t.deadline) < new Date();
const today = () => ymd(new Date());
const currentSprint = () => Sprint.sprintFor(new Date());

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- data ----------
async function load() {
  const [tasks, categories, summary] = await Promise.all([
    api('GET', '/api/tasks'), api('GET', '/api/categories'), api('GET', '/api/summary'),
  ]);
  Object.assign(state, { tasks, categories, summary });
  renderChrome();
  render();
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
  // deadline buckets: reorder within a bucket only (dates are changed in the drawer or Gantt)
  const t0 = today(), wk = addDays(t0, 7);
  const dl = (t) => (t.deadline ? ymd(new Date(t.deadline)) : null);
  return [
    { key: 'overdue', title: 'Overdue', color: '#FC3A5D', match: (t) => isOverdue(t) },
    { key: 'today', title: 'Today', color: '#65BC7B', match: (t) => !isOverdue(t) && dl(t) === t0 },
    { key: 'week', title: 'Next 7 days', match: (t) => !isOverdue(t) && dl(t) > t0 && dl(t) <= wk },
    { key: 'later', title: 'Later', match: (t) => !isOverdue(t) && dl(t) > wk },
    { key: 'past-done', title: 'Past (done)', match: (t) => t.deadline && !isOverdue(t) && dl(t) < t0 },
    { key: 'none', title: 'No deadline', color: '#B0B0B4', match: (t) => !t.deadline },
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
    <button class="stat" data-jump="week"><b>${s.due_this_week}</b> due in 7 days</button>
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
  $('#zoom').value = String(state.zoom);
  $('#groupWrap').hidden = state.view === 'gantt';
  $('#zoomWrap').hidden = state.view !== 'gantt';
}

// ---------- shared card bits ----------
function catChip(t) {
  return t.category_name
    ? `<span class="chip cat"><span class="dot" style="background:${t.category_color}"></span>${esc(t.category_name)}</span>`
    : '';
}
function infoChips(t) {
  return [
    t.deadline ? `<span class="chip ${isOverdue(t) ? 'overdue' : ''}">${isOverdue(t) ? 'Overdue · ' : ''}${fmtDeadline(t.deadline)}</span>` : '',
    `<span class="chip">${sprintLabel(t.sprint_year, t.sprint_number)}</span>`,
    t.sprint_update_count ? `<span class="chip slipped" title="Sprint changed ${t.sprint_update_count} time(s)">Slipped ×${t.sprint_update_count}</span>` : '',
    t.notes ? `<span class="chip notes" title="Has notes">notes</span>` : '',
  ].join('');
}

const EMPTY = `<div class="empty">
  <svg viewBox="0 0 160 110" aria-hidden="true">${[[40,30],[80,30],[120,30],[60,64],[100,64],[80,98]].map(([x,y]) =>
    `<polygon points="${x},${y-18} ${x+16},${y-9} ${x+16},${y+9} ${x},${y+18} ${x-16},${y+9} ${x-16},${y-9}" fill="none" stroke="#65BC7B" stroke-width="4"/>`).join('')}</svg>
  <h3>Nothing here yet</h3><div>Add a task above, or ask Claude to add one.</div></div>`;

// ---------- views ----------
function render() {
  const tasks = visibleTasks();
  const main = $('#view');
  if (!state.tasks.length) { main.innerHTML = EMPTY; return; }
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
        <div class="col-title">${g.color ? `<span class="dot" style="background:${g.color}"></span>` : ''}${esc(g.title)}
          <span class="count">${items.length}</span></div>
        ${g.locked ? '' : `<button class="col-add" data-add="${g.key}" title="Add task here">+</button>`}
      </div>
      ${g.sub ? `<div class="col-sub" style="margin:-8px 4px 10px">${g.sub}</div>` : ''}
      <div class="drop" data-key="${g.key}">${items.map((t) => `
        <article class="card ${t.status === 'done' ? 'done' : ''}" data-id="${t.id}">
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
  main.innerHTML = `<div class="row-head"><span></span><span>Task</span><span class="hide-m">Category</span><span class="hide-m">Status</span><span>Deadline</span><span class="hide-m">Sprint</span><span class="hide-m">Updated</span></div>` +
    gs.map((g) => {
      const items = tasks.filter(g.match);
      return `<section class="group">
        <div class="group-head">${g.color ? `<span class="dot" style="background:${g.color}"></span>` : ''}${esc(g.title)}
          <span class="count">${items.length}</span>${g.sub ? `<span class="col-sub">${g.sub}</span>` : ''}
          ${g.locked ? '' : `<button class="col-add" data-add="${g.key}" title="Add task here">+</button>`}</div>
        <div class="list drop" data-key="${g.key}">${items.map((t) => `
          <div class="row ${t.status === 'done' ? 'done' : ''}" data-id="${t.id}">
            <span class="handle" aria-hidden="true">⠿</span>
            <span class="name">${esc(t.name)}</span>
            <span class="cell hide-m">${catChip(t) || '—'}</span>
            <span class="cell hide-m"><span class="status-tag ${t.status}">${STATUS[t.status]}</span></span>
            <span class="cell" style="${isOverdue(t) ? 'color:var(--red)' : ''}">${t.deadline ? fmtDeadline(t.deadline) : '—'}</span>
            <span class="cell hide-m">${sprintLabel(t.sprint_year, t.sprint_number)}${t.sprint_update_count ? ` <span class="chip slipped">×${t.sprint_update_count}</span>` : ''}</span>
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
  main.querySelectorAll(itemSel).forEach((el) => el.addEventListener('click', () => openDrawer(state.tasks.find((t) => t.id === +el.dataset.id))));
  main.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => openDrawer(null, { ...byKey[b.dataset.add].patch })));
}

// ---------- Gantt ----------
// A bar runs from start_date to the deadline's date. Drag the bar to shift both,
// drag the left/right edge to change start/deadline. A tap opens the task.
function renderGantt(main, tasks) {
  const dw = state.zoom;
  const rows = [...tasks].sort((a, b) => a.start_date.localeCompare(b.start_date) || a.position - b.position);
  const endOf = (t) => (t.deadline ? ymd(new Date(t.deadline)) : t.start_date);
  const cur = Sprint.sprintRange(...Object.values(currentSprint()));
  let from = [cur.start, ...rows.map((t) => t.start_date)].sort()[0];
  let to = [addDays(today(), 21), ...rows.map(endOf)].sort().pop();
  from = addDays(from, -3); to = addDays(to, 5);
  const days = dayDiff(from, to) + 1;
  const W = days * dw;
  const x = (s) => dayDiff(from, s) * dw;

  // header: sprint row + day row; background: sprint bands, weekends, today line
  let sprints = '', dayCells = '', bg = '';
  let segStart = 0, segSprint = Sprint.sprintFor(from);
  for (let i = 0; i <= days; i++) {
    const d = addDays(from, i);
    const sp = i < days ? Sprint.sprintFor(d) : null;
    if (!sp || sp.number !== segSprint.number || sp.year !== segSprint.year) {
      const w = (i - segStart) * dw;
      sprints += `<div class="g-sprint" style="left:${segStart * dw}px;width:${w}px">${sprintLabel(segSprint.year, segSprint.number)}</div>`;
      if (segSprint.number % 2 === 0) bg += `<div class="g-band" style="left:${segStart * dw}px;width:${w}px"></div>`;
      segStart = i; segSprint = sp;
    }
    if (i === days) break;
    const dt = parseYmd(d), wd = dt.getDay(), wkend = wd === 0 || wd === 6;
    if (wkend) bg += `<div class="g-wkend" style="left:${i * dw}px;width:${dw}px"></div>`;
    let label = '';
    if (dw >= 30) label = `${dt.getDate() === 1 ? dt.toLocaleDateString('en-GB', { month: 'short' }) : 'SMTWTFS'[wd]}<br>${dt.getDate()}`;
    else if (wd === 1) label = `${dt.getDate()}<br>${dt.toLocaleDateString('en-GB', { month: 'short' })}`;
    if (label || dw >= 30) dayCells += `<div class="g-day ${wkend ? 'wkend' : ''} ${d === today() ? 'today' : ''}" style="left:${i * dw}px;width:${dw >= 30 ? dw : dw * 7}px">${label}</div>`;
  }
  bg += `<div class="g-todayline" style="left:${x(today()) + dw / 2}px"></div>`;

  main.innerHTML = `<div class="gantt"><div class="g-grid" style="width:calc(var(--lw) + ${W}px)">
    <div class="g-head"><div class="g-corner">Task</div><div class="g-scale" style="width:${W}px">${sprints}${dayCells}</div></div>
    <div style="position:relative">
      <div style="position:absolute;top:0;bottom:0;left:var(--lw);width:${W}px">${bg}</div>
      ${rows.map((t) => {
        const s = t.start_date, e = endOf(t) < s ? s : endOf(t);
        const col = t.category_color || '#0C0C0D';
        const dark = ['#7BFDFD', '#FCED67', '#7CFE86'].includes((col || '').toUpperCase());
        return `<div class="g-row">
          <div class="g-label" data-open="${t.id}">${t.category_color ? `<span class="dot" style="background:${t.category_color}"></span>` : ''}<span>${esc(t.name)}</span></div>
          <div class="g-track" style="width:${W}px">
            <div class="g-bar ${t.deadline ? '' : 'nodeadline'} ${t.status === 'done' ? 'done' : ''} ${isOverdue(t) ? 'overdue' : ''}"
                 data-id="${t.id}" style="left:${x(s)}px;width:${(dayDiff(s, e) + 1) * dw}px;background:${col};${dark ? 'color:#0C0C0D' : ''}"
                 title="${esc(t.name)}">
              <span class="g-handle l"></span>${dw >= 30 || dayDiff(s, e) > 3 ? esc(t.name) : ''}<span class="g-handle r"></span>
            </div>
          </div></div>`;
      }).join('')}
    </div></div></div>`;
  $('.gantt').style.setProperty('--lw', window.innerWidth <= 760 ? '140px' : '240px');

  // scroll so "today" is near the left edge
  $('.gantt').scrollLeft = Math.max(0, x(today()) - 3 * dw);

  main.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => openDrawer(state.tasks.find((t) => t.id === +el.dataset.open))));
  main.querySelectorAll('.g-bar').forEach((bar) => wireBar(bar, dw));
}

function wireBar(bar, dw) {
  bar.addEventListener('pointerdown', (e) => {
    const t = state.tasks.find((k) => k.id === +bar.dataset.id);
    const mode = e.target.classList.contains('l') ? 'start' : e.target.classList.contains('r') ? 'end' : 'move';
    const x0 = e.clientX, left0 = bar.offsetLeft, w0 = bar.offsetWidth;
    let shift = 0, moved = false;
    const tip = document.createElement('div'); tip.className = 'g-tip';
    bar.setPointerCapture(e.pointerId);

    const endDate = t.deadline ? ymd(new Date(t.deadline)) : t.start_date;
    const limits = { start: dayDiff(t.start_date, endDate), end: -dayDiff(t.start_date, endDate) };

    const onMove = (ev) => {
      const dx = ev.clientX - x0;
      if (Math.abs(dx) > 4) moved = true;
      if (!moved) return;
      shift = Math.round(dx / dw);
      if (mode === 'start') shift = Math.min(shift, limits.start);
      if (mode === 'end') shift = Math.max(shift, limits.end);
      bar.classList.add('dragging');
      if (mode === 'move') bar.style.left = `${left0 + shift * dw}px`;
      if (mode === 'start') { bar.style.left = `${left0 + shift * dw}px`; bar.style.width = `${w0 - shift * dw}px`; }
      if (mode === 'end') bar.style.width = `${w0 + shift * dw}px`;
      const s = mode === 'end' ? t.start_date : addDays(t.start_date, shift);
      const en = mode === 'start' ? endDate : addDays(endDate, shift);
      tip.textContent = `${fmtDate(s)} → ${fmtDate(en)}`;
      if (!tip.isConnected) document.body.append(tip);
      tip.style.left = ev.clientX + 12 + 'px'; tip.style.top = ev.clientY - 30 + 'px';
    };
    const onUp = () => {
      bar.removeEventListener('pointermove', onMove);
      bar.removeEventListener('pointerup', onUp);
      tip.remove();
      if (!moved) return openDrawer(t);
      if (!shift) return render();
      const patch = {};
      if (mode !== 'end') patch.start_date = addDays(t.start_date, shift);
      if (mode !== 'start') {
        patch.deadline = t.deadline ? shiftIso(t.deadline, shift)
          : new Date(`${addDays(t.start_date, shift)}T17:00`).toISOString(); // no deadline yet → 5pm
      }
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
  f.start_date.value = t.start_date || today();
  f.deadline.value = toLocalInput(t.deadline);
  fillSprintSelects(t.sprint_year || draft.sprint_year || cur.year, t.sprint_number || draft.sprint_number || cur.number);
  f.notes.value = t.notes || '';
  $('#deleteBtn').hidden = !task;
  $('#meta').innerHTML = task ? `
    <dt>Created</dt><dd>${fmtStamp(task.created_at)}</dd>
    <dt>Last updated</dt><dd>${fmtStamp(task.updated_at)}</dd>
    <dt>Sprint moved</dt><dd>${task.sprint_update_count} time${task.sprint_update_count === 1 ? '' : 's'}</dd>
    <dt>Calendar</dt><dd>${task.calendar_event_id ? 'Time blocked' : '—'}</dd>` : '';
  $('#meta').hidden = !task;
  // New task: picking a deadline moves the sprint to match it
  f.deadline.oninput = () => {
    if (state.editing || !f.deadline.value) return;
    const s = Sprint.sprintFor(new Date(f.deadline.value));
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
    start_date: f.start_date.value || today(),
    deadline: f.deadline.value ? new Date(f.deadline.value).toISOString() : null,
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
  $('#zoom').addEventListener('change', (e) => { state.zoom = +e.target.value; savePref('zoom', state.zoom); render(); });
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
    else state.groupBy = 'deadline';
    if (state.view === 'gantt') state.view = 'list';
    renderChrome(); render();
  });

  $('#statusSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setStatus(b.dataset.v); });
  $('#taskForm').addEventListener('submit', saveDrawer);
  $('#closeDrawer').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
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

wire();
load().catch((e) => { $('#view').innerHTML = `<div class="empty"><h3>Couldn't load tasks</h3><div>${esc(e.message)}</div></div>`; });
