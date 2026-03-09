// ============================================================
// app.js — Hot Planet Todo
//
// Architecture overview:
//   state        → single source of truth (in-memory)
//   Firebase     → persistent storage; listeners keep state in sync
//   render*()    → pure DOM rendering from state
//   bind*()      → attach event listeners once
//
// Firestore data model:
//   /lists/{listId}
//     name: string
//     starred: boolean
//     order: number
//
//   /lists/{listId}/tasks/{taskId}
//     name: string
//     completed: boolean
//     notes: string
//     order: number
// ============================================================


// Firestore DB instance globale
const db = firebase.firestore();

// Per usare metodi Firestore, accedi tramite firebase.firestore()
// Esempio: firebase.firestore().collection('lists')


// ----------------------------------------------------------
// STATE
// ----------------------------------------------------------
const state = {
  lists: [],          // Array of { id, name, starred, order }
  activeListId: null, // Currently open list
  tasks: [],          // Tasks of the active list
  activeTaskId: null, // Task open in detail panel
  unsubscribeTasks: null // Cleanup fn for task listener
};

// Current signed-in user's uid (null when signed out)
let currentUserUid = null;
// Unsubscribe for lists listener
let unsubscribeLists = null;


// ----------------------------------------------------------
// DOM REFERENCES
// ----------------------------------------------------------
const el = {
  // Sidebar
  listsNav:       document.getElementById('lists-nav'),
  btnNewList:     document.getElementById('btn-new-list'),
  btnHome:        document.getElementById('btn-home'),

  // Main sections
  loading:        document.getElementById('loading'),
  homepage:       document.getElementById('homepage'),
  listView:       document.getElementById('list-view'),
  homeCards:      document.getElementById('home-cards'),
  btnNewListHome: document.getElementById('btn-new-list-home'),

  // List header
  listTitleInput: document.getElementById('list-title-input'),
  btnStar:        document.getElementById('btn-star'),
  btnDeleteList:  document.getElementById('btn-delete-list'),
  taskInput:      document.getElementById('task-input'),
  btnAddTask:     document.getElementById('btn-add-task'),

  // Task list
  taskList:       document.getElementById('task-list'),

  // Detail panel
  detailPanel:    document.getElementById('detail-panel'),
  detailTitle:    document.getElementById('detail-task-title'),
  detailNotes:    document.getElementById('detail-notes'),
  btnCloseDetail: document.getElementById('btn-close-detail'),
  btnComplete:    document.getElementById('btn-complete-task'),
  btnDeleteTask:  document.getElementById('btn-delete-task'),
  overlay:        document.getElementById('overlay'),

  // Modal
  modalBackdrop:  document.getElementById('modal-backdrop'),
  modalListName:  document.getElementById('modal-list-name'),
  btnModalCancel: document.getElementById('btn-modal-cancel'),
  btnModalCreate: document.getElementById('btn-modal-create'),
  // Auth buttons (added to index.html)
  btnLogin:       document.getElementById('btn-login'),
  btnLogout:      document.getElementById('btn-logout'),
  btnOverlayLogin: document.getElementById('overlay-login'),
  authOverlay:     document.getElementById('auth-overlay'),
};


// ----------------------------------------------------------
// FIREBASE HELPERS
// ----------------------------------------------------------


/** Reference to the current user's /lists collection (v8 compat)
 *  Data stored under: users/{uid}/lists/{listId}/tasks/{taskId}
 */
const listsRef = () => {
  if (!currentUserUid) throw new Error('No authenticated user');
  return db.collection('users').doc(currentUserUid).collection('lists');
};

/** Reference to tasks sub-collection of a given list (v8 compat) */
const tasksRef = (listId) => {
  if (!currentUserUid) throw new Error('No authenticated user');
  return db.collection('users').doc(currentUserUid).collection('lists').doc(listId).collection('tasks');
};

// ----------------------------------------------------------
// AUTH (Firebase v8 compat)
// ----------------------------------------------------------

/** Login with Google using a popup; forces account chooser */
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

/** Sign out current user */
async function logoutUser() {
  try {
    await firebase.auth().signOut();
  } catch (err) {
    console.error('Logout error', err);
    alert(err.message || 'Logout failed');
  }
}


// ----------------------------------------------------------
// LISTS — CRUD
// ----------------------------------------------------------

/** Create a new list in Firestore (v8 compat) */
async function createList(name) {
  const order = state.lists.length; // append at end
  await listsRef().add({ name, starred: false, order, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
}

/** Update a list field (name, starred, order, etc.) */
async function updateList(listId, data) {
  await listsRef().doc(listId).update(data);
}

/** Delete a list and all its tasks */
async function deleteList(listId) {
  // Delete all tasks first (v8 compat)
  const snapshot = await tasksRef(listId).get();
  const batch = db.batch();
  snapshot.forEach(d => batch.delete(d.ref));
  batch.delete(listsRef().doc(listId));
  await batch.commit();
}


// ----------------------------------------------------------
// TASKS — CRUD
// ----------------------------------------------------------

/** Add a task to the active list (v8 compat) */
async function addTask(name) {
  if (!state.activeListId || !name.trim()) return;
  const order = state.tasks.length;
  await tasksRef(state.activeListId).add({
    name: name.trim(), completed: false, notes: '', order, createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

/** Update a task field */
async function updateTask(taskId, data) {
  await tasksRef(state.activeListId).doc(taskId).update(data);
}

/** Delete a task */
async function deleteTask(taskId) {
  await tasksRef(state.activeListId).doc(taskId).delete();
}

/** Save notes for a task (debounced) */
let notesTimer;
function saveNotesDebounced(taskId, notes) {
  clearTimeout(notesTimer);
  notesTimer = setTimeout(() => updateTask(taskId, { notes }), 600);
}


// ----------------------------------------------------------
// REALTIME LISTENERS
// ----------------------------------------------------------

/** Listen to the /lists collection and keep state.lists in sync */
function listenLists() {
  // Ensure a user is signed in
  if (!currentUserUid) return;

  // Keep reference to unsubscribe so we can stop listening on sign-out
  if (unsubscribeLists) { unsubscribeLists(); unsubscribeLists = null; }
  unsubscribeLists = listsRef().orderBy('order').onSnapshot(snap => {
    state.lists = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderSidebar();
    renderHomepage();

    // Initial routing: if loading, decide which view to show
    if (!el.loading.classList.contains('hidden')) {
      el.loading.classList.add('hidden');
      const starred = state.lists.find(l => l.starred);
      if (starred) {
        openList(starred.id);
      } else {
        showHomepage();
      }
    }
  });
}

/** Listen to tasks of the active list */
function listenTasks(listId) {
  // Unsubscribe from previous list's tasks
  if (state.unsubscribeTasks) state.unsubscribeTasks();

  state.unsubscribeTasks = tasksRef(listId)
    .orderBy('order')
    .onSnapshot(snap => {
      state.tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderTaskList();
    });
}


// ----------------------------------------------------------
// VIEW MANAGEMENT
// ----------------------------------------------------------

function showHomepage() {
  el.homepage.classList.remove('hidden');
  el.listView.classList.add('hidden');
  state.activeListId = null;
  if (state.unsubscribeTasks) { state.unsubscribeTasks(); state.unsubscribeTasks = null; }
  closeDetailPanel();
  renderSidebar(); // remove active state
  renderHomepage();
}

function openList(listId) {
  state.activeListId = listId;
  const list = state.lists.find(l => l.id === listId);
  if (!list) return showHomepage();

  el.homepage.classList.add('hidden');
  el.listView.classList.remove('hidden');

  // Populate header
  el.listTitleInput.value = list.name;
  updateStarButton(list.starred);
  closeDetailPanel();

  // Start task listener
  listenTasks(listId);
  renderSidebar();
}

function updateStarButton(isStarred) {
  el.btnStar.textContent = isStarred ? '★' : '☆';
  el.btnStar.classList.toggle('starred', isStarred);
  el.btnStar.title = isStarred ? 'Unstar list' : 'Star this list (opens by default)';
}


// ----------------------------------------------------------
// RENDER — SIDEBAR
// ----------------------------------------------------------

function renderSidebar() {
  el.listsNav.innerHTML = '';
  state.lists.forEach(list => {
    const li = document.createElement('li');
    li.className = 'nav-item' + (list.id === state.activeListId ? ' active' : '');
    li.dataset.id = list.id;
    li.draggable = true;
    li.innerHTML = `
      <span class="nav-drag-handle" title="Drag to reorder">⠿</span>
      <span class="nav-item-name">${escapeHtml(list.name)}</span>
      <span class="nav-item-star ${list.starred ? 'starred' : ''}" title="${list.starred ? 'Starred' : ''}">
        ${list.starred ? '★' : ''}
      </span>
    `;
    li.addEventListener('click', () => openList(list.id));
    el.listsNav.appendChild(li);
  });

  bindSidebarDragDrop();
}


// ----------------------------------------------------------
// RENDER — HOMEPAGE CARDS
// ----------------------------------------------------------

function renderHomepage() {
  if (!el.homepage || el.homepage.classList.contains('hidden')) return;
  el.homeCards.innerHTML = '';

  if (state.lists.length === 0) {
    el.homeCards.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📋</div>
        <div class="empty-state-text">No lists yet.<br>Create one to get started!</div>
      </div>`;
    return;
  }

  state.lists.forEach(list => {
    const card = document.createElement('div');
    card.className = 'home-card';
    card.innerHTML = `
      <div class="home-card-info">
        <div class="home-card-name">${escapeHtml(list.name)}</div>
        <div class="home-card-count">Click to open</div>
      </div>
      ${list.starred ? '<div class="home-card-star" title="Starred — opens on startup">★</div>' : ''}
    `;
    card.addEventListener('click', () => openList(list.id));
    el.homeCards.appendChild(card);
  });
}


// ----------------------------------------------------------
// RENDER — TASK LIST
// ----------------------------------------------------------

function renderTaskList() {
  el.taskList.innerHTML = '';

  if (state.tasks.length === 0) {
    el.taskList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">✓</div>
        <div class="empty-state-text">All clear! Add your first task above.</div>
      </div>`;
    return;
  }

  state.tasks.forEach(task => {
    const li = document.createElement('li');
    li.className = 'task-item' + (task.completed ? ' completed' : '');
    li.dataset.id = task.id;
    li.draggable = true;
    li.setAttribute('role', 'listitem');
    li.innerHTML = `
      <span class="task-drag-handle" title="Drag to reorder">⠿</span>
      <span class="task-check ${task.completed ? 'checked' : ''}" data-action="check" title="Toggle complete"></span>
      <span class="task-name">${escapeHtml(task.name)}</span>
      ${task.notes ? '<span class="task-has-notes" title="Has notes"></span>' : ''}
    `;

    // Click on checkbox toggles completion
    li.querySelector('[data-action="check"]').addEventListener('click', e => {
      e.stopPropagation();
      updateTask(task.id, { completed: !task.completed });
    });

    // Click anywhere else opens detail panel
    li.addEventListener('click', () => openDetailPanel(task.id));

    el.taskList.appendChild(li);
  });

  bindTaskDragDrop();
}


// ----------------------------------------------------------
// DETAIL PANEL
// ----------------------------------------------------------

function openDetailPanel(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;

  state.activeTaskId = taskId;
  el.detailTitle.textContent = task.name;
  el.detailNotes.value = task.notes || '';

  // Toggle complete button label
  el.btnComplete.textContent = task.completed ? 'Mark incomplete' : 'Mark complete';

  el.detailPanel.classList.remove('hidden');
  el.detailPanel.classList.add('open');
  el.overlay.classList.remove('hidden');

  el.detailNotes.focus();
}

function closeDetailPanel() {
  state.activeTaskId = null;
  el.detailPanel.classList.remove('open');
  el.overlay.classList.add('hidden');
  // Re-hide after transition
  setTimeout(() => el.detailPanel.classList.add('hidden'), 310);
}


// ----------------------------------------------------------
// MODAL (new list)
// ----------------------------------------------------------

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
    name, starred: false, order: state.lists.length, createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  openList(docRef.id);
}


// ----------------------------------------------------------
// DRAG AND DROP — TASK LIST
// ----------------------------------------------------------
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
      e.dataTransfer.dropEffect = 'move';
      items.forEach(i => i.classList.remove('drag-over'));
      if (dragSrcTask && dragSrcTask !== item) {
        item.classList.add('drag-over');
      }
    });

    item.addEventListener('drop', e => {
      e.preventDefault();
      if (!dragSrcTask || dragSrcTask === item) return;
      item.classList.remove('drag-over');

      // Reorder in DOM
      const allItems = [...el.taskList.querySelectorAll('.task-item')];
      const srcIdx = allItems.indexOf(dragSrcTask);
      const dstIdx = allItems.indexOf(item);

      if (srcIdx < dstIdx) {
        item.after(dragSrcTask);
      } else {
        item.before(dragSrcTask);
      }

      // Persist new order to Firestore
      persistTaskOrder();
    });
  });
}

/** Read current DOM order and save `order` field for each task */
async function persistTaskOrder() {
  const items = [...el.taskList.querySelectorAll('.task-item')];
  const batch = db.batch();
  items.forEach((item, idx) => {
    const taskId = item.dataset.id;
    batch.update(tasksRef(state.activeListId).doc(taskId), { order: idx });
  });
  await batch.commit();
}


// ----------------------------------------------------------
// DRAG AND DROP — SIDEBAR (list reordering)
// ----------------------------------------------------------
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
      e.dataTransfer.dropEffect = 'move';
      items.forEach(i => i.style.borderTop = '');
      if (dragSrcList && dragSrcList !== item) {
        item.style.borderTop = '2px solid var(--yellow)';
      }
    });

    item.addEventListener('drop', e => {
      e.preventDefault();
      items.forEach(i => i.style.borderTop = '');
      if (!dragSrcList || dragSrcList === item) return;

      const allItems = [...el.listsNav.querySelectorAll('.nav-item')];
      const srcIdx = allItems.indexOf(dragSrcList);
      const dstIdx = allItems.indexOf(item);

      if (srcIdx < dstIdx) item.after(dragSrcList);
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


// ----------------------------------------------------------
// BIND GLOBAL EVENT LISTENERS (called once)
// ----------------------------------------------------------

function bindEvents() {

  // --- New list buttons ---
  el.btnNewList.addEventListener('click', showModal);
  el.btnNewListHome.addEventListener('click', showModal);

  // --- Home button ---
  el.btnHome.addEventListener('click', showHomepage);

  // --- Modal ---
  el.btnModalCancel.addEventListener('click', hideModal);
  el.btnModalCreate.addEventListener('click', handleCreateList);
  el.modalListName.addEventListener('keydown', e => { if (e.key === 'Enter') handleCreateList(); });
  el.modalBackdrop.addEventListener('click', e => { if (e.target === el.modalBackdrop) hideModal(); });

  // --- List title (rename on blur/enter) ---
  el.listTitleInput.addEventListener('blur', () => {
    const name = el.listTitleInput.value.trim();
    if (name && state.activeListId) updateList(state.activeListId, { name });
  });
  el.listTitleInput.addEventListener('keydown', e => { if (e.key === 'Enter') el.listTitleInput.blur(); });

  // --- Star / unstar ---
  el.btnStar.addEventListener('click', async () => {
    if (!state.activeListId) return;
    const list = state.lists.find(l => l.id === state.activeListId);
    const newStarred = !list.starred;

    // Only one list can be starred at a time — unstar all others first
    const batch = db.batch();
    if (newStarred) {
      state.lists.forEach(l => {
        if (l.starred) batch.update(listsRef().doc(l.id), { starred: false });
      });
    }
    batch.update(listsRef().doc(state.activeListId), { starred: newStarred });
    await batch.commit();

    updateStarButton(newStarred);
  });

  // --- Delete list ---
  el.btnDeleteList.addEventListener('click', async () => {
    if (!state.activeListId) return;
    if (!confirm('Delete this list and all its tasks? This cannot be undone.')) return;
    const listId = state.activeListId;
    showHomepage();
    await deleteList(listId);
  });

  // --- Add task ---
  el.btnAddTask.addEventListener('click', () => {
    addTask(el.taskInput.value);
    el.taskInput.value = '';
    el.taskInput.focus();
  });

  el.taskInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      addTask(el.taskInput.value);
      el.taskInput.value = '';
    }
  });

  // --- Detail panel: close ---
  el.btnCloseDetail.addEventListener('click', closeDetailPanel);
  el.overlay.addEventListener('click', closeDetailPanel);

  // --- Detail panel: notes auto-save ---
  el.detailNotes.addEventListener('input', () => {
    if (state.activeTaskId) saveNotesDebounced(state.activeTaskId, el.detailNotes.value);
  });

  // --- Detail panel: mark complete ---
  el.btnComplete.addEventListener('click', () => {
    if (!state.activeTaskId) return;
    const task = state.tasks.find(t => t.id === state.activeTaskId);
    if (!task) return;
    updateTask(state.activeTaskId, { completed: !task.completed });
    el.btnComplete.textContent = !task.completed ? 'Mark incomplete' : 'Mark complete';
  });

  // --- Detail panel: delete task ---
  el.btnDeleteTask.addEventListener('click', async () => {
    if (!state.activeTaskId) return;
    if (!confirm('Delete this task?')) return;
    const taskId = state.activeTaskId;
    closeDetailPanel();
    await deleteTask(taskId);
  });

  // --- Keyboard: Escape closes panel/modal ---
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!el.modalBackdrop.classList.contains('hidden')) hideModal();
      else if (!el.detailPanel.classList.contains('hidden')) closeDetailPanel();
    }
  });

  // --- Auth buttons ---
  if (el.btnLogin) el.btnLogin.addEventListener('click', loginWithGoogle);
  if (el.btnLogout) el.btnLogout.addEventListener('click', logoutUser);
  if (el.btnOverlayLogin) el.btnOverlayLogin.addEventListener('click', loginWithGoogle);
}


// ----------------------------------------------------------
// UTILS
// ----------------------------------------------------------

/** Escape HTML to prevent XSS */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


// ----------------------------------------------------------
// INIT
// ----------------------------------------------------------

function init() {
  bindEvents();

  // Monitor auth state: show/hide buttons and start/stop listeners
  if (firebase && firebase.auth) {
    firebase.auth().onAuthStateChanged(user => {
      if (user) {
        currentUserUid = user.uid;
        if (el.btnLogin) el.btnLogin.classList.add('hidden');
        if (el.btnLogout) el.btnLogout.classList.remove('hidden');
        if (el.authOverlay) el.authOverlay.classList.add('hidden');
        // start listening to this user's lists
        try {
          listenLists();
        } catch (err) {
          console.error('listenLists failed', err);
        }
      } else {
        // signed out — cleanup listeners and clear state
        currentUserUid = null;
        if (unsubscribeLists) { unsubscribeLists(); unsubscribeLists = null; }
        if (state.unsubscribeTasks) { state.unsubscribeTasks(); state.unsubscribeTasks = null; }
        state.lists = [];
        state.tasks = [];
        renderSidebar();
        showHomepage();

        if (el.btnLogin) el.btnLogin.classList.remove('hidden');
        if (el.btnLogout) el.btnLogout.classList.add('hidden');
        if (el.authOverlay) el.authOverlay.classList.remove('hidden');
      }
    });
  }
}

init();