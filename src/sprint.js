// Sprint calendar: 2-week sprints, Monday to Friday-week-after, anchored on Monday 14 Sep 2026
// (planning that Monday; review + retro on Friday 25 Sep). Every sprint starts on a Monday and
// runs 14 days; working days are Mon–Fri of both weeks, and the weekend after the second Friday
// still belongs to the sprint that just ended.
//
// Numbering: a sprint belongs to the year it STARTS in. S01 is the first sprint starting on or
// after 1 January (2026: S01 = Mon 5 Jan, S19 = Mon 14 Sep, S21 = Mon 12 Oct). Most years have
// 26 sprints, a few have 27.
//
// The same maths exists in SQL (db/schema.sql: sprint_key / sprint_index / sprint_add).

const DAY_MS = 24 * 60 * 60 * 1000;
const SPRINT_MS = 14 * DAY_MS;
const ANCHOR = Date.UTC(2026, 8, 14);          // Mon 14 Sep 2026
const iso = (t) => new Date(t).toISOString().slice(0, 10);

// Convert any moment to its London calendar date (so 00:30 BST counts as the new day).
function londonMidnight(date) {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(date);
  return Date.parse(`${ymd}T00:00:00Z`);
}
const toDayMs = (date) => (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
  ? Date.parse(`${date}T00:00:00Z`)                                   // plain date: use as-is
  : londonMidnight(date instanceof Date ? date : new Date(date)));

// Sprint "index": 0 = the sprint starting 14 Sep 2026, -1 the one before, 1 the one after…
const indexOfDay = (t) => Math.floor((t - ANCHOR) / SPRINT_MS);
const startOfIndex = (i) => ANCHOR + i * SPRINT_MS;
const firstIndexOfYear = (y) => Math.ceil((Date.UTC(y, 0, 1) - ANCHOR) / SPRINT_MS);
const sprintsInYear = (y) => firstIndexOfYear(y + 1) - firstIndexOfYear(y);

function fromIndex(i) {
  const year = new Date(startOfIndex(i)).getUTCFullYear();
  return { year, number: i - firstIndexOfYear(year) + 1 };
}
const indexOf = (year, number) => firstIndexOfYear(year) + number - 1;

// Which sprint does a date fall in?
const sprintFor = (date = new Date()) => fromIndex(indexOfDay(toDayMs(date)));

// Dates of a sprint: start = Monday, end = second Friday (last working day)
function sprintRange(year, number) {
  const s = startOfIndex(indexOf(year, number));
  return { year, number, start: iso(s), end: iso(s + 11 * DAY_MS), label: `${year}-S${String(number).padStart(2, '0')}` };
}

// Working days (Mon–Fri): planning on the first, review + retro on the last
function workingDays(year, number) {
  const s = startOfIndex(indexOf(year, number)), out = [];
  for (let d = 0; d < 14; d++) {
    const t = s + d * DAY_MS, dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(iso(t));
  }
  return out;
}

// Sprint "keys": one comparable number per sprint, year*100 + sprint (2026-S22 = 202622)
const key = (year, number) => year * 100 + number;
const fromKey = (k) => ({ year: Math.floor(k / 100), number: k % 100 });
const keyLabel = (k) => (k ? sprintRange(Math.floor(k / 100), k % 100).label : null);
const currentKey = () => { const s = sprintFor(new Date()); return key(s.year, s.number); };
function addSprints(k, n) {                     // move n sprints forward/back across year boundaries
  const s = fromIndex(indexOf(Math.floor(k / 100), k % 100) + n);
  return key(s.year, s.number);
}
// Accepts 202622, "2026-S22", "S22" or 22 (current year)
function parseSprint(v) {
  if (v === null || v === undefined || v === '') return null;
  let year, number;
  if (typeof v === 'number' && v > 1000) { year = Math.floor(v / 100); number = v % 100; }
  else if (typeof v === 'number') { year = sprintFor(new Date()).year; number = v; }
  else {
    const m = /^(?:(\d{4})\s*-?\s*)?S?\s*(\d{1,2})$/i.exec(String(v).trim());
    if (!m) { const n = Number(v); if (Number.isInteger(n)) return parseSprint(n); throw new Error(`Not a sprint: ${v}`); }
    year = m[1] ? Number(m[1]) : sprintFor(new Date()).year; number = Number(m[2]);
  }
  if (number < 1 || number > sprintsInYear(year)) throw new Error(`${year} has sprints 1-${sprintsInYear(year)}`);
  return key(year, number);
}

// Works in Node (server) and the browser (served at /sprint.js) — one source of truth.
const Sprint = { sprintFor, sprintRange, workingDays, sprintsInYear, key, fromKey, keyLabel, currentKey, addSprints, parseSprint };
if (typeof module !== 'undefined') module.exports = Sprint;
else window.Sprint = Sprint;
