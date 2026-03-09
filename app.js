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

const PERIODS = [
  { key: 'oggi',                     label: 'Oggi',                      color: '#C03D55', getEnd: () => endOfDay(new Date()) },
  { key: 'domani',                   label: 'Domani',                    color: '#d45a10', getEnd: () => endOfDay(addDays(new Date(), 1)) },
  { key: 'questa_settimana',         label: 'Questa settimana',          color: '#b07800', getEnd: () => endOfWeek(new Date()) },
  { key: 'prossima_settimana',       label: 'Prossima settimana',        color: '#7a6e00', getEnd: () => endOfWeek(addDays(endOfWeekDate(new Date()), 1)) },
  { key: 'questo_mese',              label: 'Questo mese',               color: '#3548C0', getEnd: () => endOfMonth(new Date()) },
  { key: 'prossimo_mese',            label: 'Prossimo mese',             color: '#2a6bba', getEnd: () => endOfMonth(addMonths(new Date(), 1)) },
  { key: 'prossima_stagione',        label: 'Prossima stagione',         color: '#1a8060', getEnd: () => endOfNextSeason(new Date()) },
  { key: 'prossimo_anno_scolastico', label: 'Prossimo anno scolastico',  color: '#6040b0', getEnd: () => endOfSchoolYear(new Date()) },
  { key: 'prossimi_5_anni',          label: 'Prossimi 5 anni',           color: '#7a83b8', getEnd: () => endOfDay(addYears(new Date(), 5)) },
  { key: 'prossima_vita',            label: 'Prossima vita',             color: '#aaaaaa', getEnd: () => null },
];

const getPeriod     = key => PERIODS.find(p => p.key === key) || null;
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
 * Sort an array of tasks by: period index → deadline → name.
 * Returns a NEW sorted array (does not mutate).
 */
function sortTasksBySchedule(tasks) {
  return [...tasks].sort((a, b) => {
    const pa = periodSortKey(a), pb = periodSortKey(b);
    if (pa !== pb) return pa - pb;
    const da = deadlineSortKey(a), db2 = deadlineSortKey(b);
    if (da !== db2) return da - db2;
    return (a.name || '').localeCompare(b.name || '');
  });
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


// ============================================================
// AUTO-ADVANCE OVERDUE TASKS
// ============================================================

async function autoAdvanceOverdueTasks(listId) {
  const now = Date.now();
  const batch = db.batch();
  let hasChanges = false;

  state.tasks.forEach(task => {
    if (task.overdue || !task.plannedPeriod || task.completed ||
        !task.plannedPeriodUntil || now <= task.plannedPeriodUntil) return;

    const nextKey  = nextPeriodKey(task.plannedPeriod);
    const nextObj  = nextKey ? getPeriod(nextKey) : null;
    const update   = {
      overdue: true,
      plannedPeriod: nextKey || task.plannedPeriod,
      plannedPeriodUntil: nextObj ? nextObj.getEnd() : null,
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


// ============================================================
// DOM REFERENCES
// ============================================================
const el = {
  listsNav:             document.getElementById('lists-nav'),
  btnNewList:           document.getElementById('btn-new-list'),
  btnHome:              document.getElementById('btn-home'),
  btnTimeline:          document.getElementById('btn-timeline'),
  loading:              document.getElementById('loading'),
  homepage:             document.getElementById('homepage'),
  listView:             document.getElementById('list-view'),
  timelineView:         document.getElementById('timeline-view'),
  timelineContent:      document.getElementById('timeline-content'),
  toggleShowCompleted:  document.getElementById('toggle-show-completed'),
  homeCards:            document.getElementById('home-cards'),
  btnNewListHome:       document.getElementById('btn-new-list-home'),
  listTitleInput:       document.getElementById('list-title-input'),
  btnStar:              document.getElementById('btn-star'),
  btnDeleteList:        document.getElementById('btn-delete-list'),
  taskInput:            document.getElementById('task-input'),
  btnAddTask:           document.getElementById('btn-add-task'),
  taskList:             document.getElementById('task-list'),
  detailPanel:          document.getElementById('detail-panel'),
  detailTitle:          document.getElementById('detail-task-title'),
  detailNotes:          document.getElementById('detail-notes'),
  btnCloseDetail:       document.getElementById('btn-close-detail'),
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
  authOverlay:          document.getElementById('auth-overlay'),
  detailDeadline:       document.getElementById('detail-deadline'),
  detailPeriod:         document.getElementById('detail-period'),
  detailDeadlineStatus: document.getElementById('detail-deadline-status'),
  detailOverdueBar:     document.getElementById('detail-overdue-bar'),
  btnClearDeadline:     document.getElementById('btn-clear-deadline'),
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

async function addTask(name) {
  if (!state.activeListId || !name.trim()) return;
  await tasksRef(state.activeListId).add({
    name: name.trim(), completed: false, notes: '', order: state.tasks.length,
    deadline: null, plannedPeriod: null, plannedPeriodUntil: null, overdue: false,
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

    if (!el.loading.classList.contains('hidden')) {
      el.loading.classList.add('hidden');
      const starred = state.lists.find(l => l.starred);
      if (starred) openList(starred.id); else showHomepage();
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
  el.listsNav.innerHTML = '';
  state.lists.forEach(list => {
    const li = document.createElement('li');
    li.className = 'nav-item' + (list.id === state.activeListId ? ' active' : '');
    li.dataset.id = list.id;
    li.draggable = true;
    li.innerHTML = `
      <span class="nav-drag-handle">⠿</span>
      <span class="nav-item-name">${escapeHtml(list.name)}</span>
      <span class="nav-item-star ${list.starred ? 'starred' : ''}">${list.starred ? '★' : ''}</span>
    `;
    li.addEventListener('click', () => openList(list.id));
    el.listsNav.appendChild(li);
  });
  bindSidebarDragDrop();
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

  if (state.lists.length === 0) {
    el.homeCards.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📋</div>
        <div class="empty-state-text">Nessuna lista.<br>Creane una per iniziare!</div>
      </div>`;
    return;
  }

  state.lists.forEach(list => {
    const card = document.createElement('div');
    card.className = 'home-card';
    card.dataset.listId = list.id;
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
      ${period ? `<span class="home-card-task-pill"
          style="color:${period.color};border-color:${period.color}50;background:${period.color}12"
        >${period.label}</span>` : ''}
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
  const filtered = showCompleted ? allTasks : allTasks.filter(t => !t.completed);
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

  // Group tasks by plannedPeriod key (null → 'none')
  const groups = new Map(); // key → { period|null, tasks[] }

  sorted.forEach(task => {
    const key = task.plannedPeriod || '__none__';
    if (!groups.has(key)) {
      groups.set(key, {
        period: task.plannedPeriod ? getPeriod(task.plannedPeriod) : null,
        tasks: []
      });
    }
    groups.get(key).tasks.push(task);
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

      const row = document.createElement('div');
      row.className = [
        'timeline-task-row',
        task.completed ? 'completed' : '',
        task.overdue   ? 'overdue'   : '',
      ].filter(Boolean).join(' ');

      row.innerHTML = `
        <span class="tl-check ${task.completed ? 'checked' : ''}"></span>
        <div class="tl-body">
          <span class="tl-name">${escapeHtml(task.name)}</span>
          <div class="tl-meta">
            <span class="tl-list-tag">${escapeHtml(listName)}</span>
            ${task.deadline ? `<span class="tl-deadline ${deadlinePast ? 'past' : ''}">⏰ ${formatDeadline(task.deadline)}</span>` : ''}
            ${task.overdue  ? '<span class="tl-overdue-badge">!</span>' : ''}
          </div>
        </div>
      `;

      // Checkbox: toggle complete directly from timeline
      row.querySelector('.tl-check').addEventListener('click', async e => {
        e.stopPropagation();
        await updateTaskInList(task.listId, task.id, { completed: !task.completed });
        renderTimeline(); // re-render to reflect change
      });

      // Row click: navigate to the list and open the detail panel
      row.addEventListener('click', () => openList(task.listId, task.id));

      list.appendChild(row);
    });

    section.appendChild(list);
    el.timelineContent.appendChild(section);
  });
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

  state.tasks.forEach(task => {
    const period       = task.plannedPeriod ? getPeriod(task.plannedPeriod) : null;
    const deadlinePast = isDeadlinePast(task.deadline);

    const li = document.createElement('li');
    li.className = ['task-item', task.completed ? 'completed' : '', task.overdue ? 'overdue' : '']
      .filter(Boolean).join(' ');
    li.dataset.id = task.id;
    li.draggable = true;

    li.innerHTML = `
      <span class="task-drag-handle">⠿</span>
      <span class="task-check ${task.completed ? 'checked' : ''}" data-action="check"></span>
      <div class="task-body">
        <span class="task-name">${escapeHtml(task.name)}</span>
        ${buildTaskMetaHtml(task, period, deadlinePast)}
      </div>
      ${task.notes ? '<span class="task-has-notes" title="Ha note"></span>' : ''}
    `;

    li.querySelector('[data-action="check"]').addEventListener('click', e => {
      e.stopPropagation();
      updateTask(task.id, { completed: !task.completed });
    });
    li.addEventListener('click', () => openDetailPanel(task.id));
    el.taskList.appendChild(li);
  });

  bindTaskDragDrop();
}

function buildTaskMetaHtml(task, period, deadlinePast) {
  const parts = [];
  if (period) {
    const bang = task.overdue ? '<span class="period-bang">!</span>' : '';
    parts.push(`<span class="task-period-pill"
      style="background:${period.color}18;color:${period.color};border-color:${period.color}50"
    >${bang}${period.label}</span>`);
  }
  if (task.deadline) {
    parts.push(`<span class="task-deadline-chip ${deadlinePast ? 'past' : ''}">⏰ ${formatDeadline(task.deadline)}</span>`);
  }
  return parts.length > 0 ? `<div class="task-meta">${parts.join('')}</div>` : '';
}


// ============================================================
// DETAIL PANEL
// ============================================================

function openDetailPanel(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;

  state.activeTaskId = taskId;
  el.detailTitle.textContent = task.name;
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

  el.detailPanel.classList.remove('hidden');
  el.detailPanel.classList.add('open');
  el.overlay.classList.remove('hidden');
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

  el.btnModalCancel.addEventListener('click', hideModal);
  el.btnModalCreate.addEventListener('click', handleCreateList);
  el.modalListName.addEventListener('keydown', e => { if (e.key === 'Enter') handleCreateList(); });
  el.modalBackdrop.addEventListener('click', e => { if (e.target === el.modalBackdrop) hideModal(); });

  el.listTitleInput.addEventListener('blur', () => {
    const name = el.listTitleInput.value.trim();
    if (name && state.activeListId) updateList(state.activeListId, { name });
  });
  el.listTitleInput.addEventListener('keydown', e => { if (e.key === 'Enter') el.listTitleInput.blur(); });

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

  el.btnAddTask.addEventListener('click', () => { addTask(el.taskInput.value); el.taskInput.value = ''; el.taskInput.focus(); });
  el.taskInput.addEventListener('keydown', e => { if (e.key === 'Enter') { addTask(el.taskInput.value); el.taskInput.value = ''; } });

  el.btnCloseDetail.addEventListener('click', closeDetailPanel);
  el.overlay.addEventListener('click', closeDetailPanel);

  el.detailNotes.addEventListener('input', () => { if (state.activeTaskId) saveNotesDebounced(state.activeTaskId, el.detailNotes.value); });

  el.btnComplete.addEventListener('click', () => {
    if (!state.activeTaskId) return;
    const task = state.tasks.find(t => t.id === state.activeTaskId);
    if (!task) return;
    updateTask(state.activeTaskId, { completed: !task.completed });
    el.btnComplete.textContent = !task.completed ? 'Segna incompleto' : 'Segna completo';
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

  // Timeline: re-render when "show completed" toggle changes
  el.toggleShowCompleted.addEventListener('change', renderTimeline);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!el.modalBackdrop.classList.contains('hidden')) hideModal();
      else if (!el.detailPanel.classList.contains('hidden')) closeDetailPanel();
    }
  });

  if (el.btnLogin)        el.btnLogin.addEventListener('click', loginWithGoogle);
  if (el.btnLogout)       el.btnLogout.addEventListener('click', logoutUser);
  if (el.btnOverlayLogin) el.btnOverlayLogin.addEventListener('click', loginWithGoogle);
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
  el.detailPeriod.innerHTML = '<option value="">— Nessun periodo —</option>';
  PERIODS.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.key; opt.textContent = p.label;
    el.detailPeriod.appendChild(opt);
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
        if (el.authOverlay) el.authOverlay.classList.remove('hidden');
      }
    });
  }
}

init();