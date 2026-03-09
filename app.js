// ============================================================
// app.js — Todo List
//
// Architecture:
//   state        → single source of truth (in-memory)
//   Firebase     → persistent storage; listeners keep state in sync
//   render*()    → pure DOM rendering from state
//   bind*()      → attach event listeners once
//
// Firestore data model (new fields added to tasks):
//   deadline: string|null          — ISO date "YYYY-MM-DD"
//   plannedPeriod: string|null     — one of the PERIODS keys
//   plannedPeriodUntil: number|null — ms timestamp: when this period expires
//   overdue: boolean               — true when period elapsed, auto-advanced
// ============================================================


const db = firebase.firestore();


// ============================================================
// PERIODS SYSTEM
// ============================================================

/**
 * PERIODS — ordered list of planning horizons.
 * getEnd() returns the ms timestamp of the end of that period,
 * calculated fresh from TODAY each call.
 * Returning null means "no expiry" (prossima vita).
 *
 * Auto-advance order: oggi → domani → questa_settimana → … → prossima_vita
 * Tasks that reach prossima_vita never auto-advance further.
 */
const PERIODS = [
  {
    key: 'oggi',
    label: 'Oggi',
    color: '#C03D55',
    getEnd: () => endOfDay(new Date())
  },
  {
    key: 'domani',
    label: 'Domani',
    color: '#d45a10',
    getEnd: () => endOfDay(addDays(new Date(), 1))
  },
  {
    key: 'questa_settimana',
    label: 'Questa settimana',
    color: '#b07800',
    getEnd: () => endOfWeek(new Date())
  },
  {
    key: 'prossima_settimana',
    label: 'Prossima settimana',
    color: '#7a6e00',
    getEnd: () => endOfWeek(addDays(endOfWeekDate(new Date()), 1))
  },
  {
    key: 'questo_mese',
    label: 'Questo mese',
    color: '#3548C0',
    getEnd: () => endOfMonth(new Date())
  },
  {
    key: 'prossimo_mese',
    label: 'Prossimo mese',
    color: '#2a6bba',
    getEnd: () => endOfMonth(addMonths(new Date(), 1))
  },
  {
    key: 'prossima_stagione',
    label: 'Prossima stagione',
    color: '#1a8060',
    getEnd: () => endOfNextSeason(new Date())
  },
  {
    key: 'prossimo_anno_scolastico',
    label: 'Prossimo anno scolastico',
    color: '#6040b0',
    getEnd: () => endOfSchoolYear(new Date())
  },
  {
    key: 'prossimi_5_anni',
    label: 'Prossimi 5 anni',
    color: '#7a83b8',
    getEnd: () => endOfDay(addYears(new Date(), 5))
  },
  {
    key: 'prossima_vita',
    label: 'Prossima vita',
    color: '#aaaaaa',
    getEnd: () => null   // never expires
  },
];

const getPeriod    = key => PERIODS.find(p => p.key === key) || null;
const nextPeriodKey = key => {
  const idx = PERIODS.findIndex(p => p.key === key);
  return (idx >= 0 && idx < PERIODS.length - 1) ? PERIODS[idx + 1].key : null;
};


// ============================================================
// DATE HELPERS
// ============================================================

/** End of a given day at 23:59:59.999 (returns ms timestamp) */
function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** Returns a new Date = date + n days */
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** Returns a new Date = date + n months */
function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

/** Returns a new Date = date + n years */
function addYears(date, n) {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + n);
  return d;
}

/** Returns a Date object pointing to the Sunday that ends the ISO week of `date` */
function endOfWeekDate(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun … 6=Sat
  const daysUntilSunday = day === 0 ? 0 : 7 - day;
  d.setDate(d.getDate() + daysUntilSunday);
  return d;
}

/** Returns ms timestamp of the Sunday ending the week of `date` */
function endOfWeek(date) {
  return endOfDay(endOfWeekDate(date));
}

/** Returns ms timestamp of the last day of `date`'s month */
function endOfMonth(date) {
  const d = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return endOfDay(d);
}

/**
 * Returns ms timestamp of the end of the NEXT meteorological season.
 * Seasons: Winter Dec–Feb, Spring Mar–May, Summer Jun–Aug, Autumn Sep–Nov.
 * "Prossima stagione" = the season after the current one.
 */
function endOfNextSeason(date) {
  const m = date.getMonth();
  // Current season index: 0=Winter, 1=Spring, 2=Summer, 3=Autumn
  let cur;
  if (m <= 1 || m === 11) cur = 0;
  else if (m <= 4)        cur = 1;
  else if (m <= 7)        cur = 2;
  else                    cur = 3;

  const next = (cur + 1) % 4;
  // Last month (0-indexed) of each season: Winter=1(Feb), Spring=4(May), Summer=7(Aug), Autumn=10(Nov)
  const lastMonths = [1, 4, 7, 10];
  const endMonth = lastMonths[next];
  let endYear = date.getFullYear();
  if (endMonth < m) endYear += 1; // rolled over into new year
  const lastDay = new Date(endYear, endMonth + 1, 0); // day-0 = last day of endMonth
  return endOfDay(lastDay);
}

/**
 * Returns ms timestamp of June 30 of the current or next Italian school year.
 * School year: Sep 1 → Jun 30.
 * If today is Jul–Aug (between years), the next school year ends Jun 30 next year.
 */
function endOfSchoolYear(date) {
  const y = date.getFullYear();
  const m = date.getMonth(); // 0-indexed
  let endYear;
  if (m >= 8)      endYear = y + 1; // Sep-Dec: new year just started
  else if (m <= 5) endYear = y;     // Jan-Jun: current year ends this June
  else             endYear = y + 1; // Jul-Aug: gap between years
  return endOfDay(new Date(endYear, 5, 30)); // June 30
}

/** Format a ms timestamp as short Italian date "31 mag" */
function formatShortDate(ms) {
  if (!ms) return '';
  const months = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
  const d = new Date(ms);
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

/** Format ISO "YYYY-MM-DD" as "31 mag" or "31 mag 2026" if different year */
function formatDeadline(isoStr) {
  if (!isoStr) return '';
  const [y, m, d] = isoStr.split('-').map(Number);
  const months = ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'];
  const nowYear = new Date().getFullYear();
  return `${d} ${months[m - 1]}${y !== nowYear ? ' ' + y : ''}`;
}

/** True when the ISO deadline date is strictly in the past */
function isDeadlinePast(isoStr) {
  if (!isoStr) return false;
  const [y, m, d] = isoStr.split('-').map(Number);
  return Date.now() > new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}


// ============================================================
// AUTO-ADVANCE OVERDUE TASKS
// ============================================================

/**
 * Called after tasks load from Firestore.
 * For each incomplete task whose plannedPeriodUntil timestamp has passed
 * (and is not already flagged overdue), advance it one step and set overdue=true.
 * overdue=true prevents further automatic advances — the user must act manually.
 */
async function autoAdvanceOverdueTasks(listId) {
  const now = Date.now();
  const batch = db.batch();
  let hasChanges = false;

  state.tasks.forEach(task => {
    if (
      task.overdue ||             // already flagged — don't advance again
      !task.plannedPeriod ||      // no period set
      task.completed ||           // done tasks don't auto-advance
      !task.plannedPeriodUntil || // no expiry stored (e.g. prossima vita)
      now <= task.plannedPeriodUntil // period not yet elapsed
    ) return;

    const nextKey  = nextPeriodKey(task.plannedPeriod);
    const nextObj  = nextKey ? getPeriod(nextKey) : null;
    const nextUntil = nextObj ? nextObj.getEnd() : null;

    const update = {
      overdue: true,
      plannedPeriod: nextKey || task.plannedPeriod, // stay at last period if no next
      plannedPeriodUntil: nextUntil,
    };

    batch.update(tasksRef(listId).doc(task.id), update);
    Object.assign(task, update); // update local state immediately
    hasChanges = true;
  });

  if (hasChanges) {
    await batch.commit();
    renderTaskList();
  }
}


// ============================================================
// STATE
// ============================================================
const state = {
  lists: [],
  activeListId: null,
  tasks: [],
  activeTaskId: null,
  unsubscribeTasks: null
};

let currentUserUid = null;
let unsubscribeLists = null;


// ============================================================
// DOM REFERENCES
// ============================================================
const el = {
  listsNav:             document.getElementById('lists-nav'),
  btnNewList:           document.getElementById('btn-new-list'),
  btnHome:              document.getElementById('btn-home'),
  loading:              document.getElementById('loading'),
  homepage:             document.getElementById('homepage'),
  listView:             document.getElementById('list-view'),
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
  // Planning fields (new)
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

const tasksRef = (listId) => {
  if (!currentUserUid) throw new Error('No authenticated user');
  return db.collection('users').doc(currentUserUid)
    .collection('lists').doc(listId).collection('tasks');
};


// ============================================================
// AUTH
// ============================================================

async function loginWithGoogle() {
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await firebase.auth().signInWithPopup(provider);
  } catch (err) {
    console.error('Login error', err);
    alert(err.message || 'Login failed');
  }
}

async function logoutUser() {
  try { await firebase.auth().signOut(); }
  catch (err) { console.error('Logout error', err); }
}


// ============================================================
// LISTS — CRUD
// ============================================================

async function updateList(listId, data) {
  await listsRef().doc(listId).update(data);
}

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
    name: name.trim(),
    completed: false,
    notes: '',
    order: state.tasks.length,
    deadline: null,
    plannedPeriod: null,
    plannedPeriodUntil: null,
    overdue: false,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

async function updateTask(taskId, data) {
  await tasksRef(state.activeListId).doc(taskId).update(data);
}

async function deleteTask(taskId) {
  await tasksRef(state.activeListId).doc(taskId).delete();
}

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
    renderHomepage();
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
  });
}


// ============================================================
// VIEW MANAGEMENT
// ============================================================

function showHomepage() {
  el.homepage.classList.remove('hidden');
  el.listView.classList.add('hidden');
  state.activeListId = null;
  if (state.unsubscribeTasks) { state.unsubscribeTasks(); state.unsubscribeTasks = null; }
  closeDetailPanel();
  renderSidebar();
  renderHomepage();
}

function openList(listId) {
  state.activeListId = listId;
  const list = state.lists.find(l => l.id === listId);
  if (!list) return showHomepage();
  el.homepage.classList.add('hidden');
  el.listView.classList.remove('hidden');
  el.listTitleInput.value = list.name;
  updateStarButton(list.starred);
  closeDetailPanel();
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
// RENDER — HOMEPAGE CARDS
// ============================================================

function renderHomepage() {
  if (!el.homepage || el.homepage.classList.contains('hidden')) return;
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
    card.innerHTML = `
      <div class="home-card-info">
        <div class="home-card-name">${escapeHtml(list.name)}</div>
        <div class="home-card-count">Clicca per aprire</div>
      </div>
      ${list.starred ? '<div class="home-card-star">★</div>' : ''}
    `;
    card.addEventListener('click', () => openList(list.id));
    el.homeCards.appendChild(card);
  });
}


// ============================================================
// RENDER — TASK LIST
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
    li.className = [
      'task-item',
      task.completed  ? 'completed' : '',
      task.overdue    ? 'overdue'   : '',
    ].filter(Boolean).join(' ');
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

/**
 * Build HTML for the small period pill and deadline chip shown on each task row.
 * Colors come from the PERIODS config; all user data is escaped.
 */
function buildTaskMetaHtml(task, period, deadlinePast) {
  const parts = [];

  if (period) {
    // Show a "!" badge if this task was auto-advanced (overdue)
    const bang = task.overdue ? '<span class="period-bang">!</span>' : '';
    parts.push(
      `<span class="task-period-pill"
         style="background:${period.color}18; color:${period.color}; border-color:${period.color}50"
       >${bang}${period.label}</span>`
    );
  }

  if (task.deadline) {
    const cls = deadlinePast ? 'task-deadline-chip past' : 'task-deadline-chip';
    parts.push(`<span class="${cls}">⏰ ${formatDeadline(task.deadline)}</span>`);
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

  // Deadline
  el.detailDeadline.value = task.deadline || '';
  updateDeadlineStatus(task.deadline);

  // Period
  el.detailPeriod.value = task.plannedPeriod || '';

  // Overdue warning
  if (task.overdue && !task.completed) {
    el.detailOverdueBar.classList.remove('hidden');
    // Find previous period label for the warning message
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

/** Show remaining-days text under the deadline input */
function updateDeadlineStatus(isoStr) {
  if (!el.detailDeadlineStatus) return;
  if (!isoStr) {
    el.detailDeadlineStatus.textContent = '';
    el.detailDeadlineStatus.className = 'deadline-status';
    return;
  }
  if (isDeadlinePast(isoStr)) {
    el.detailDeadlineStatus.textContent = '⚠ Scaduta!';
    el.detailDeadlineStatus.className = 'deadline-status past';
  } else {
    const [y, m, d] = isoStr.split('-').map(Number);
    const diff = Math.ceil((new Date(y, m - 1, d) - new Date()) / 86400000);
    el.detailDeadlineStatus.textContent =
      diff === 0 ? 'Scade oggi' : diff === 1 ? 'Scade domani' : `Scade tra ${diff} giorni`;
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

function showModal() {
  el.modalBackdrop.classList.remove('hidden');
  el.modalListName.value = '';
  setTimeout(() => el.modalListName.focus(), 50);
}

function hideModal() {
  el.modalBackdrop.classList.add('hidden');
}

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
    item.addEventListener('dragstart', e => {
      dragSrcTask = item;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      items.forEach(i => i.classList.remove('drag-over'));
      dragSrcTask = null;
    });
    item.addEventListener('dragover', e => {
      e.preventDefault();
      items.forEach(i => i.classList.remove('drag-over'));
      if (dragSrcTask && dragSrcTask !== item) item.classList.add('drag-over');
    });
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
  items.forEach((item, idx) => {
    batch.update(tasksRef(state.activeListId).doc(item.dataset.id), { order: idx });
  });
  await batch.commit();
}


// ============================================================
// DRAG AND DROP — SIDEBAR
// ============================================================
let dragSrcList = null;

function bindSidebarDragDrop() {
  const items = el.listsNav.querySelectorAll('.nav-item');
  items.forEach(item => {
    item.addEventListener('dragstart', e => {
      dragSrcList = item;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => item.style.opacity = '0.5', 0);
    });
    item.addEventListener('dragend', () => {
      item.style.opacity = '';
      items.forEach(i => i.style.borderTop = '');
      dragSrcList = null;
    });
    item.addEventListener('dragover', e => {
      e.preventDefault();
      items.forEach(i => i.style.borderTop = '');
      if (dragSrcList && dragSrcList !== item) item.style.borderTop = '2px solid var(--yellow)';
    });
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
  items.forEach((item, idx) => {
    batch.update(listsRef().doc(item.dataset.id), { order: idx });
  });
  await batch.commit();
}


// ============================================================
// BIND GLOBAL EVENTS
// ============================================================

function bindEvents() {

  // New list
  el.btnNewList.addEventListener('click', showModal);
  el.btnNewListHome.addEventListener('click', showModal);
  el.btnHome.addEventListener('click', showHomepage);

  // Modal
  el.btnModalCancel.addEventListener('click', hideModal);
  el.btnModalCreate.addEventListener('click', handleCreateList);
  el.modalListName.addEventListener('keydown', e => { if (e.key === 'Enter') handleCreateList(); });
  el.modalBackdrop.addEventListener('click', e => { if (e.target === el.modalBackdrop) hideModal(); });

  // List title
  el.listTitleInput.addEventListener('blur', () => {
    const name = el.listTitleInput.value.trim();
    if (name && state.activeListId) updateList(state.activeListId, { name });
  });
  el.listTitleInput.addEventListener('keydown', e => { if (e.key === 'Enter') el.listTitleInput.blur(); });

  // Star
  el.btnStar.addEventListener('click', async () => {
    if (!state.activeListId) return;
    const list = state.lists.find(l => l.id === state.activeListId);
    const newStarred = !list.starred;
    const batch = db.batch();
    if (newStarred) state.lists.forEach(l => {
      if (l.starred) batch.update(listsRef().doc(l.id), { starred: false });
    });
    batch.update(listsRef().doc(state.activeListId), { starred: newStarred });
    await batch.commit();
    updateStarButton(newStarred);
  });

  // Delete list
  el.btnDeleteList.addEventListener('click', async () => {
    if (!state.activeListId) return;
    if (!confirm('Eliminare questa lista e tutti i suoi task?')) return;
    const listId = state.activeListId;
    showHomepage();
    await deleteList(listId);
  });

  // Add task
  el.btnAddTask.addEventListener('click', () => {
    addTask(el.taskInput.value); el.taskInput.value = ''; el.taskInput.focus();
  });
  el.taskInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { addTask(el.taskInput.value); el.taskInput.value = ''; }
  });

  // Detail: close
  el.btnCloseDetail.addEventListener('click', closeDetailPanel);
  el.overlay.addEventListener('click', closeDetailPanel);

  // Detail: notes
  el.detailNotes.addEventListener('input', () => {
    if (state.activeTaskId) saveNotesDebounced(state.activeTaskId, el.detailNotes.value);
  });

  // Detail: mark complete/incomplete
  el.btnComplete.addEventListener('click', () => {
    if (!state.activeTaskId) return;
    const task = state.tasks.find(t => t.id === state.activeTaskId);
    if (!task) return;
    updateTask(state.activeTaskId, { completed: !task.completed });
    el.btnComplete.textContent = !task.completed ? 'Segna incompleto' : 'Segna completo';
  });

  // Detail: delete
  el.btnDeleteTask.addEventListener('click', async () => {
    if (!state.activeTaskId) return;
    if (!confirm('Eliminare questo task?')) return;
    const taskId = state.activeTaskId;
    closeDetailPanel();
    await deleteTask(taskId);
  });

  // -------------------------------------------------------
  // DEADLINE — changing it clears the overdue flag
  // -------------------------------------------------------
  el.detailDeadline.addEventListener('change', () => {
    if (!state.activeTaskId) return;
    const val = el.detailDeadline.value; // "YYYY-MM-DD" or ""
    updateDeadlineStatus(val);
    updateTask(state.activeTaskId, { deadline: val || null, overdue: false });
  });

  el.btnClearDeadline.addEventListener('click', () => {
    if (!state.activeTaskId) return;
    el.detailDeadline.value = '';
    updateDeadlineStatus('');
    updateTask(state.activeTaskId, { deadline: null, overdue: false });
  });

  // -------------------------------------------------------
  // PLANNED PERIOD — changing it recalculates expiry and clears overdue
  // -------------------------------------------------------
  el.detailPeriod.addEventListener('change', () => {
    if (!state.activeTaskId) return;
    const key    = el.detailPeriod.value || null;
    const period = key ? getPeriod(key) : null;
    const until  = period ? period.getEnd() : null;

    el.detailOverdueBar.classList.add('hidden');

    updateTask(state.activeTaskId, {
      plannedPeriod: key,
      plannedPeriodUntil: until,
      overdue: false
    });
  });

  // Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!el.modalBackdrop.classList.contains('hidden')) hideModal();
      else if (!el.detailPanel.classList.contains('hidden')) closeDetailPanel();
    }
  });

  // Auth
  if (el.btnLogin)       el.btnLogin.addEventListener('click', loginWithGoogle);
  if (el.btnLogout)      el.btnLogout.addEventListener('click', logoutUser);
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

/** Populate the <select> with all period options */
function populatePeriodSelect() {
  el.detailPeriod.innerHTML = '<option value="">— Nessun periodo —</option>';
  PERIODS.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.key;
    opt.textContent = p.label;
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