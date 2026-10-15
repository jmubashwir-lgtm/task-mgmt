// Gregorian 2-week sprints.
// Sprint 1 = 1-14 Jan, Sprint 2 = 15-28 Jan, ... Sprint 26 = 17 Dec - 31 Dec.
// 365 days / 14 = 26 sprints + 1 day (2 in a leap year); those leftover
// days are folded into Sprint 26 so a sprint never crosses into a new year.

const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_SPRINT = 26;

// Day of year, 1-based, using the date's calendar day (UTC to avoid DST drift).
function dayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor((today - start) / DAY_MS) + 1;
}

// Convert any moment to its London calendar date (so 00:30 BST counts as the new day).
function londonDate(date) {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(date); // YYYY-MM-DD
  return new Date(`${ymd}T00:00:00Z`);
}

// Which sprint does a date fall in?
function sprintFor(date = new Date()) {
  const d = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? new Date(`${date}T00:00:00Z`)           // plain date: use as-is
    : londonDate(date instanceof Date ? date : new Date(date));
  const n = Math.min(Math.floor((dayOfYear(d) - 1) / 14) + 1, LAST_SPRINT);
  return { year: d.getUTCFullYear(), number: n };
}

// Start and end dates of a given sprint (YYYY-MM-DD strings).
function sprintRange(year, number) {
  const start = new Date(Date.UTC(year, 0, 1 + (number - 1) * 14));
  const end = number === LAST_SPRINT
    ? new Date(Date.UTC(year, 11, 31))
    : new Date(start.getTime() + 13 * DAY_MS);
  const iso = (x) => x.toISOString().slice(0, 10);
  return { year, number, start: iso(start), end: iso(end), label: `${year}-S${String(number).padStart(2, '0')}` };
}

// Scrum ceremonies fall on working days: planning on the sprint's first weekday,
// review + retrospective on its last weekday (sprints can start/end on weekends).
function workingDays(year, number) {
  const r = sprintRange(year, number), out = [];
  for (let t = Date.parse(`${r.start}T00:00:00Z`); t <= Date.parse(`${r.end}T00:00:00Z`); t += DAY_MS) {
    const d = new Date(t), dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Works in Node (server) and the browser (served at /sprint.js) — one source of truth.
const Sprint = { sprintFor, sprintRange, workingDays, LAST_SPRINT };
if (typeof module !== 'undefined') module.exports = Sprint;
else window.Sprint = Sprint;
