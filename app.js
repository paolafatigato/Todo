// ============================================================
// app.js — Todo List
//
// Views:
//   homepage     → list of lists, each showing 2 nearest tasks
//   list-view    → tasks inside one list
//   timeline-view → ALL tasks across ALL lists, sorted by period
//
// New Firestore fields on tasks:
//   deadline          : string|null   "YYYY-MM-DD"
//   plannedPeriod     : string|null   one of PERIODS keys
//   plannedPeriodUntil: number|null   ms timestamp when period expires
//   overdue           : boolean       auto-advanced past its period
// ============================================================

const db = firebase.firestore();


// ============================================================
// PERIODS
// ============================================================

// Read a CSS variable from :root, fall back to a provided value
function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v || '').trim() || fallback;
  } catch (e) {
    return fallback;
  }
}
const PERIODS = [
  { key: 'oggi',                     label: 'Oggi',                      color: cssVar('--c15', '#CE2D4F'), getEnd: () => endOfDay(new Date()),                                                      getStart: () => startOfDayMs(new Date()) },
  { key: 'domani',                   label: 'Domani',                    color: cssVar('--c12', '#F36B7E'), getEnd: () => endOfDay(addDays(new Date(), 1)),                                          getStart: () => startOfDayMs(addDays(new Date(), 1)) },
  { key: 'questa_settimana',         label: 'Questa settimana',          color: cssVar('--c11', '#FF98A9'), getEnd: () => endOfWeek(new Date()),                                                     getStart: () => startOfWeekMs(new Date()) },
  { key: 'prossima_settimana',       label: 'Prossima settimana',        color: cssVar('--c9', '#DB5ABA'), getEnd: () => endOfWeek(addDays(endOfWeekDate(new Date()), 1)),                          getStart: () => startOfWeekMs(addDays(endOfWeekDate(new Date()), 1)) },
  { key: 'questo_mese',              label: 'Questo mese',               color: cssVar('--c6', '#B285EC'), getEnd: () => endOfMonth(new Date()),                                                    getStart: () => startOfMonthMs(new Date()) },
  { key: 'prossimo_mese',            label: 'Prossimo mese',             color: cssVar('--c5', '#3548C0'), getEnd: () => endOfMonth(addMonths(new Date(), 1)),                                      getStart: () => startOfMonthMs(addMonths(new Date(), 1)) },
  { key: 'prossima_stagione',        label: 'Prossima stagione',         color: cssVar('--c4', '#6F8FE3'), getEnd: () => endOfNextSeason(new Date()),                                               getStart: () => startOfNextSeasonMs(new Date()) },
  { key: 'prossimo_anno_scolastico', label: 'Prossimo anno scolastico',  color: cssVar('--c3', '#A1BEF8'), getEnd: () => endOfSchoolYear(new Date()),                                               getStart: () => startOfSchoolYearMs(new Date()) },
  { key: 'prossimi_5_anni',          label: 'Prossimi 5 anni',           color: cssVar('--c2', '#5C946E'), getEnd: () => endOfDay(addYears(new Date(), 5)),                                         getStart: () => startOfDayMs(new Date()) },
  { key: 'prossima_vita',            label: 'Prossima vita',             color: cssVar('--c1', '#FFF088'), getEnd: () => null,                                                                      getStart: () => null },
];

// ─── DAILY RECURRING PERIOD ───────────────────────────────────
// Kept outside the PERIODS array so it never participates in
// the auto-advance chain (getEnd → null means plannedPeriodUntil
// stays null and the advance guard short-circuits).
const DAILY_PERIOD = {
  key:      'ogni_giorno',
  label:    'Ogni giorno',
  color:    '#FF0022',          // used as gradient fallback in JS; actual display via CSS class
  getEnd:   () => null,
  getStart: () => startOfDayMs(new Date()),
};

// ─── RECURRING TASK HELPERS ───────────────────────────────────

const DAY_NAMES_SHORT  = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
const MONTHS_IT_SHORT  = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
const MONTHS_IT_FULL   = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
                           'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];

/**
 * Fixed badge color per recurrence type — never changes regardless of period slot.
 * weekly  → c11 (rosa chiaro)
 * monthly → c6  (indaco)
 * yearly  → c3  (azzurro)
 * daily / custom → c15 (rosso)
 */
function getRecurrenceColor(type) {
  switch (type) {
    case 'weekly':  return cssVar('--c11', '#FF98A9');
    case 'monthly': return cssVar('--c6',  '#7C6ED8');
    case 'yearly':  return cssVar('--c3',  '#A1BEF8');
    default:        return cssVar('--c15', '#FF0022'); // daily / custom
  }
}

function isRecurringTask(task) {
  return !!(task.recurrence && task.recurrence.type);
}

/**
 * For "weekly" type, rec.days = INCLUDED weekdays (0=Sun…6=Sat).
 * Empty array means ALL 7 days.
 * Returns true if `dayOfWeek` is a scheduled day.
 */
function isScheduledWeeklyDay(rec, dayOfWeek) {
  if (!rec.days || rec.days.length === 0) return true; // all days
  return rec.days.includes(dayOfWeek);
}

/**
 * For "weekly" recurrence: the period slot depends on what day TODAY is.
 *  - Sunday (0)  → 'oggi'
 *  - Saturday (6) → 'domani'
 *  - Mon–Fri     → 'questa_settimana'
 * If today is NOT a scheduled day, look ahead to the next scheduled day
 * and return the appropriate slot for that day.
 */
function getWeeklyPeriodKey(rec) {
  const today = new Date(); today.setHours(0,0,0,0);
  // Find next scheduled day (starting today)
  for (let i = 0; i < 7; i++) {
    const d = new Date(today); d.setDate(today.getDate() + i);
    const dow = d.getDay();
    if (isScheduledWeeklyDay(rec, dow)) {
      if (i === 0) {
        // Today is scheduled: slot depends on day of week
        if (dow === 0) return 'oggi';         // Sunday
        if (dow === 6) return 'domani';       // Saturday
        return 'questa_settimana';            // Mon–Fri
      }
      // Next occurrence is i days ahead
      if (i === 1) return 'domani';
      if (i <= 7)  return 'questa_settimana';
      return 'prossima_settimana';
    }
  }
  return 'questa_settimana';
}

/**
 * Date of the NEXT occurrence of this recurrence, on or after `fromDate` (midnight local).
 */
function getNextOccurrenceDate(rec, fromDate) {
  if (!rec || !rec.type) return null;
  const d = new Date(fromDate); d.setHours(0, 0, 0, 0);

  switch (rec.type) {
    case 'daily':
      return new Date(d);

    case 'weekly': {
      for (let i = 0; i < 7; i++) {
        const c = new Date(d); c.setDate(d.getDate() + i);
        if (isScheduledWeeklyDay(rec, c.getDay())) return c;
      }
      return null;
    }

    case 'custom': {
      const days = rec.days && rec.days.length > 0 ? rec.days : [0,1,2,3,4,5,6];
      for (let i = 0; i < 7; i++) {
        const c = new Date(d); c.setDate(d.getDate() + i);
        if (days.includes(c.getDay())) return c;
      }
      return null;
    }

    case 'monthly': {
      const dom = rec.monthDay || d.getDate();
      let c = new Date(d.getFullYear(), d.getMonth(), dom);
      if (c.getMonth() !== d.getMonth()) c = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      if (c >= d) return c;
      let nm = d.getMonth() + 1, ny = d.getFullYear();
      if (nm > 11) { nm = 0; ny++; }
      c = new Date(ny, nm, dom);
      if (c.getMonth() !== nm) c = new Date(ny, nm + 1, 0);
      return c;
    }

    case 'yearly': {
      const month = rec.yearMonth !== undefined ? rec.yearMonth : d.getMonth();
      const day   = rec.yearDay   !== undefined ? rec.yearDay   : d.getDate();
      let c = new Date(d.getFullYear(), month, day);
      if (c.getDate() !== day) c = new Date(d.getFullYear(), month + 1, 0);
      if (c >= d) return c;
      c = new Date(d.getFullYear() + 1, month, day);
      if (c.getDate() !== day) c = new Date(d.getFullYear() + 1, month + 1, 0);
      return c;
    }
  }
  return null;
}

/** Map "N days until next occurrence" to the matching PERIODS key. */
function periodKeyForDaysAhead(diffDays) {
  if (diffDays <= 0) return 'oggi';
  if (diffDays === 1) return 'domani';
  if (diffDays <= 7) return 'questa_settimana';
  if (diffDays <= 14) return 'prossima_settimana';
  if (diffDays <= 31) return 'questo_mese';
  if (diffDays <= 60) return 'prossimo_mese';
  if (diffDays <= 120) return 'prossima_stagione';
  if (diffDays <= 400) return 'prossimo_anno_scolastico';
  return 'prossimi_5_anni';
}

/**
 * Dynamically compute the PERIODS key for a recurring task based on today.
 * Weekly has special day-of-week slot logic.
 */
function getRecurrencePeriodKey(rec) {
  if (!rec || !rec.type) return null;
  // Weekly: fixed slot logic (Sun→oggi, Sat→domani, Mon-Fri→questa_settimana)
  if (rec.type === 'weekly') return getWeeklyPeriodKey(rec);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const next  = getNextOccurrenceDate(rec, today);
  if (!next) return null;
  const diffDays = Math.round((next.getTime() - today.getTime()) / 86400000);
  return periodKeyForDaysAhead(diffDays);
}

/**
 * ISO date of the START of the current recurrence "window".
 */
function getRecurrencePeriodStart(type) {
  const now = new Date();
  if (type === 'daily' || type === 'custom') {
    return toIso(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }
  if (type === 'weekly') {
    // Each scheduled day is a fresh occurrence → use today
    return toIso(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }
  if (type === 'monthly') {
    return toIso(now.getFullYear(), now.getMonth() + 1, 1);
  }
  if (type === 'yearly') {
    return toIso(now.getFullYear(), 1, 1);
  }
  return null;
}

/**
 * Whether the recurring task has already been completed during its current period.
 */
function isRecurringCompletedForPeriod(task) {
  if (!task.completed || !task.lastCompletedDate) return false;
  const rec = task.recurrence;
  // Weekly and custom: per-day completion
  if (rec.type === 'weekly' || rec.type === 'custom') {
    const today = new Date();
    const todayIso = toIso(today.getFullYear(), today.getMonth() + 1, today.getDate());
    // If today is not a scheduled day, consider it "not applicable" (show as hidden/done)
    if (rec.type === 'weekly' && !isScheduledWeeklyDay(rec, today.getDay())) return true;
    if (rec.type === 'custom') {
      const days = rec.days && rec.days.length > 0 ? rec.days : [0,1,2,3,4,5,6];
      if (!days.includes(today.getDay())) return true;
    }
    return task.lastCompletedDate === todayIso;
  }
  const periodStart = getRecurrencePeriodStart(rec.type);
  if (!periodStart) return task.completed;
  return task.lastCompletedDate >= periodStart;
}

/**
 * Human-readable label for a recurrence config.
 */
function getRecurrenceLabel(rec) {
  if (!rec || !rec.type) return '';
  const days = (rec.days && rec.days.length > 0) ? [...rec.days].sort((a,b)=>a-b) : [];
  if (rec.type === 'daily')  return 'Ogni giorno';
  if (rec.type === 'custom') {
    if (days.length === 0 || days.length === 7) return 'Ogni giorno';
    if (days.length === 5 && !days.includes(0) && !days.includes(6)) return 'Giorni feriali';
    if (days.length === 2 && days.includes(0) && days.includes(6)) return 'Fine settimana';
    return days.map(d => DAY_NAMES_SHORT[d]).join(', ');
  }
  if (rec.type === 'weekly') {
    // days = INCLUDED days. Show which are excluded if not all 7.
    if (days.length === 0 || days.length === 7) return 'Ogni settimana';
    const excluded = [0,1,2,3,4,5,6].filter(d => !days.includes(d));
    if (excluded.length === 0) return 'Ogni settimana';
    if (excluded.length === 2 && excluded.includes(0) && excluded.includes(6)) return 'Giorni feriali';
    return 'Ogni giorno tranne ' + excluded.map(d => DAY_NAMES_SHORT[d]).join(', ');
  }
  if (rec.type === 'monthly') {
    return rec.monthDay ? `Il ${rec.monthDay} di ogni mese` : 'Ogni mese';
  }
  if (rec.type === 'yearly') {
    if (rec.yearMonth !== undefined && rec.yearDay) {
      return `Ogni ${rec.yearDay} ${MONTHS_IT_SHORT[rec.yearMonth]}`;
    }
    return 'Ogni anno';
  }
  return '';
}

// ─── LIST COLOR PALETTE ────────────────────────────────────────
const LIST_COLORS = [
  { key: 'c1',  hex: '#FFF088', label: 'Giallo' },
  { key: 'c2',  hex: '#5C946E', label: 'Verde' },
  { key: 'c3',  hex: '#A1BEF8', label: 'Azzurro' },
  { key: 'c4',  hex: '#6F8FE3', label: 'Blu chiaro' },
  { key: 'c5',  hex: '#3548C0', label: 'Blu' },
  { key: 'c6',  hex: '#7C6ED8', label: 'Indaco' },
  { key: 'c7',  hex: '#B285EC', label: 'Lilla' },
  { key: 'c8',  hex: '#C873D4', label: 'Orchidea' },
  { key: 'c9',  hex: '#DB5ABA', label: 'Rosa scuro' },
  { key: 'c10', hex: '#E96FAF', label: 'Rosa' },
  { key: 'c11', hex: '#FF98A9', label: 'Rosa chiaro' },
  { key: 'c12', hex: '#F36B7E', label: 'Salmone' },
  { key: 'c15', hex: '#FF0022', label: 'Rosso' },
];

function getListColorHex(list) {
  if (!list || !list.color) return null;
  const found = LIST_COLORS.find(c => c.key === list.color);
  return found ? found.hex : null;
}

const getPeriod = key => {
  if (key === 'ogni_giorno') return DAILY_PERIOD;
  return PERIODS.find(p => p.key === key) || null;
};

const nextPeriodKey = key => {
  const idx = PERIODS.findIndex(p => p.key === key);
  return (idx >= 0 && idx < PERIODS.length - 1) ? PERIODS[idx + 1].key : null;
};

/**
 * Numeric sort key for a task's planned period.
 * No period → sorted to the very end (9999).
 */
function periodSortKey(task) {
  if (!task.plannedPeriod) return 9999;
  if (task.plannedPeriod === 'ogni_giorno') return 0; // appears with 'oggi' in sorted order
  const idx = PERIODS.findIndex(p => p.key === task.plannedPeriod);
  return idx >= 0 ? idx : 9999;
}

/**
 * Numeric sort key for a task's deadline.
 * No deadline → sorted to end (far future).
 */
function deadlineSortKey(task) {
  if (!task.deadline) return 99999999999999;
  const [y, m, d] = task.deadline.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/**
 * Sort an array of tasks by: period index → overdue status → deadline → name.
 * At the same period, tasks with overdue: true come before others.
 * Returns a NEW sorted array (does not mutate).
 */
function sortTasksBySchedule(tasks) {
  return [...tasks].sort((a, b) => {
    const pa = periodSortKey(a), pb = periodSortKey(b);
    if (pa !== pb) return pa - pb;
    // At same period, overdue tasks come first
    const oa = a.overdue ? 0 : 1, ob = b.overdue ? 0 : 1;
    if (oa !== ob) return oa - ob;
    const da = deadlineSortKey(a), db2 = deadlineSortKey(b);
    if (da !== db2) return da - db2;
    return (a.name || '').localeCompare(b.name || '');
  });
}

// ─── DAILY TASK HELPERS ───────────────────────────────────────

/**
 * A daily task is "completed for today" only when its
 * lastCompletedDate matches today's ISO string.
 * Regular tasks just use the boolean field as-is.
 */
function isDailyTaskEffectivelyCompleted(task) {
  // New recurrence system
  if (isRecurringTask(task)) return isRecurringCompletedForPeriod(task);
  // Legacy ogni_giorno
  if (task.plannedPeriod !== 'ogni_giorno') return task.completed;
  const today = new Date();
  const todayIso = toIso(today.getFullYear(), today.getMonth() + 1, today.getDate());
  return !!task.completed && task.lastCompletedDate === todayIso;
}

/**
 * Build the Firestore update object for toggling a task's completion.
 * For daily tasks, also stamps / clears lastCompletedDate.
 */
function buildCompleteUpdate(task, newCompleted) {
  const data = { completed: newCompleted };
  if (newCompleted) {
    data.completedAt = firebase.firestore.FieldValue.serverTimestamp();
  } else {
    data.completedAt = null;
  }
  // All recurring tasks (new system) stamp lastCompletedDate
  if (isRecurringTask(task)) {
    if (newCompleted) {
      const today = new Date();
      data.lastCompletedDate = toIso(today.getFullYear(), today.getMonth() + 1, today.getDate());
    } else {
      data.lastCompletedDate = null;
    }
    return data;
  }
  // Legacy ogni_giorno
  if (task.plannedPeriod === 'ogni_giorno') {
    if (newCompleted) {
      const today = new Date();
      data.lastCompletedDate = toIso(today.getFullYear(), today.getMonth() + 1, today.getDate());
    } else {
      data.lastCompletedDate = null;
    }
  }
  return data;
}

/**
 * Return true if the task was completed today.
 * - daily tasks: use `lastCompletedDate` (effective completion for today)
 * - others: use `completedAt` timestamp (serverTimestamp)
 */
function isCompletedToday(task) {
  const today = new Date();
  const todayIso = toIso(today.getFullYear(), today.getMonth() + 1, today.getDate());

  if (task.plannedPeriod === 'ogni_giorno') return isDailyTaskEffectivelyCompleted(task);
  if (!task.completed) return false;
  if (!task.completedAt) return false;

  let d;
  if (typeof task.completedAt.toDate === 'function') d = task.completedAt.toDate();
  else d = new Date(task.completedAt);

  const iso = toIso(d.getFullYear(), d.getMonth() + 1, d.getDate());
  return iso === todayIso;
}


// ============================================================
// DATE HELPERS
// ============================================================

function endOfDay(date)  { const d = new Date(date); d.setHours(23,59,59,999); return d.getTime(); }
function addDays(date,n) { const d = new Date(date); d.setDate(d.getDate()+n); return d; }
function addMonths(date,n){ const d = new Date(date); d.setMonth(d.getMonth()+n); return d; }
function addYears(date,n) { const d = new Date(date); d.setFullYear(d.getFullYear()+n); return d; }

function endOfWeekDate(date) {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? 0 : 7 - day));
  return d;
}
function endOfWeek(date)  { return endOfDay(endOfWeekDate(date)); }
function endOfMonth(date) { return endOfDay(new Date(date.getFullYear(), date.getMonth()+1, 0)); }

function endOfNextSeason(date) {
  const m = date.getMonth();
  let cur = m <= 1 || m === 11 ? 0 : m <= 4 ? 1 : m <= 7 ? 2 : 3;
  const next = (cur + 1) % 4;
  const lastMonths = [1, 4, 7, 10];
  const endMonth = lastMonths[next];
  let endYear = date.getFullYear();
  if (endMonth < m) endYear++;
  return endOfDay(new Date(endYear, endMonth + 1, 0));
}

function endOfSchoolYear(date) {
  const y = date.getFullYear(), m = date.getMonth();
  let endYear = m >= 8 ? y + 1 : m <= 5 ? y : y + 1;
  return endOfDay(new Date(endYear, 5, 30));
}

function formatDeadline(isoStr) {
  if (!isoStr) return '';
  const [y, m, d] = isoStr.split('-').map(Number);
  const months = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
  const nowYear = new Date().getFullYear();
  return `${d} ${months[m-1]}${y !== nowYear ? ' '+y : ''}`;
}

function isDeadlinePast(isoStr) {
  if (!isoStr) return false;
  const [y,m,d] = isoStr.split('-').map(Number);
  return Date.now() > new Date(y,m-1,d,23,59,59,999).getTime();
}

/**
 * Get the override color for an overdue task based on how many days past deadline.
 * Returns a CSS variable like '--c1', '--c11', '--c12', '--c15' or null if not overdue.
 * - 0-1 days: --c1 (yellow)
 * - 1-2 days: --c11 (pink)
 * - 2-3 days: --c12 (darker pink)
 * - 3+ days: --c15 (red)
 */
function getOverdueColor(task) {
  if (!task.overdue || !task.plannedPeriodUntil) return null;
  
  const now = Date.now();
  const daysOverdue = (now - task.plannedPeriodUntil) / 86400000; // Convert ms to days
  
  if (daysOverdue < 1) return cssVar('--c1', '#FFF088');      // 0-1 days: yellow
  if (daysOverdue < 2) return cssVar('--c11', '#FF98A9');     // 1-2 days: light pink
  if (daysOverdue < 3) return cssVar('--c12', '#F36B7E');     // 2-3 days: darker pink
  return cssVar('--c15', '#FF0022');                          // 3+ days: red
}

// --- Start-of-period helpers (used by calendar) ---

function startOfDayMs(date) {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Monday of the week containing `date`, midnight */
function startOfWeekMs(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const daysToMon = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + daysToMon);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** First day of the month of `date`, midnight */
function startOfMonthMs(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

/** First day of the NEXT meteorological season */
function startOfNextSeasonMs(date) {
  const m = date.getMonth();
  let cur = m <= 1 || m === 11 ? 0 : m <= 4 ? 1 : m <= 7 ? 2 : 3;
  const next = (cur + 1) % 4;
  const firstMonths = [2, 5, 8, 11]; // Mar, Jun, Sep, Dec (0-indexed)
  const startMonth = firstMonths[next];
  let startYear = date.getFullYear();
  if (startMonth <= m) startYear++;
  return new Date(startYear, startMonth, 1).getTime();
}

/** September 1 of the current or next Italian school year */
function startOfSchoolYearMs(date) {
  const y = date.getFullYear(), m = date.getMonth();
  const startYear = m >= 8 ? y : y - 1; // Sep=8
  return new Date(startYear, 8, 1).getTime(); // Sep 1
}

/**
 * Given a task with a plannedPeriod, return [startMs, endMs] of that period
 * computed relative to TODAY. Returns null if no period or prossima_vita.
 */
function getTaskPeriodRange(task) {
  if (!task.plannedPeriod) return null;
  const p = getPeriod(task.plannedPeriod);
  if (!p) return null;
  const start = p.getStart();
  const end   = p.getEnd();
  if (start === null || end === null) return null;
  return [start, end];
}

/**
 * ISO date string "YYYY-MM-DD" for a given year/month/day (1-based month).
 */
function toIso(year, month, day) {
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

/**
 * True if the day represented by `isoStr` falls within [startMs, endMs].
 */
function dayInRange(isoStr, startMs, endMs) {
  const [y,m,d] = isoStr.split('-').map(Number);
  const dayStart = new Date(y, m-1, d).getTime();
  const dayEnd   = new Date(y, m-1, d, 23, 59, 59, 999).getTime();
  return dayStart <= endMs && dayEnd >= startMs;
}


// ============================================================
// AUTO-ADVANCE OVERDUE TASKS
// ============================================================

async function autoAdvanceOverdueTasks(listId) {
  const now = Date.now();
  const today = new Date();
  const todayIso = toIso(today.getFullYear(), today.getMonth() + 1, today.getDate());
  const batch = db.batch();
  let hasChanges = false;

  state.tasks.forEach(task => {
    // ── New recurrence system: reset when the period rolls over ───
    if (isRecurringTask(task)) {
      const rec = task.recurrence;
      if (task.completed) {
        const periodStart = getRecurrencePeriodStart(rec.type);
        const shouldReset = !task.lastCompletedDate || task.lastCompletedDate < periodStart;
        // For custom (specific weekdays): also reset if today is a new scheduled day
        const customShouldReset = rec.type === 'custom' && !isRecurringCompletedForPeriod(task);
        if (shouldReset || customShouldReset) {
          const correctPeriodKey = getRecurrencePeriodKey(rec);
          const correctPeriod = correctPeriodKey ? getPeriod(correctPeriodKey) : null;
          const reset = {
            completed: false, lastCompletedDate: null, overdue: false,
            plannedPeriod: correctPeriodKey || task.plannedPeriod,
            plannedPeriodUntil: correctPeriod ? correctPeriod.getEnd() : task.plannedPeriodUntil,
          };
          batch.update(tasksRef(listId).doc(task.id), reset);
          Object.assign(task, reset);
          hasChanges = true;
        }
      } else {
        // Not completed — dynamically update plannedPeriod based on next occurrence
        const correctPeriodKey = getRecurrencePeriodKey(rec);
        const correctPeriod = correctPeriodKey ? getPeriod(correctPeriodKey) : null;
        if (correctPeriodKey && task.plannedPeriod !== correctPeriodKey) {
          const update = {
            plannedPeriod: correctPeriodKey,
            plannedPeriodUntil: correctPeriod ? correctPeriod.getEnd() : null,
            overdue: false,
          };
          batch.update(tasksRef(listId).doc(task.id), update);
          Object.assign(task, update);
          hasChanges = true;
        }
      }
      return; // skip regular auto-advance logic for recurring tasks
    }

    // ── Daily recurring: reset if completed on a previous day ──────
    if (task.plannedPeriod === 'ogni_giorno' && task.completed) {
      if (task.lastCompletedDate !== todayIso) {
        const reset = { completed: false, lastCompletedDate: null };
        batch.update(tasksRef(listId).doc(task.id), reset);
        Object.assign(task, reset);
        hasChanges = true;
      }
      return;
    }

    // ── Auto-advance toward present (never forward) ─────────────────
    // Skip tasks without a period, daily tasks, completed tasks, or
    // tasks without a known expiry timestamp.
    if (!task.plannedPeriod || task.plannedPeriod === 'ogni_giorno' || task.completed || !task.plannedPeriodUntil) return;

    const currentIdx = PERIODS.findIndex(p => p.key === task.plannedPeriod);
    if (currentIdx <= 0) return; // already at 'oggi' or unknown period

    const daysLeft = (task.plannedPeriodUntil - now) / 86400000; // fractional days

    // Determine the *most specific* (closest-to-now) period that the
    // remaining time still "fits inside" — i.e., whose end is >= now+daysLeft.
    // We advance only if that period is strictly closer than the current one.
    let targetPeriod = null;

    if (daysLeft <= 0) {
      // Expired → oggi
      targetPeriod = PERIODS[0]; // 'oggi'
    } else if (daysLeft <= 1 && currentIdx > 1) {
      // Less than 1 day left → domani
      targetPeriod = PERIODS[1]; // 'domani'
    } else if (daysLeft <= 2 && currentIdx > 1) {
      // ≤ 2 days left and not already domani/oggi → domani
      targetPeriod = PERIODS[1];
    } else if (daysLeft <= 7 && currentIdx > 2) {
      // ≤ 7 days left and not already questa_settimana or closer → questa_settimana
      targetPeriod = PERIODS[2]; // 'questa_settimana'
    }

    if (!targetPeriod) return;

    const update = {
      plannedPeriod:      targetPeriod.key,
      plannedPeriodUntil: targetPeriod.getEnd(),
      overdue: true,
    };
    batch.update(tasksRef(listId).doc(task.id), update);
    Object.assign(task, update);
    hasChanges = true;
  });

  if (hasChanges) { await batch.commit(); renderTaskList(); }
}


// ============================================================
// STATE
// ============================================================
const state = {
  lists: [],
  activeListId: null,
  tasks: [],
  activeTaskId: null,
  unsubscribeTasks: null,
  pendingTaskId: null,       // task to open after a list finishes loading
};

let currentUserUid    = null;
let unsubscribeLists  = null;
let quickRecurrence   = null; // recurrence set via the quick-add popover

// Calendar state — persists across month navigation
const calState = {
  year: new Date().getFullYear(),
  month: new Date().getMonth(), // 0-indexed
  selectedIso: null,            // "YYYY-MM-DD"
  allTasks: [],                 // flat cache of tasks with .listId
};


// ============================================================
// DOM REFERENCES
// ============================================================
const el = {
  listsNav:             document.getElementById('lists-nav'),
  btnNewList:           document.getElementById('btn-new-list'),
  btnHome:              document.getElementById('btn-home'),
  btnTimeline:          document.getElementById('btn-timeline'),
  btnCalendar:          document.getElementById('btn-calendar'),
  loading:              document.getElementById('loading'),
  homepage:             document.getElementById('homepage'),
  listView:             document.getElementById('list-view'),
  timelineView:         document.getElementById('timeline-view'),
  calendarView:         document.getElementById('calendar-view'),
  calendarGrid:         document.getElementById('calendar-grid'),
  calMonthLabel:        document.getElementById('cal-month-label'),
  calBtnPrev:           document.getElementById('cal-btn-prev'),
  calBtnNext:           document.getElementById('cal-btn-next'),
  calBtnToday:          document.getElementById('cal-btn-today'),
  calDayPanel:          document.getElementById('cal-day-panel'),
  calDayPanelTitle:     document.getElementById('cal-day-panel-title'),
  calDayPanelContent:   document.getElementById('cal-day-panel-content'),
  timelineContent:      document.getElementById('timeline-content'),
  toggleShowCompleted:  document.getElementById('toggle-show-completed'),
  homeCards:            document.getElementById('home-cards'),
  btnNewListHome:       document.getElementById('btn-new-list-home'),
  listTitleInput:       document.getElementById('list-title-input'),
  listSortSelect:       document.getElementById('list-sort-select'),
  btnStar:              document.getElementById('btn-star'),
  btnDeleteList:        document.getElementById('btn-delete-list'),
  taskInput:            document.getElementById('task-input'),
  btnAddTask:           document.getElementById('btn-add-task'),
  taskPeriodQuick:      document.getElementById('task-period-quick'),
  taskDeadlineQuick:    document.getElementById('task-deadline-quick'),
  btnClearDeadlineQuick:document.getElementById('btn-clear-deadline-quick'),
  taskList:             document.getElementById('task-list'),
  detailPanel:          document.getElementById('detail-panel'),
  detailTitle:          document.getElementById('detail-task-title'),
  detailNotes:          document.getElementById('detail-notes'),
  btnCloseDetail:       document.getElementById('btn-close-detail'),
  btnSaveDetail:        document.getElementById('btn-save-detail'),
  btnComplete:          document.getElementById('btn-complete-task'),
  btnDeleteTask:        document.getElementById('btn-delete-task'),
  overlay:              document.getElementById('overlay'),
  modalBackdrop:        document.getElementById('modal-backdrop'),
  modalListName:        document.getElementById('modal-list-name'),
  btnModalCancel:       document.getElementById('btn-modal-cancel'),
  btnModalCreate:       document.getElementById('btn-modal-create'),
  btnLogin:             document.getElementById('btn-login'),
  btnLogout:            document.getElementById('btn-logout'),
  btnOverlayLogin:      document.getElementById('overlay-login'),
  btnLogoutMobile:      document.getElementById('btn-logout-mobile'),
  btnLoginMobile:       document.getElementById('btn-login-mobile'),
  authOverlay:          document.getElementById('auth-overlay'),
  detailDeadline:       document.getElementById('detail-deadline'),
  detailPeriod:         document.getElementById('detail-period'),
  detailDeadlineStatus: document.getElementById('detail-deadline-status'),
  detailOverdueBar:     document.getElementById('detail-overdue-bar'),
  btnClearDeadline:     document.getElementById('btn-clear-deadline'),
  // Progress / milestones
  detailProgressFill:   document.getElementById('detail-progress-fill'),
  detailProgressPct:    document.getElementById('detail-progress-pct'),
  detailMilestones:     document.getElementById('detail-milestones'),
  addMilestoneInput:    document.getElementById('add-milestone-input'),
  btnAddMilestone:      document.getElementById('btn-add-milestone'),
  btnApplyDefaultMs:    document.getElementById('btn-apply-default-ms'),
  // Timeline quick-add
  btnTimelineQuickAdd:  document.getElementById('btn-timeline-quick-add'),
  tlQuickAddBar:        document.getElementById('timeline-quick-add-bar'),
  tlTaskInput:          document.getElementById('tl-task-input'),
  tlTaskListSel:        document.getElementById('tl-task-list-sel'),
  tlTaskPeriodSel:      document.getElementById('tl-task-period-sel'),
  btnTlAdd:             document.getElementById('btn-tl-add'),
  btnTlCancel:          document.getElementById('btn-tl-cancel'),
  // Sidebar search
  sidebarSearch:        document.getElementById('sidebar-search'),
  homeSearch:           document.getElementById('home-search'),
  homeSearchWrap:       document.getElementById('home-search-wrap'),
  // List settings button
  btnListSettings:      document.getElementById('btn-list-settings'),
  // List settings modal
  listSettingsBackdrop: document.getElementById('list-settings-backdrop'),
  lsmName:              document.getElementById('lsm-name'),
  lsmColorSwatches:     document.getElementById('lsm-color-swatches'),
  lsmMilestonesList:    document.getElementById('lsm-milestones-list'),
  lsmMsInput:           document.getElementById('lsm-ms-input'),
  btnLsmAddMs:          document.getElementById('btn-lsm-add-ms'),
  btnLsmClose:          document.getElementById('btn-lsm-close'),
  btnLsmCancel:         document.getElementById('btn-lsm-cancel'),
  btnLsmSave:           document.getElementById('btn-lsm-save'),
};


// ============================================================
// FIREBASE HELPERS
// ============================================================

const listsRef = () => {
  if (!currentUserUid) throw new Error('No authenticated user');
  return db.collection('users').doc(currentUserUid).collection('lists');
};

const tasksRef = listId => {
  if (!currentUserUid) throw new Error('No authenticated user');
  return db.collection('users').doc(currentUserUid)
    .collection('lists').doc(listId).collection('tasks');
};

/**
 * One-time fetch of all tasks for a given list.
 * Returns array of { id, ...data }.
 */
async function fetchTasksForList(listId) {
  const snap = await tasksRef(listId).get();
  return snap.docs.map(d => ({ id: d.id, listId, ...d.data() }));
}

/**
 * Fetch tasks for ALL lists in parallel.
 * Returns a flat array of tasks, each with a .listId property.
 */
async function fetchAllTasks() {
  if (!state.lists.length) return [];
  const arrays = await Promise.all(state.lists.map(l => fetchTasksForList(l.id)));
  return arrays.flat();
}


// ============================================================
// AUTH
// ============================================================

async function loginWithGoogle() {
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await firebase.auth().signInWithPopup(provider);
  } catch (err) { alert(err.message || 'Login failed'); }
}

async function logoutUser() {
  try { await firebase.auth().signOut(); }
  catch (err) { console.error(err); }
}


// ============================================================
// LISTS — CRUD
// ============================================================

async function updateList(listId, data) { await listsRef().doc(listId).update(data); }

async function deleteList(listId) {
  const snapshot = await tasksRef(listId).get();
  const batch = db.batch();
  snapshot.forEach(d => batch.delete(d.ref));
  batch.delete(listsRef().doc(listId));
  await batch.commit();
}


// ============================================================
// TASKS — CRUD
// ============================================================

async function addTask(name, periodKey, deadline, recurrence) {
  if (!state.activeListId || !name.trim()) return;
  // If a recurrence is set, compute the period dynamically
  let finalPeriodKey = periodKey;
  if (recurrence && recurrence.type) {
    finalPeriodKey = getRecurrencePeriodKey(recurrence) || periodKey;
  }
  const p     = finalPeriodKey ? getPeriod(finalPeriodKey) : null;
  const until = p ? p.getEnd() : null;
  const list  = state.lists.find(l => l.id === state.activeListId);
  const defaultMs = (list && list.defaultMilestones)
    ? list.defaultMilestones.map(name => ({ id: Date.now().toString(36) + Math.random().toString(36).slice(2), name, done: false }))
    : [];
  await tasksRef(state.activeListId).add({
    name: name.trim(), completed: false, notes: '', order: state.tasks.length,
    deadline: deadline || null,
    plannedPeriod: finalPeriodKey || null,
    plannedPeriodUntil: until,
    overdue: false,
    recurrence: recurrence || null,
    milestones: defaultMs,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

async function updateTask(taskId, data) {
  await tasksRef(state.activeListId).doc(taskId).update(data);
}

async function updateTaskInList(listId, taskId, data) {
  await tasksRef(listId).doc(taskId).update(data);
}

async function deleteTask(taskId) { await tasksRef(state.activeListId).doc(taskId).delete(); }

let notesTimer;
function saveNotesDebounced(taskId, notes) {
  clearTimeout(notesTimer);
  notesTimer = setTimeout(() => updateTask(taskId, { notes }), 600);
}

// ============================================================
// MILESTONES / PROGRESS
// ============================================================

function computeProgress(milestones) {
  if (!milestones || milestones.length === 0) return null;
  return Math.round(milestones.filter(m => m.done).length / milestones.length * 100);
}

function renderMilestones(task, listColorHex) {
  if (!el.detailMilestones || !el.detailProgressFill) return;
  const milestones = task.milestones || [];
  const pct = computeProgress(milestones);

  // Update progress bar fill with list color gradient
  const fill = pct !== null ? pct : 0;
  el.detailProgressFill.style.width = fill + '%';
  el.detailProgressPct.textContent = pct !== null ? pct + '%' : '';
  if (listColorHex) {
    el.detailProgressFill.style.background = `linear-gradient(90deg, ${listColorHex} 0%, #FF98A9 100%)`;
  } else {
    el.detailProgressFill.style.background = '';
  }

  // Render milestone rows
  el.detailMilestones.innerHTML = '';
  milestones.forEach((m, idx) => {
    const row = document.createElement('div');
    row.className = 'milestone-row' + (m.done ? ' done' : '');
    row.innerHTML = `
      <span class="milestone-check ${m.done ? 'checked' : ''}" data-idx="${idx}"></span>
      <span class="milestone-name">${escapeHtml(m.name)}</span>
      <button class="milestone-delete" data-idx="${idx}" title="Rimuovi">✕</button>
    `;
    row.querySelector('.milestone-check').addEventListener('click', e => {
      e.stopPropagation();
      toggleMilestone(task, idx);
    });
    row.querySelector('.milestone-delete').addEventListener('click', e => {
      e.stopPropagation();
      deleteMilestone(task, idx);
    });
    el.detailMilestones.appendChild(row);
  });
}

async function addMilestone(task, name) {
  if (!name.trim()) return;
  const milestones = [...(task.milestones || []), {
    id: Date.now().toString(36), name: name.trim(), done: false
  }];
  await updateTask(task.id, { milestones });
  task.milestones = milestones;
  const list = state.lists.find(l => l.id === state.activeListId);
  renderMilestones(task, getListColorHex(list));
}

async function toggleMilestone(task, idx) {
  const milestones = (task.milestones || []).map((m, i) =>
    i === idx ? { ...m, done: !m.done } : m
  );
  await updateTask(task.id, { milestones });
  task.milestones = milestones;
  const list = state.lists.find(l => l.id === state.activeListId);
  renderMilestones(task, getListColorHex(list));
}

async function deleteMilestone(task, idx) {
  const milestones = (task.milestones || []).filter((_, i) => i !== idx);
  await updateTask(task.id, { milestones });
  task.milestones = milestones;
  const list = state.lists.find(l => l.id === state.activeListId);
  renderMilestones(task, getListColorHex(list));
}


// ============================================================
// REALTIME LISTENERS
// ============================================================

function listenLists() {
  if (!currentUserUid) return;
  if (unsubscribeLists) { unsubscribeLists(); unsubscribeLists = null; }
  unsubscribeLists = listsRef().orderBy('order').onSnapshot(snap => {
    state.lists = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderSidebar();

    // Also refresh whichever view is currently active
    if (!el.homepage.classList.contains('hidden'))      renderHomepage();
    if (!el.timelineView.classList.contains('hidden'))  renderTimeline();
    if (!el.calendarView.classList.contains('hidden'))  { refreshCalendarTasks().then(renderCalendar); }

    if (!el.loading.classList.contains('hidden')) {
      el.loading.classList.add('hidden');
      const starred = state.lists.find(l => l.starred);
      if (starred) openList(starred.id); else showTimeline();
    }
  });
}

function listenTasks(listId) {
  if (state.unsubscribeTasks) state.unsubscribeTasks();
  state.unsubscribeTasks = tasksRef(listId).orderBy('order').onSnapshot(async snap => {
    state.tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    await autoAdvanceOverdueTasks(listId);
    renderTaskList();

    // If a task was pending (navigated from timeline/homepage), open its panel
    if (state.pendingTaskId) {
      const t = state.tasks.find(t => t.id === state.pendingTaskId);
      if (t) openDetailPanel(t.id);
      state.pendingTaskId = null;
    }
  });
}


// ============================================================
// VIEW MANAGEMENT — helpers to show/hide the three main views
// ============================================================

/** Hide all main view sections */
function hideAllViews() {
  el.homepage.classList.add('hidden');
  el.listView.classList.add('hidden');
  el.timelineView.classList.add('hidden');
  el.calendarView.classList.add('hidden');
}

async function showCalendar() {
  hideAllViews();
  el.calendarView.classList.remove('hidden');
  state.activeListId = null;
  if (state.unsubscribeTasks) { state.unsubscribeTasks(); state.unsubscribeTasks = null; }
  closeDetailPanel();
  renderSidebar();
  await refreshCalendarTasks();
  renderCalendar();
}

function showHomepage() {
  hideAllViews();
  el.homepage.classList.remove('hidden');
  state.activeListId = null;
  if (state.unsubscribeTasks) { state.unsubscribeTasks(); state.unsubscribeTasks = null; }
  closeDetailPanel();
  renderSidebar();
  renderHomepage();
}

function showTimeline() {
  hideAllViews();
  el.timelineView.classList.remove('hidden');
  state.activeListId = null;
  if (state.unsubscribeTasks) { state.unsubscribeTasks(); state.unsubscribeTasks = null; }
  closeDetailPanel();
  renderSidebar();
  renderTimeline();
}

function openList(listId, pendingTaskId) {
  state.activeListId = listId;
  state.pendingTaskId = pendingTaskId || null;
  const list = state.lists.find(l => l.id === listId);
  if (!list) return showHomepage();

  hideAllViews();
  el.listView.classList.remove('hidden');
  el.listTitleInput.value = list.name;
  updateStarButton(list.starred);

  // Apply list accent color to the header border
  const colorHex = getListColorHex(list);
  const listHeader = document.getElementById('list-header');
  if (listHeader) {
    listHeader.style.borderBottomColor = colorHex || '';
    listHeader.style.setProperty('--list-accent', colorHex || 'var(--blue)');
  }
  el.listTitleInput.style.color = colorHex || '';

  if (!pendingTaskId) closeDetailPanel();
  listenTasks(listId);
  renderSidebar();
}

function updateStarButton(isStarred) {
  el.btnStar.textContent = isStarred ? '★' : '☆';
  el.btnStar.classList.toggle('starred', isStarred);
}


// ============================================================
// RENDER — SIDEBAR
// ============================================================

function renderSidebar() {
  // On mobile the search is in homepage; on desktop it's in the sidebar
  const query = (el.sidebarSearch?.value || el.homeSearch?.value || '').trim().toLowerCase();
  el.listsNav.innerHTML = '';
  const filtered = query
    ? state.lists.filter(l => (l.name || '').toLowerCase().includes(query))
    : state.lists;

  filtered.forEach(list => {
    const li = document.createElement('li');
    li.className = 'nav-item' + (list.id === state.activeListId ? ' active' : '');
    li.dataset.id = list.id;
    li.draggable = !query;
    li.innerHTML = `
      ${!query ? '<span class="nav-drag-handle">⠿</span>' : ''}
      <span class="nav-item-name">${escapeHtml(list.name)}</span>
      <span class="nav-item-star ${list.starred ? 'starred' : ''}">${list.starred ? '★' : ''}</span>
    `;
    li.addEventListener('click', () => openList(list.id));
    el.listsNav.appendChild(li);
  });

  if (filtered.length === 0 && query) {
    const empty = document.createElement('li');
    empty.className = 'nav-item-empty';
    empty.textContent = 'Nessuna lista trovata';
    el.listsNav.appendChild(empty);
  }

  if (!query) bindSidebarDragDrop();
}


// ============================================================
// RENDER — HOMEPAGE (with task previews)
// ============================================================

/**
 * Renders the homepage list cards.
 * Each card asynchronously fetches its tasks and shows
 * the 2 with the nearest planned period.
 */
function renderHomepage() {
  if (el.homepage.classList.contains('hidden')) return;
  el.homeCards.innerHTML = '';

  const query = (el.homeSearch?.value || el.sidebarSearch?.value || '').trim().toLowerCase();
  const visibleLists = query
    ? state.lists.filter(l => (l.name || '').toLowerCase().includes(query))
    : state.lists;

  if (visibleLists.length === 0 && state.lists.length === 0) {
    el.homeCards.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📋</div>
        <div class="empty-state-text">Nessuna lista.<br>Creane una per iniziare!</div>
      </div>`;
    return;
  }

  if (visibleLists.length === 0) {
    el.homeCards.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🔍</div>
        <div class="empty-state-text">Nessuna lista trovata.</div>
      </div>`;
    return;
  }

  visibleLists.forEach(list => {
    const colorHex = getListColorHex(list);
    const card = document.createElement('div');
    card.className = 'home-card';
    card.dataset.listId = list.id;
    if (colorHex) card.style.borderLeftColor = colorHex;
    card.innerHTML = `
      <div class="home-card-top">
        <div class="home-card-info">
          <div class="home-card-name">${escapeHtml(list.name)}</div>
        </div>
        ${list.starred ? '<div class="home-card-star">★</div>' : ''}
      </div>
      <div class="home-card-tasks" id="hct-${list.id}">
        <span class="home-card-loading">…</span>
      </div>
    `;
    // Clicking the top part opens the list
    card.querySelector('.home-card-top').addEventListener('click', () => openList(list.id));
    el.homeCards.appendChild(card);

    // Async: fetch tasks and render the 2 nearest
    fetchTasksForList(list.id).then(tasks => {
      renderHomeCardTasks(list.id, tasks);
    }).catch(() => {
      const container = document.getElementById(`hct-${list.id}`);
      if (container) container.innerHTML = '';
    });
  });
}

/**
 * Render up to 2 nearest-period tasks inside a home card.
 * "Nearest" = lowest PERIODS index among incomplete tasks with a period set.
 * Falls back to the 2 most recently added tasks if none have periods.
 */
function renderHomeCardTasks(listId, tasks) {
  const container = document.getElementById(`hct-${listId}`);
  if (!container) return;
  container.innerHTML = '';

  // Filter to incomplete tasks only
  const incomplete = tasks.filter(t => !t.completed);

  // Tasks with a planned period, sorted by period then deadline
  const withPeriod = sortTasksBySchedule(incomplete.filter(t => t.plannedPeriod));

  // Choose which ones to preview
  let preview = withPeriod.slice(0, 2);

  // If fewer than 2, pad with tasks that have no period (sorted by order)
  if (preview.length < 2) {
    const noPeriod = incomplete.filter(t => !t.plannedPeriod)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    preview = [...preview, ...noPeriod].slice(0, 2);
  }

  if (preview.length === 0) {
    container.innerHTML = '<span class="home-card-empty">Nessun task</span>';
    return;
  }

  preview.forEach(task => {
    const period = task.plannedPeriod ? getPeriod(task.plannedPeriod) : null;
    const row = document.createElement('div');
    row.className = 'home-card-task-row' + (task.overdue ? ' overdue' : '');
    row.innerHTML = `
      <span class="home-card-task-dot ${task.completed ? 'done' : ''}"></span>
      <span class="home-card-task-name">${escapeHtml(task.name)}</span>
      ${period
        ? (period.key === 'ogni_giorno'
            ? `<span class="home-card-task-pill home-card-task-pill--daily">${period.label} ↻</span>`
            : `<span class="home-card-task-pill"
                style="color:${period.color};border-color:${period.color}50;background:${period.color}12"
              >${period.label}</span>`)
        : ''}
    `;
    // Clicking a task row: open its list and then open the detail panel
    row.addEventListener('click', e => {
      e.stopPropagation();
      openList(listId, task.id);
    });
    container.appendChild(row);
  });

  // Show count of remaining incomplete tasks
  const remaining = incomplete.length - preview.length;
  if (remaining > 0) {
    const more = document.createElement('div');
    more.className = 'home-card-more';
    more.textContent = `+ altri ${remaining}`;
    more.addEventListener('click', e => { e.stopPropagation(); openList(listId); });
    container.appendChild(more);
  }
}


// ============================================================
// RENDER — TIMELINE VIEW
// ============================================================

/**
 * Render the timeline: fetch ALL tasks across ALL lists,
 * sort them by period → deadline → name,
 * group them by period (or "Senza periodo" at the end),
 * and render period-header sections.
 */
async function renderTimeline() {
  if (el.timelineView.classList.contains('hidden')) return;

  el.timelineContent.innerHTML =
    '<div class="timeline-loading">Caricamento…</div>';

  let allTasks;
  try {
    allTasks = await fetchAllTasks();
  } catch (err) {
    el.timelineContent.innerHTML =
      '<div class="empty-state"><div class="empty-state-icon">⚠</div>' +
      '<div class="empty-state-text">Errore nel caricamento.</div></div>';
    return;
  }

  const showCompleted = el.toggleShowCompleted.checked;
  // If "show completed" is enabled: include all still-uncompleted tasks
  // plus those that were completed today. Otherwise show only unfinished tasks.
  const filtered = showCompleted
    ? allTasks.filter(t => !isDailyTaskEffectivelyCompleted(t) || isCompletedToday(t))
    : allTasks.filter(t => !isDailyTaskEffectivelyCompleted(t));
  const sorted   = sortTasksBySchedule(filtered);

  if (sorted.length === 0) {
    el.timelineContent.innerHTML =
      '<div class="empty-state"><div class="empty-state-icon">✓</div>' +
      '<div class="empty-state-text">Nessun task da mostrare.</div></div>';
    return;
  }

  // Build a lookup: listId → list name
  const listNames = {};
  state.lists.forEach(l => { listNames[l.id] = l.name; });

  // Group tasks by plannedPeriod key.
  // 'ogni_giorno' tasks are folded into the 'oggi' bucket so they
  // appear under the "Oggi" section header in the agenda.
  const groups = new Map(); // groupKey → { period, tasks[] }

  sorted.forEach(task => {
    const rawKey  = task.plannedPeriod || '__none__';
    const groupKey = rawKey === 'ogni_giorno' ? 'oggi' : rawKey;
    const groupPeriod = groupKey !== '__none__' ? getPeriod(groupKey) : null;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, { period: groupPeriod, tasks: [] });
    }
    groups.get(groupKey).tasks.push(task);
  });

  el.timelineContent.innerHTML = '';

  groups.forEach(({ period, tasks }) => {
    // Period section header
    const section = document.createElement('div');
    section.className = 'timeline-section';

    const headerColor = period ? period.color : '#aaaaaa';
    section.innerHTML = `
      <div class="timeline-section-header" style="--period-color:${headerColor}">
        <span class="timeline-section-dot"></span>
        <span class="timeline-section-label">${period ? period.label : 'Senza periodo'}</span>
        <span class="timeline-section-count">${tasks.length}</span>
      </div>
    `;

    const list = document.createElement('div');
    list.className = 'timeline-task-list';

    tasks.forEach(task => {
      const listName  = listNames[task.listId] || '–';
      const deadlinePast = isDeadlinePast(task.deadline);

      const isEffectivelyDone = isCompletedToday(task);
      const overdueColor = task.overdue ? getOverdueColor(task) : null;
      const row = document.createElement('div');
      row.className = [
        'timeline-task-row',
        isEffectivelyDone ? 'completed' : '',
        task.overdue      ? 'overdue'   : '',
      ].filter(Boolean).join(' ');
      if (overdueColor) {
        row.style.borderLeftColor = overdueColor;
        row.style.background = `linear-gradient(90deg, ${overdueColor}18 0%, var(--surface) 50px)`;
      }

      row.innerHTML = `
        <span class="tl-check ${isEffectivelyDone ? 'checked' : ''}"></span>
        <div class="tl-body">
          <span class="tl-name">${escapeHtml(task.name)}</span>
          <div class="tl-meta">
            <span class="tl-list-tag">${escapeHtml(listName)}</span>
            ${task.deadline ? `<span class="tl-deadline ${deadlinePast ? 'past' : ''}">⏰ ${formatDeadline(task.deadline)}</span>` : ''}
            ${task.overdue  ? `<span class="tl-overdue-badge" ${overdueColor ? `style="color:${overdueColor};border-color:${overdueColor};background:${overdueColor}18"` : ''}>!</span>` : ''}
            ${task.plannedPeriod === 'ogni_giorno' ? '<span class="tl-daily-badge">↻</span>' : ''}
            ${(() => { if (!isRecurringTask(task) || isCompletedToday(task)) return ''; const bc = getRecurrenceColor(task.recurrence.type); const lb = getRecurrenceLabel(task.recurrence); return `<span class="task-recurrence-badge" style="color:${bc};border-color:${bc}50;background:${bc}18" title="${lb}">↻ ${lb}</span>`; })()}
          </div>
        </div>
      `;

      // ── Milestone inline row: barra + chip, sotto il nome ────
      if (!isEffectivelyDone) {
        const ms = task.milestones;
        if (ms && ms.length > 0) {
          const doneCnt = ms.filter(m => m.done).length;
          const pct     = Math.round(doneCnt / ms.length * 100);
          const tlList  = state.lists.find(l => l.id === task.listId);
          const lc      = getListColorHex(tlList);
          const grad    = lc
            ? `linear-gradient(90deg, ${lc} 0%, #FF98A9 100%)`
            : 'linear-gradient(90deg, var(--blue) 0%, var(--pink) 100%)';

          // Single flex row: [bar] [chip] [chip] …
          const msRow = document.createElement('div');
          msRow.className = 'tl-ms-row';

          // Mini progress bar (fixed width, left-anchored)
          const barEl = document.createElement('div');
          barEl.className = 'tl-ms-bar';
          barEl.title     = `${doneCnt}/${ms.length}`;
          barEl.innerHTML = `
            <span class="tl-ms-bar-fill" style="width:${pct}%;background:${grad}"></span>
            <span class="tl-ms-bar-label">${doneCnt}/${ms.length}</span>`;
          msRow.appendChild(barEl);

          // One chip per milestone
          ms.forEach((m, idx) => {
            const chip = document.createElement('span');
            chip.className = 'tl-ms-chip' + (m.done ? ' done' : '');
            chip.textContent = m.name;
            chip.title = m.done ? 'Riaprire' : 'Completare';
            chip.addEventListener('click', async e => {
              e.stopPropagation();
              const freshTask = state.tasks.find(t => t.id === task.id) || task;
              const freshMs   = (freshTask.milestones || []).map((fm, fi) =>
                fi === idx ? { ...fm, done: !fm.done } : fm
              );
              const allDone = freshMs.every(fm => fm.done);
              const updates = { milestones: freshMs };
              if (allDone) Object.assign(updates, buildCompleteUpdate(freshTask, true));
              else if (freshTask.completed) Object.assign(updates, buildCompleteUpdate(freshTask, false));
              await updateTaskInList(task.listId, task.id, updates);
              renderTimeline();
            });
            msRow.appendChild(chip);
          });

          // Insert BEFORE .tl-meta
          const metaEl = row.querySelector('.tl-meta');
          row.querySelector('.tl-body').insertBefore(msRow, metaEl);
        }
      }

      row.querySelector('.tl-check').addEventListener('click', async e => {
        e.stopPropagation();
        const nowDone = !isCompletedToday(task);
        const updates = buildCompleteUpdate(task, nowDone);
        await updateTaskInList(task.listId, task.id, updates);
        renderTimeline();
      });

      // Row click: navigate to the list and open the detail panel
      row.addEventListener('click', () => openList(task.listId, task.id));

      list.appendChild(row);
    });

    section.appendChild(list);
    el.timelineContent.appendChild(section);
  });
}


/**
 * Sort an array of tasks alphabetically by name.
 * Returns a NEW sorted array (does not mutate).
 */
function sortTasksByName(tasks) {
  return [...tasks].sort((a, b) => {
    return (a.name || '').localeCompare(b.name || '', 'it', { numeric: true, sensitivity: 'base' });
  });
}

/**
 * Get the current sort mode from the select element.
 * Returns: 'inserimento', 'urgenza', or 'nome'.
 */
function getCurrentSortMode() {
  return el.listSortSelect?.value || 'inserimento';
}



// ============================================================
// RENDER — TASK LIST (inside a single list view)
// ============================================================

function renderTaskList() {
  el.taskList.innerHTML = '';

  if (state.tasks.length === 0) {
    el.taskList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">✓</div>
        <div class="empty-state-text">Tutto a posto! Aggiungi il primo task.</div>
      </div>`;
    return;
  }

  // Split: incomplete first (manual order), done at the bottom.
  // For daily tasks "done" means completed today.
  let incomplete = state.tasks.filter(t => !isDailyTaskEffectivelyCompleted(t));
  const completed  = state.tasks.filter(t =>  isDailyTaskEffectivelyCompleted(t));

  // Apply sorting based on current sort mode
  const sortMode = getCurrentSortMode();
  if (sortMode === 'urgenza') {
    incomplete = sortTasksBySchedule(incomplete);
  } else if (sortMode === 'nome') {
    incomplete = sortTasksByName(incomplete);
  } else {
    // 'inserimento' (default): most recently added first
    incomplete = [...incomplete].sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
  }

  function appendTaskRow(task, isDone) {
    const period       = (!isDone && task.plannedPeriod) ? getPeriod(task.plannedPeriod) : null;
    const deadlinePast = isDeadlinePast(task.deadline);

    const li = document.createElement('li');
    li.className = [
      'task-item',
      isDone       ? 'completed' : '',
      task.overdue ? 'overdue'   : '',
    ].filter(Boolean).join(' ');
    li.dataset.id = task.id;
    li.draggable  = !isDone && sortMode === 'inserimento'; // only draggable in 'inserimento' mode

    li.innerHTML = `
      ${isDone || sortMode !== 'inserimento' ? '' : '<span class="task-drag-handle">⠿</span>'}
      <span class="task-check ${isDone ? 'checked' : ''}" data-action="check"></span>
      <div class="task-body">
        <span class="task-name">${escapeHtml(task.name)}</span>
        ${buildTaskMetaHtml(task, period, deadlinePast, isDone)}
      </div>
      ${task.notes && !isDone ? '<span class="task-has-notes" title="Ha note"></span>' : ''}
    `;

    li.querySelector('[data-action="check"]').addEventListener('click', e => {
      e.stopPropagation();
      updateTask(task.id, buildCompleteUpdate(task, !isDailyTaskEffectivelyCompleted(task)));
    });
    li.addEventListener('click', () => openDetailPanel(task.id));
    el.taskList.appendChild(li);
  }

  incomplete.forEach(task => appendTaskRow(task, false));

  if (completed.length > 0) {
    const divider = document.createElement('li');
    divider.className = 'task-completed-divider';
    divider.innerHTML = `<span class="task-completed-divider-label">Completati (${completed.length})</span>`;
    el.taskList.appendChild(divider);
    completed.forEach(task => appendTaskRow(task, true));
  }

  bindTaskDragDrop();
}

// isDone=true → hide period / deadline chips (task already done)
function buildTaskMetaHtml(task, period, deadlinePast, isDone = false) {
  const parts = [];
  if (period && !isDone) {
    const bang = task.overdue ? '<span class="period-bang">!</span>' : '';
    if (period.key === 'ogni_giorno') {
      parts.push(`<span class="task-period-pill task-period-pill--daily">${bang}${period.label} ↻</span>`);
    } else {
      // Use overdue color if task is overdue, otherwise use period color
      const displayColor = getOverdueColor(task) || period.color;
      parts.push(`<span class="task-period-pill"
        style="background:${displayColor}18;color:${displayColor};border-color:${displayColor}50"
      >${bang}${period.label}</span>`);
    }
  }
  // Recurrence badge — fixed color per type, never inherits period color
  if (isRecurringTask(task) && !isDone) {
    const badgeColor = getRecurrenceColor(task.recurrence.type);
    const label      = getRecurrenceLabel(task.recurrence);
    parts.push(`<span class="task-recurrence-badge" style="color:${badgeColor};border-color:${badgeColor}50;background:${badgeColor}18" title="${label}">↻ ${label}</span>`);
  }
  if (task.deadline && !isDone) {
    parts.push(`<span class="task-deadline-chip ${deadlinePast ? 'past' : ''}">⏰ ${formatDeadline(task.deadline)}</span>`);
  }
  // Mini progress bar if milestones exist
  const ms = task.milestones;
  if (ms && ms.length > 0 && !isDone) {
    const doneCnt = ms.filter(m => m.done).length;
    const pct = Math.round(doneCnt / ms.length * 100);
    const list = state.lists.find(l => l.id === state.activeListId);
    const lc = getListColorHex(list);
    const grad = lc
      ? `linear-gradient(90deg, ${lc} 0%, #FF98A9 100%)`
      : 'linear-gradient(90deg, var(--blue) 0%, var(--pink) 100%)';
    parts.push(`<span class="task-mini-progress" title="${pct}% completato">
      <span class="task-mini-progress-fill" style="width:${pct}%;background:${grad}"></span>
      <span class="task-mini-progress-label">${doneCnt}/${ms.length}</span>
    </span>`);
  }
  return parts.length > 0 ? `<div class="task-meta">${parts.join('')}</div>` : '';
}


// ============================================================
// RECURRENCE UI
// ============================================================

function _showDetailRecurrenceSub(type) {
  const daysWrap    = document.getElementById('detail-recurrence-days-wrap');
  const monthlyWrap = document.getElementById('detail-recurrence-monthly-wrap');
  const yearlyWrap  = document.getElementById('detail-recurrence-yearly-wrap');
  const labelEl     = document.getElementById('detail-recurrence-days-label');
  if (daysWrap)    daysWrap.classList.toggle('hidden',    !(type === 'custom' || type === 'weekly'));
  if (monthlyWrap) monthlyWrap.classList.toggle('hidden', type !== 'monthly');
  if (yearlyWrap)  yearlyWrap.classList.toggle('hidden',  type !== 'yearly');
  if (labelEl) {
    labelEl.textContent = type === 'weekly' ? 'Escludi giorni (clicca per deselezionare)' : 'Nei giorni';
  }
}

function renderRecurrenceUI(task) {
  const typeEl = document.getElementById('detail-recurrence-type');
  if (!typeEl) return;

  const rec = task.recurrence || null;
  typeEl.value = rec ? rec.type : '';

  _showDetailRecurrenceSub(rec ? rec.type : '');

  // Day buttons
  // weekly: rec.days = INCLUDED days (empty = all). Active = included. Clicking deselects.
  // custom: rec.days = included days. Active = included.
  if (rec && rec.type === 'weekly') {
    const includedDays = (rec.days && rec.days.length > 0) ? rec.days : [0,1,2,3,4,5,6];
    document.querySelectorAll('#detail-recurrence-days .recurrence-day-btn').forEach(btn => {
      btn.classList.toggle('active', includedDays.includes(parseInt(btn.dataset.day, 10)));
    });
  } else {
    const activeDays = (rec && rec.days) ? rec.days : [];
    document.querySelectorAll('#detail-recurrence-days .recurrence-day-btn').forEach(btn => {
      btn.classList.toggle('active', activeDays.includes(parseInt(btn.dataset.day, 10)));
    });
  }

  // Monthly day input
  const monthlyInput = document.getElementById('detail-recurrence-monthly-day');
  if (monthlyInput) monthlyInput.value = (rec && rec.monthDay) ? rec.monthDay : '';

  // Yearly inputs
  const yearlyDay   = document.getElementById('detail-recurrence-yearly-day');
  const yearlyMonth = document.getElementById('detail-recurrence-yearly-month');
  if (yearlyDay)   yearlyDay.value   = (rec && rec.yearDay   !== undefined) ? rec.yearDay   : '';
  if (yearlyMonth) yearlyMonth.value = (rec && rec.yearMonth !== undefined) ? rec.yearMonth : '0';

  const hintEl = document.getElementById('detail-recurrence-hint');
  if (hintEl) hintEl.textContent = rec ? getRecurrenceLabel(rec) : '';
}

function _readDetailRecurrence() {
  const typeEl = document.getElementById('detail-recurrence-type');
  const type   = typeEl ? typeEl.value : '';
  if (!type) return null;

  const rec = { type };

  if (type === 'custom') {
    rec.days = [...document.querySelectorAll('#detail-recurrence-days .recurrence-day-btn.active')]
      .map(b => parseInt(b.dataset.day, 10));
  }
  if (type === 'weekly') {
    // Active buttons = included days. All 7 active = every day (store as empty = all).
    const active = [...document.querySelectorAll('#detail-recurrence-days .recurrence-day-btn.active')]
      .map(b => parseInt(b.dataset.day, 10));
    rec.days = active.length === 7 ? [] : active; // empty means all days
  }
  if (type === 'monthly') {
    const v = parseInt(document.getElementById('detail-recurrence-monthly-day')?.value, 10);
    rec.monthDay = (!isNaN(v) && v >= 1 && v <= 31) ? v : null;
  }
  if (type === 'yearly') {
    const d = parseInt(document.getElementById('detail-recurrence-yearly-day')?.value, 10);
    const m = parseInt(document.getElementById('detail-recurrence-yearly-month')?.value, 10);
    rec.yearDay   = (!isNaN(d) && d >= 1 && d <= 31) ? d : null;
    rec.yearMonth = !isNaN(m) ? m : null;
  }
  return rec;
}

function saveRecurrence() {
  if (!state.activeTaskId) return;
  const task = state.tasks.find(t => t.id === state.activeTaskId);
  if (!task) return;

  const rec = _readDetailRecurrence();

  if (!rec) {
    updateTask(state.activeTaskId, { recurrence: null });
    const hintEl = document.getElementById('detail-recurrence-hint');
    if (hintEl) hintEl.textContent = '';
    return;
  }

  const periodKey = getRecurrencePeriodKey(rec);
  const period    = periodKey ? getPeriod(periodKey) : null;
  const until     = period ? period.getEnd() : null;

  updateTask(state.activeTaskId, {
    recurrence:         rec,
    plannedPeriod:      periodKey || task.plannedPeriod,
    plannedPeriodUntil: until !== undefined ? until : task.plannedPeriodUntil,
    completed:          false,
    lastCompletedDate:  null,
    overdue:            false,
  });

  const hintEl = document.getElementById('detail-recurrence-hint');
  if (hintEl) hintEl.textContent = getRecurrenceLabel(rec);
}


// ============================================================
// DETAIL PANEL
// ============================================================

function openDetailPanel(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;

  state.activeTaskId = taskId;
  el.detailTitle.value = task.name;
  el.detailNotes.value = task.notes || '';
  el.btnComplete.textContent = task.completed ? 'Segna incompleto' : 'Segna completo';
  el.detailDeadline.value = task.deadline || '';
  updateDeadlineStatus(task.deadline);
  el.detailPeriod.value = task.plannedPeriod || '';

  if (task.overdue && !task.completed) {
    el.detailOverdueBar.classList.remove('hidden');
    const idx = PERIODS.findIndex(p => p.key === task.plannedPeriod);
    const prevLabel = idx > 0 ? PERIODS[idx - 1].label : '…';
    el.detailOverdueBar.textContent =
      `⚠ Non completato in tempo! Spostato da "${prevLabel}". Modifica il periodo per azzerare l'avviso.`;
  } else {
    el.detailOverdueBar.classList.add('hidden');
  }

  // Show/hide "apply list defaults" button
  const list = state.lists.find(l => l.id === state.activeListId);
  const listColorHex = getListColorHex(list);
  const hasDefaults = list && list.defaultMilestones && list.defaultMilestones.length > 0;
  if (el.btnApplyDefaultMs) {
    el.btnApplyDefaultMs.classList.toggle('hidden', !hasDefaults);
    if (hasDefaults) {
      el.btnApplyDefaultMs.textContent = `⊕ Tappe lista (${list.defaultMilestones.length})`;
    }
  }

  el.detailPanel.classList.remove('hidden');
  el.detailPanel.classList.add('open');
  el.overlay.classList.remove('hidden');
  renderMilestones(task, listColorHex);
  renderRecurrenceUI(task);
}

function updateDeadlineStatus(isoStr) {
  if (!el.detailDeadlineStatus) return;
  if (!isoStr) { el.detailDeadlineStatus.textContent = ''; el.detailDeadlineStatus.className = 'deadline-status'; return; }
  if (isDeadlinePast(isoStr)) {
    el.detailDeadlineStatus.textContent = '⚠ Scaduta!';
    el.detailDeadlineStatus.className = 'deadline-status past';
  } else {
    const [y,m,d] = isoStr.split('-').map(Number);
    const diff = Math.ceil((new Date(y,m-1,d) - new Date()) / 86400000);
    el.detailDeadlineStatus.textContent = diff===0 ? 'Scade oggi' : diff===1 ? 'Scade domani' : `Scade tra ${diff} giorni`;
    el.detailDeadlineStatus.className = 'deadline-status ok';
  }
}

function closeDetailPanel() {
  state.activeTaskId = null;
  el.detailPanel.classList.remove('open');
  el.overlay.classList.add('hidden');
  setTimeout(() => el.detailPanel.classList.add('hidden'), 310);
}


// ============================================================
// MODAL
// ============================================================

function showModal() { el.modalBackdrop.classList.remove('hidden'); el.modalListName.value = ''; setTimeout(() => el.modalListName.focus(), 50); }
function hideModal() { el.modalBackdrop.classList.add('hidden'); }

async function handleCreateList() {
  const name = el.modalListName.value.trim();
  if (!name) return;
  hideModal();
  const docRef = await listsRef().add({
    name, starred: false, order: state.lists.length,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  openList(docRef.id);
}


// ============================================================
// LIST SETTINGS MODAL
// ============================================================

let lsmTempMilestones = []; // working copy while modal is open

function openListSettings() {
  const list = state.lists.find(l => l.id === state.activeListId);
  if (!list) return;

  el.lsmName.value = list.name || '';
  lsmTempMilestones = [...(list.defaultMilestones || [])];

  // Build color swatches
  el.lsmColorSwatches.innerHTML = '';
  LIST_COLORS.forEach(c => {
    const sw = document.createElement('button');
    sw.className = 'lsm-swatch' + (list.color === c.key ? ' selected' : '');
    sw.style.background = c.hex;
    sw.dataset.colorKey = c.key;
    sw.title = c.label;
    if (c.key === 'c1') sw.style.border = '2px solid #ccc'; // yellow needs contrast
    sw.addEventListener('click', () => {
      el.lsmColorSwatches.querySelectorAll('.lsm-swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
    });
    el.lsmColorSwatches.appendChild(sw);
  });
  // Add "no color" option
  const noColor = document.createElement('button');
  noColor.className = 'lsm-swatch lsm-swatch--none' + (!list.color ? ' selected' : '');
  noColor.dataset.colorKey = '';
  noColor.title = 'Nessun colore';
  noColor.innerHTML = '✕';
  noColor.addEventListener('click', () => {
    el.lsmColorSwatches.querySelectorAll('.lsm-swatch').forEach(s => s.classList.remove('selected'));
    noColor.classList.add('selected');
  });
  el.lsmColorSwatches.insertBefore(noColor, el.lsmColorSwatches.firstChild);

  renderLsmMilestones();
  el.listSettingsBackdrop.classList.remove('hidden');
  setTimeout(() => el.lsmName.focus(), 50);
}

function closeListSettings() {
  el.listSettingsBackdrop.classList.add('hidden');
}

function renderLsmMilestones() {
  el.lsmMilestonesList.innerHTML = '';
  lsmTempMilestones.forEach((name, idx) => {
    const row = document.createElement('div');
    row.className = 'lsm-ms-row';
    row.innerHTML = `
      <span class="lsm-ms-dot"></span>
      <span class="lsm-ms-name">${escapeHtml(name)}</span>
      <button class="lsm-ms-delete" data-idx="${idx}" title="Rimuovi">✕</button>
    `;
    row.querySelector('.lsm-ms-delete').addEventListener('click', () => {
      lsmTempMilestones.splice(idx, 1);
      renderLsmMilestones();
    });
    el.lsmMilestonesList.appendChild(row);
  });
}

async function saveListSettings() {
  const name = el.lsmName.value.trim();
  if (!name) return;
  const selectedSwatch = el.lsmColorSwatches.querySelector('.lsm-swatch.selected');
  const colorKey = selectedSwatch ? selectedSwatch.dataset.colorKey : '';
  const updates = {
    name,
    color: colorKey || null,
    defaultMilestones: [...lsmTempMilestones],
  };
  await updateList(state.activeListId, updates);
  // Also update the title input live
  el.listTitleInput.value = name;
  closeListSettings();
}


// ============================================================
// DRAG AND DROP — TASKS
// ============================================================
let dragSrcTask = null;

function bindTaskDragDrop() {
  const items = el.taskList.querySelectorAll('.task-item');
  items.forEach(item => {
    item.addEventListener('dragstart', e => { dragSrcTask = item; item.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    item.addEventListener('dragend', () => { item.classList.remove('dragging'); items.forEach(i => i.classList.remove('drag-over')); dragSrcTask = null; });
    item.addEventListener('dragover', e => { e.preventDefault(); items.forEach(i => i.classList.remove('drag-over')); if (dragSrcTask && dragSrcTask !== item) item.classList.add('drag-over'); });
    item.addEventListener('drop', e => {
      e.preventDefault();
      if (!dragSrcTask || dragSrcTask === item) return;
      item.classList.remove('drag-over');
      const all = [...el.taskList.querySelectorAll('.task-item')];
      if (all.indexOf(dragSrcTask) < all.indexOf(item)) item.after(dragSrcTask);
      else item.before(dragSrcTask);
      persistTaskOrder();
    });
  });
}

async function persistTaskOrder() {
  const items = [...el.taskList.querySelectorAll('.task-item')];
  const batch = db.batch();
  items.forEach((item, idx) => { batch.update(tasksRef(state.activeListId).doc(item.dataset.id), { order: idx }); });
  await batch.commit();
}


// ============================================================
// DRAG AND DROP — SIDEBAR
// ============================================================
let dragSrcList = null;

function bindSidebarDragDrop() {
  const items = el.listsNav.querySelectorAll('.nav-item');
  items.forEach(item => {
    item.addEventListener('dragstart', e => { dragSrcList = item; e.dataTransfer.effectAllowed = 'move'; setTimeout(() => item.style.opacity = '0.5', 0); });
    item.addEventListener('dragend', () => { item.style.opacity = ''; items.forEach(i => i.style.borderTop = ''); dragSrcList = null; });
    item.addEventListener('dragover', e => { e.preventDefault(); items.forEach(i => i.style.borderTop = ''); if (dragSrcList && dragSrcList !== item) item.style.borderTop = '2px solid var(--yellow)'; });
    item.addEventListener('drop', e => {
      e.preventDefault();
      items.forEach(i => i.style.borderTop = '');
      if (!dragSrcList || dragSrcList === item) return;
      const all = [...el.listsNav.querySelectorAll('.nav-item')];
      if (all.indexOf(dragSrcList) < all.indexOf(item)) item.after(dragSrcList);
      else item.before(dragSrcList);
      persistListOrder();
    });
  });
}

async function persistListOrder() {
  const items = [...el.listsNav.querySelectorAll('.nav-item')];
  const batch = db.batch();
  items.forEach((item, idx) => { batch.update(listsRef().doc(item.dataset.id), { order: idx }); });
  await batch.commit();
}


// ============================================================
// BIND GLOBAL EVENTS
// ============================================================

function bindEvents() {

  el.btnNewList.addEventListener('click', showModal);
  el.btnNewListHome.addEventListener('click', showModal);
  el.btnHome.addEventListener('click', showHomepage);
  el.btnTimeline.addEventListener('click', showTimeline);
  if (el.btnCalendar) el.btnCalendar.addEventListener('click', showCalendar);

  // Calendar navigation
  if (el.calBtnPrev) el.calBtnPrev.addEventListener('click', () => {
    calState.month--; if (calState.month < 0) { calState.month = 11; calState.year--; }
    calState.selectedIso = null;
    refreshCalendarTasks().then(renderCalendar);
  });
  if (el.calBtnNext) el.calBtnNext.addEventListener('click', () => {
    calState.month++; if (calState.month > 11) { calState.month = 0; calState.year++; }
    calState.selectedIso = null;
    refreshCalendarTasks().then(renderCalendar);
  });
  if (el.calBtnToday) el.calBtnToday.addEventListener('click', () => {
    const now = new Date();
    calState.year = now.getFullYear(); calState.month = now.getMonth();
    calState.selectedIso = null;
    refreshCalendarTasks().then(renderCalendar);
  });

  el.btnModalCancel.addEventListener('click', hideModal);
  el.btnModalCreate.addEventListener('click', handleCreateList);
  el.modalListName.addEventListener('keydown', e => { if (e.key === 'Enter') handleCreateList(); });
  el.modalBackdrop.addEventListener('click', e => { if (e.target === el.modalBackdrop) hideModal(); });

  if (el.detailTitle) {
    el.detailTitle.addEventListener('blur', () => {
      if (!state.activeTaskId) return;
      const name = el.detailTitle.value.trim();
      if (!name) return;
      updateTask(state.activeTaskId, { name });
    });
    el.detailTitle.addEventListener('keydown', e => { if (e.key === 'Enter') el.detailTitle.blur(); });
  }

  el.listTitleInput.addEventListener('blur', () => {
    const name = el.listTitleInput.value.trim();
    if (name && state.activeListId) updateList(state.activeListId, { name });
  });
  el.listTitleInput.addEventListener('keydown', e => { if (e.key === 'Enter') el.listTitleInput.blur(); });

  el.listSortSelect.addEventListener('change', () => {
    renderTaskList();
  });

  el.btnStar.addEventListener('click', async () => {
    if (!state.activeListId) return;
    const list = state.lists.find(l => l.id === state.activeListId);
    const newStarred = !list.starred;
    const batch = db.batch();
    if (newStarred) state.lists.forEach(l => { if (l.starred) batch.update(listsRef().doc(l.id), { starred: false }); });
    batch.update(listsRef().doc(state.activeListId), { starred: newStarred });
    await batch.commit();
    updateStarButton(newStarred);
  });

  el.btnDeleteList.addEventListener('click', async () => {
    if (!state.activeListId) return;
    if (!confirm('Eliminare questa lista e tutti i suoi task?')) return;
    const listId = state.activeListId;
    showHomepage();
    await deleteList(listId);
  });

  function doAddTask() {
    const name     = el.taskInput.value.trim();
    const period   = el.taskPeriodQuick?.value  || null;
    const deadline = el.taskDeadlineQuick?.value || null;
    if (!name) return;
    addTask(name, period, deadline, quickRecurrence);
    el.taskInput.value = '';
    if (el.taskDeadlineQuick) el.taskDeadlineQuick.value = '';
    if (el.taskPeriodQuick)   el.taskPeriodQuick.value   = '';
    // Reset recurrence after add
    quickRecurrence = null;
    updateQuickRecurrenceBtn();
    el.taskInput.focus();
  }

  el.btnAddTask.addEventListener('click', doAddTask);
  el.taskInput.addEventListener('keydown', e => { if (e.key === 'Enter') doAddTask(); });

  // ── Quick-recurrence popover ─────────────────────────────────
  const qrpEl      = document.getElementById('quick-recurrence-popover');
  const btnQrp     = document.getElementById('btn-quick-recurrence');
  const qrpSummary = document.getElementById('qrp-summary');

  // Build day-picker buttons into both qrp-days-weekly and qrp-days-custom
  ['qrp-days-weekly','qrp-days-custom'].forEach(id => {
    const wrap = document.getElementById(id);
    if (!wrap) return;
    [[1,'Lun'],[2,'Mar'],[3,'Mer'],[4,'Gio'],[5,'Ven'],[6,'Sab'],[0,'Dom']].forEach(([day, label]) => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'recurrence-day-btn';
      btn.dataset.day = day; btn.textContent = label;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        btn.classList.toggle('active'); // both weekly and custom: toggle
        buildQuickRecurrence();
      });
      wrap.appendChild(btn);
    });
  });

  // When user selects "weekly" type, initialise all 7 days as active
  function initWeeklyDays() {
    document.querySelectorAll('#qrp-days-weekly .recurrence-day-btn').forEach(b => b.classList.add('active'));
  }

  function buildQuickRecurrence() {
    const activeBtn = qrpEl.querySelector('.qrp-type-btn.active');
    const type = activeBtn ? activeBtn.dataset.type : '';
    if (!type) { quickRecurrence = null; }
    else {
      const rec = { type };
      if (type === 'custom') {
        rec.days = [...document.querySelectorAll('#qrp-days-custom .recurrence-day-btn.active')]
          .map(b => parseInt(b.dataset.day, 10));
      }
      if (type === 'weekly') {
        // Active buttons = INCLUDED days. All 7 = empty (every day).
        const active = [...document.querySelectorAll('#qrp-days-weekly .recurrence-day-btn.active')]
          .map(b => parseInt(b.dataset.day, 10));
        rec.days = active.length === 7 ? [] : active;
      }
      if (type === 'monthly') {
        const v = parseInt(document.getElementById('qrp-monthly-day')?.value, 10);
        rec.monthDay = (!isNaN(v) && v >= 1 && v <= 31) ? v : null;
      }
      if (type === 'yearly') {
        const d = parseInt(document.getElementById('qrp-yearly-day')?.value, 10);
        const m = parseInt(document.getElementById('qrp-yearly-month')?.value, 10);
        rec.yearDay   = (!isNaN(d) && d >= 1 && d <= 31) ? d : null;
        rec.yearMonth = (!isNaN(m)) ? m : null;
      }
      quickRecurrence = rec;
    }
    updateQuickRecurrenceBtn();
    if (qrpSummary) qrpSummary.textContent = quickRecurrence ? getRecurrenceLabel(quickRecurrence) : '';
  }

  function updateQuickRecurrenceBtn() {
    if (!btnQrp) return;
    const isSet = !!(quickRecurrence && quickRecurrence.type);
    btnQrp.classList.toggle('active', isSet);
    btnQrp.title = isSet ? ('Ricorrenza: ' + getRecurrenceLabel(quickRecurrence)) : 'Imposta ricorrenza';
  }

  function showQrpSub(type) {
    ['weekly','monthly','yearly','custom'].forEach(t => {
      const el = document.getElementById('qrp-sub-' + t);
      if (el) el.classList.toggle('hidden', t !== type);
    });
  }

  if (btnQrp && qrpEl) {
    btnQrp.addEventListener('click', e => {
      e.stopPropagation();
      qrpEl.classList.toggle('hidden');
    });
    // Type buttons
    qrpEl.querySelectorAll('.qrp-type-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        qrpEl.querySelectorAll('.qrp-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        showQrpSub(btn.dataset.type);
        if (btn.dataset.type === 'weekly') initWeeklyDays();
        buildQuickRecurrence();
      });
    });
    // Monthly day input
    const qrpMonthly = document.getElementById('qrp-monthly-day');
    if (qrpMonthly) qrpMonthly.addEventListener('input', e => { e.stopPropagation(); buildQuickRecurrence(); });
    // Yearly inputs
    ['qrp-yearly-day','qrp-yearly-month'].forEach(id => {
      const inp = document.getElementById(id);
      if (inp) inp.addEventListener('change', e => { e.stopPropagation(); buildQuickRecurrence(); });
    });
    // Close on outside click
    document.addEventListener('click', e => {
      if (!qrpEl.classList.contains('hidden') && !qrpEl.contains(e.target) && e.target !== btnQrp) {
        qrpEl.classList.add('hidden');
      }
    });
  }

  if (el.btnClearDeadlineQuick) {
    el.btnClearDeadlineQuick.addEventListener('click', () => {
      if (el.taskDeadlineQuick) el.taskDeadlineQuick.value = '';
      el.taskInput.focus();
    });
  }

  el.btnCloseDetail.addEventListener('click', closeDetailPanel);
  el.overlay.addEventListener('click', closeDetailPanel);
  if (el.btnSaveDetail) el.btnSaveDetail.addEventListener('click', closeDetailPanel);

  el.detailNotes.addEventListener('input', () => { if (state.activeTaskId) saveNotesDebounced(state.activeTaskId, el.detailNotes.value); });

  el.btnComplete.addEventListener('click', () => {
    if (!state.activeTaskId) return;
    const task = state.tasks.find(t => t.id === state.activeTaskId);
    if (!task) return;
    const newCompleted = !isDailyTaskEffectivelyCompleted(task);
    updateTask(state.activeTaskId, buildCompleteUpdate(task, newCompleted));
    el.btnComplete.textContent = newCompleted ? 'Segna incompleto' : 'Segna completo';
  });

  el.btnDeleteTask.addEventListener('click', async () => {
    if (!state.activeTaskId) return;
    if (!confirm('Eliminare questo task?')) return;
    const taskId = state.activeTaskId;
    closeDetailPanel();
    await deleteTask(taskId);
  });

  el.detailDeadline.addEventListener('change', () => {
    if (!state.activeTaskId) return;
    const val = el.detailDeadline.value;
    updateDeadlineStatus(val);
    updateTask(state.activeTaskId, { deadline: val || null, overdue: false });
  });

  el.btnClearDeadline.addEventListener('click', () => {
    if (!state.activeTaskId) return;
    el.detailDeadline.value = '';
    updateDeadlineStatus('');
    updateTask(state.activeTaskId, { deadline: null, overdue: false });
  });

  el.detailPeriod.addEventListener('change', () => {
    if (!state.activeTaskId) return;
    const key   = el.detailPeriod.value || null;
    const p     = key ? getPeriod(key) : null;
    const until = p ? p.getEnd() : null;
    el.detailOverdueBar.classList.add('hidden');
    updateTask(state.activeTaskId, { plannedPeriod: key, plannedPeriodUntil: until, overdue: false });
  });

  // ── Detail panel: recurrence type select ────────────────────
  const recTypeEl = document.getElementById('detail-recurrence-type');
  if (recTypeEl) {
    recTypeEl.addEventListener('change', () => {
      const type = recTypeEl.value;
      _showDetailRecurrenceSub(type);
      if (type === 'weekly') {
        // Default: all days included (all active)
        document.querySelectorAll('#detail-recurrence-days .recurrence-day-btn').forEach(b => b.classList.add('active'));
      } else {
        document.querySelectorAll('#detail-recurrence-days .recurrence-day-btn').forEach(b => b.classList.remove('active'));
      }
      saveRecurrence();
    });
  }

  // Day buttons in detail panel — both weekly and custom use toggle (multi)
  document.querySelectorAll('#detail-recurrence-days .recurrence-day-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      saveRecurrence();
    });
  });

  // Monthly day input in detail panel
  const detailMonthlyDay = document.getElementById('detail-recurrence-monthly-day');
  if (detailMonthlyDay) detailMonthlyDay.addEventListener('change', saveRecurrence);

  // Yearly inputs in detail panel
  ['detail-recurrence-yearly-day', 'detail-recurrence-yearly-month'].forEach(id => {
    const inp = document.getElementById(id);
    if (inp) inp.addEventListener('change', saveRecurrence);
  });

  // Timeline: re-render when "show completed" toggle changes
  el.toggleShowCompleted.addEventListener('change', renderTimeline);

  // ── Timeline quick-add (urgent task) ────────────────────────
  if (el.btnTimelineQuickAdd) {
    el.btnTimelineQuickAdd.addEventListener('click', () => {
      // Populate list select with current lists
      el.tlTaskListSel.innerHTML = '';
      state.lists.forEach(l => {
        const opt = document.createElement('option');
        opt.value = l.id;
        opt.textContent = l.name;
        el.tlTaskListSel.appendChild(opt);
      });
      // Populate period select, default to 'oggi'
      el.tlTaskPeriodSel.innerHTML = '';
      const allPeriods = [DAILY_PERIOD, ...PERIODS];
      allPeriods.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.key;
        opt.textContent = p.label;
        if (p.key === 'oggi') opt.selected = true;
        el.tlTaskPeriodSel.appendChild(opt);
      });
      el.tlQuickAddBar.classList.remove('hidden');
      el.btnTimelineQuickAdd.classList.add('active');
      setTimeout(() => el.tlTaskInput.focus(), 50);
    });
  }

  function hideTlQuickAdd() {
    el.tlQuickAddBar.classList.add('hidden');
    el.btnTimelineQuickAdd.classList.remove('active');
    el.tlTaskInput.value = '';
  }

  if (el.btnTlCancel) el.btnTlCancel.addEventListener('click', hideTlQuickAdd);

  async function doTlAdd() {
    const name = el.tlTaskInput.value.trim();
    const listId = el.tlTaskListSel.value;
    const periodKey = el.tlTaskPeriodSel.value || 'oggi';
    if (!name || !listId) return;
    const p = getPeriod(periodKey);
    const until = p ? p.getEnd() : null;
    // Fetch current task count for order
    const snap = await tasksRef(listId).get();
    await tasksRef(listId).add({
      name, completed: false, notes: '', order: snap.size,
      deadline: null,
      plannedPeriod: periodKey,
      plannedPeriodUntil: until,
      overdue: false,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      milestones: [],
    });
    hideTlQuickAdd();
    renderTimeline();
  }

  if (el.btnTlAdd) el.btnTlAdd.addEventListener('click', doTlAdd);
  if (el.tlTaskInput) el.tlTaskInput.addEventListener('keydown', e => { if (e.key === 'Enter') doTlAdd(); if (e.key === 'Escape') hideTlQuickAdd(); });

  // ── Milestones ───────────────────────────────────────────────
  if (el.btnAddMilestone) {
    el.btnAddMilestone.addEventListener('click', () => {
      if (!state.activeTaskId) return;
      const task = state.tasks.find(t => t.id === state.activeTaskId);
      if (!task) return;
      const name = el.addMilestoneInput.value.trim();
      if (!name) return;
      addMilestone(task, name);
      el.addMilestoneInput.value = '';
    });
  }
  if (el.addMilestoneInput) {
    el.addMilestoneInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') el.btnAddMilestone.click();
    });
  }

  // Apply list default milestones to current task
  if (el.btnApplyDefaultMs) {
    el.btnApplyDefaultMs.addEventListener('click', async () => {
      if (!state.activeTaskId) return;
      const task = state.tasks.find(t => t.id === state.activeTaskId);
      const list = state.lists.find(l => l.id === state.activeListId);
      if (!task || !list || !list.defaultMilestones || !list.defaultMilestones.length) return;
      // Merge: add defaults that don't already exist (by name)
      const existing = new Set((task.milestones || []).map(m => m.name.toLowerCase()));
      const toAdd = list.defaultMilestones
        .filter(name => !existing.has(name.toLowerCase()))
        .map(name => ({ id: Date.now().toString(36) + Math.random().toString(36).slice(2), name, done: false }));
      const milestones = [...(task.milestones || []), ...toAdd];
      await updateTask(task.id, { milestones });
      task.milestones = milestones;
      renderMilestones(task, getListColorHex(list));
    });
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!el.modalBackdrop.classList.contains('hidden')) hideModal();
      else if (!el.detailPanel.classList.contains('hidden')) closeDetailPanel();
    }
  });

  if (el.btnLogin)        el.btnLogin.addEventListener('click', loginWithGoogle);
  if (el.btnLogout)       el.btnLogout.addEventListener('click', logoutUser);
  if (el.btnLogoutMobile) el.btnLogoutMobile.addEventListener('click', logoutUser);
  if (el.btnLoginMobile)  el.btnLoginMobile.addEventListener('click', loginWithGoogle);
  if (el.btnOverlayLogin) el.btnOverlayLogin.addEventListener('click', loginWithGoogle);

  // ── Sidebar search ───────────────────────────────────────────
  if (el.sidebarSearch) {
    el.sidebarSearch.addEventListener('input', () => { renderSidebar(); renderHomepage(); });
    el.sidebarSearch.addEventListener('keydown', e => {
      if (e.key === 'Escape') { el.sidebarSearch.value = ''; renderSidebar(); renderHomepage(); }
    });
  }
  if (el.homeSearch) {
    el.homeSearch.addEventListener('input', () => { renderSidebar(); renderHomepage(); });
    el.homeSearch.addEventListener('keydown', e => {
      if (e.key === 'Escape') { el.homeSearch.value = ''; renderSidebar(); renderHomepage(); }
    });
  }

  // ── List settings ────────────────────────────────────────────
  if (el.btnListSettings) {
    el.btnListSettings.addEventListener('click', openListSettings);
  }
  if (el.btnLsmClose)  el.btnLsmClose.addEventListener('click', closeListSettings);
  if (el.btnLsmCancel) el.btnLsmCancel.addEventListener('click', closeListSettings);
  if (el.btnLsmSave)   el.btnLsmSave.addEventListener('click', saveListSettings);
  if (el.listSettingsBackdrop) {
    el.listSettingsBackdrop.addEventListener('click', e => {
      if (e.target === el.listSettingsBackdrop) closeListSettings();
    });
  }
  if (el.btnLsmAddMs) {
    el.btnLsmAddMs.addEventListener('click', () => {
      const v = el.lsmMsInput.value.trim();
      if (!v) return;
      lsmTempMilestones.push(v);
      renderLsmMilestones();
      el.lsmMsInput.value = '';
      el.lsmMsInput.focus();
    });
  }
  if (el.lsmMsInput) {
    el.lsmMsInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') el.btnLsmAddMs.click();
    });
  }
}


// ============================================================
// CALENDAR ENGINE
// ============================================================

const IT_MONTHS = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
                   'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
const IT_DAYS_SHORT = ['Lun','Mar','Mer','Gio','Ven','Sab','Dom'];

/** Fetch all tasks from all lists and cache in calState.allTasks */
async function refreshCalendarTasks() {
  try {
    calState.allTasks = await fetchAllTasks();
  } catch (e) {
    calState.allTasks = [];
  }
}

/**
 * Main calendar renderer.
 * Builds the month grid, marks deadline dots and period-coverage bands.
 */
function renderCalendar() {
  if (el.calendarView.classList.contains('hidden')) return;

  const { year, month } = calState;
  const today = new Date();
  const todayIso = toIso(today.getFullYear(), today.getMonth() + 1, today.getDate());

  // Update header label
  el.calMonthLabel.textContent = `${IT_MONTHS[month]} ${year}`;

  // Compute period ranges for all tasks once (relative to today)
  const taskRanges = calState.allTasks
    .filter(t => !t.completed && t.plannedPeriod)
    .map(t => {
      const range = getTaskPeriodRange(t);
      return range ? { task: t, start: range[0], end: range[1] } : null;
    })
    .filter(Boolean);

  // Deadline tasks: map iso date → tasks[]
  const deadlineMap = {};
  calState.allTasks.filter(t => !t.completed && t.deadline).forEach(t => {
    if (!deadlineMap[t.deadline]) deadlineMap[t.deadline] = [];
    deadlineMap[t.deadline].push(t);
  });

  // Build day cells
  // Day 1 of this month lands on which ISO day-of-week? (Mon=0 … Sun=6)
  const firstDay = new Date(year, month, 1);
  const firstDow = firstDay.getDay(); // 0=Sun
  const offset   = firstDow === 0 ? 6 : firstDow - 1; // cells to skip before day 1
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  el.calendarGrid.innerHTML = '';

  // Day-of-week headers
  IT_DAYS_SHORT.forEach((d, i) => {
    const h = document.createElement('div');
    h.className = 'cal-dow-header' + (i >= 5 ? ' weekend' : '');
    h.textContent = d;
    el.calendarGrid.appendChild(h);
  });

  // Blank cells before the 1st
  for (let i = 0; i < offset; i++) {
    const blank = document.createElement('div');
    blank.className = 'cal-day cal-day--blank';
    el.calendarGrid.appendChild(blank);
  }

  // Day cells
  for (let day = 1; day <= daysInMonth; day++) {
    const iso  = toIso(year, month + 1, day);
    const dow  = (offset + day - 1) % 7; // 0=Mon … 6=Sun
    const isToday    = iso === todayIso;
    const isSelected = iso === calState.selectedIso;
    const isPast     = iso < todayIso;
    const isWeekend  = dow >= 5;

    // Collect period tasks covering this day
    const periodTasks = taskRanges.filter(r => dayInRange(iso, r.start, r.end)).map(r => r.task);
    // Collect deadline tasks
    const dlTasks = deadlineMap[iso] || [];

    const cell = document.createElement('div');
    cell.className = [
      'cal-day',
      isToday    ? 'cal-day--today'    : '',
      isSelected ? 'cal-day--selected' : '',
      isPast     ? 'cal-day--past'     : '',
      isWeekend  ? 'cal-day--weekend'  : '',
    ].filter(Boolean).join(' ');
    cell.dataset.iso = iso;

    // Period color bands (top strip) — show up to 4 distinct period colors
    const seenPeriods = new Set();
    const bands = periodTasks
      .filter(t => { if (seenPeriods.has(t.plannedPeriod)) return false; seenPeriods.add(t.plannedPeriod); return true; })
      .slice(0, 4);

    const bandsHtml = bands.length > 0
      ? `<div class="cal-day-bands">${bands.map(t => {
          const p = getPeriod(t.plannedPeriod);
          return `<span class="cal-day-band" style="background:${p.color}"></span>`;
        }).join('')}</div>`
      : '';

    // Dot indicators
    const allDots = [
      ...dlTasks.map(t => ({ color: getPeriod(t.plannedPeriod)?.color || '#C03D55', type: 'deadline', title: t.name })),
      ...periodTasks.slice(0, 3).map(t => ({ color: getPeriod(t.plannedPeriod)?.color || '#3548C0', type: 'period', title: t.name })),
    ];
    const MAX_DOTS = 5;
    const shown    = allDots.slice(0, MAX_DOTS);
    const overflow = allDots.length - shown.length;

    const dotsHtml = shown.length > 0
      ? `<div class="cal-day-dots">
          ${shown.map(d =>
            `<span class="cal-dot cal-dot--${d.type}" style="background:${d.color}" title="${escapeHtml(d.title)}"></span>`
          ).join('')}
          ${overflow > 0 ? `<span class="cal-dot-overflow">+${overflow}</span>` : ''}
        </div>`
      : '';

    cell.innerHTML = `
      ${bandsHtml}
      <span class="cal-day-num">${day}</span>
      ${dotsHtml}
    `;

    cell.addEventListener('click', () => selectCalendarDay(iso, periodTasks, dlTasks));
    el.calendarGrid.appendChild(cell);
  }

  // Update day panel if a day is selected
  if (calState.selectedIso) {
    const selPeriod = taskRanges.filter(r => dayInRange(calState.selectedIso, r.start, r.end)).map(r => r.task);
    const selDeadline = deadlineMap[calState.selectedIso] || [];
    renderCalDayPanel(calState.selectedIso, selPeriod, selDeadline);
  } else {
    el.calDayPanel.classList.add('cal-day-panel--empty');
    el.calDayPanelTitle.textContent = 'Seleziona un giorno';
    el.calDayPanelContent.innerHTML =
      '<p class="cal-panel-hint">Clicca su un giorno per vedere i task programmati.</p>';
  }
}

/** Handle a day cell click: highlight and show its tasks */
function selectCalendarDay(iso, periodTasks, dlTasks) {
  calState.selectedIso = iso;
  // Re-highlight selected in the grid
  el.calendarGrid.querySelectorAll('.cal-day').forEach(c => {
    c.classList.toggle('cal-day--selected', c.dataset.iso === iso);
  });
  renderCalDayPanel(iso, periodTasks, dlTasks);
}

/** Render the right-hand day detail panel */
function renderCalDayPanel(iso, periodTasks, dlTasks) {
  el.calDayPanel.classList.remove('cal-day-panel--empty');

  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dayNames = ['Domenica','Lunedì','Martedì','Mercoledì','Giovedì','Venerdì','Sabato'];
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = Math.round((date - today) / 86400000);
  const sub = diff === 0 ? 'Oggi' : diff === 1 ? 'Domani' : diff === -1 ? 'Ieri' : diff < 0 ? `${-diff} giorni fa` : `Fra ${diff} giorni`;

  el.calDayPanelTitle.innerHTML =
    `<span class="cal-panel-dow">${dayNames[date.getDay()]}</span>
     <span class="cal-panel-date">${d} ${IT_MONTHS[m-1]}</span>
     <span class="cal-panel-rel">${sub}</span>`;

  el.calDayPanelContent.innerHTML = '';
  const listNames = {};
  state.lists.forEach(l => { listNames[l.id] = l.name; });

  // Deadline section
  if (dlTasks.length > 0) {
    const sec = buildCalPanelSection('⏰ Scadenze', dlTasks, listNames, true);
    el.calDayPanelContent.appendChild(sec);
  }

  // Period section
  const periodOnly = periodTasks.filter(t => !dlTasks.find(d => d.id === t.id));
  if (periodOnly.length > 0) {
    const sec = buildCalPanelSection('📅 In programma', periodOnly, listNames, false);
    el.calDayPanelContent.appendChild(sec);
  }

  if (dlTasks.length === 0 && periodOnly.length === 0) {
    el.calDayPanelContent.innerHTML =
      '<p class="cal-panel-hint">Nessun task per questo giorno.</p>';
  }
}

/** Build a titled section of task rows for the calendar day panel */
function buildCalPanelSection(title, tasks, listNames, isDeadline) {
  const wrap = document.createElement('div');
  wrap.className = 'cal-panel-section';
  wrap.innerHTML = `<div class="cal-panel-section-title">${title}</div>`;

  tasks.forEach(task => {
    const period = task.plannedPeriod ? getPeriod(task.plannedPeriod) : null;
    const row = document.createElement('div');
    row.className = 'cal-panel-row' + (task.overdue ? ' overdue' : '') + (task.completed ? ' completed' : '');
    row.innerHTML = `
      <span class="cal-panel-dot" style="background:${period ? period.color : '#C03D55'}"></span>
      <div class="cal-panel-row-body">
        <span class="cal-panel-row-name">${escapeHtml(task.name)}</span>
        <div class="cal-panel-row-meta">
          <span class="tl-list-tag">${escapeHtml(listNames[task.listId] || '–')}</span>
          ${period ? `<span class="cal-panel-period-pill" style="color:${period.color};border-color:${period.color}50;background:${period.color}12">${period.label}</span>` : ''}
        </div>
      </div>
    `;
    row.addEventListener('click', () => openList(task.listId, task.id));
    wrap.appendChild(row);
  });

  return wrap;
}


// ============================================================
// UTILS
// ============================================================

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


// ============================================================
// INIT
// ============================================================

function populatePeriodSelect() {
  const selects = [el.detailPeriod, el.taskPeriodQuick].filter(Boolean);
  selects.forEach(sel => {
    sel.innerHTML = '<option value="">— Periodo —</option>';
    const optDaily = document.createElement('option');
    optDaily.value       = DAILY_PERIOD.key;
    optDaily.textContent = '↻ ' + DAILY_PERIOD.label;
    sel.appendChild(optDaily);
    PERIODS.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.key; opt.textContent = p.label;
      sel.appendChild(opt);
    });
  });
}

function init() {
  populatePeriodSelect();
  bindEvents();

  if (firebase && firebase.auth) {
    firebase.auth().onAuthStateChanged(user => {
      if (user) {
        currentUserUid = user.uid;
        if (el.btnLogin)    el.btnLogin.classList.add('hidden');
        if (el.btnLogout)   el.btnLogout.classList.remove('hidden');
        if (el.btnLogoutMobile) el.btnLogoutMobile.classList.remove('hidden');
        if (el.btnLoginMobile)  el.btnLoginMobile.classList.add('hidden');
        if (el.authOverlay) el.authOverlay.classList.add('hidden');
        try { listenLists(); } catch (err) { console.error('listenLists failed', err); }
      } else {
        currentUserUid = null;
        if (unsubscribeLists) { unsubscribeLists(); unsubscribeLists = null; }
        if (state.unsubscribeTasks) { state.unsubscribeTasks(); state.unsubscribeTasks = null; }
        state.lists = []; state.tasks = [];
        renderSidebar(); showHomepage();
        if (el.btnLogin)    el.btnLogin.classList.remove('hidden');
        if (el.btnLogout)   el.btnLogout.classList.add('hidden');
        if (el.btnLogoutMobile) el.btnLogoutMobile.classList.add('hidden');
        if (el.btnLoginMobile)  el.btnLoginMobile.classList.remove('hidden');
        if (el.authOverlay) el.authOverlay.classList.remove('hidden');
      }
    });
  }
}

init();