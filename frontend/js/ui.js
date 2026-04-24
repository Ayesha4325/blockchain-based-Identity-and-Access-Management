// TABS 
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const tabEl = document.getElementById('tab-' + name);
  const panelEl = document.getElementById('panel-' + name);
  if (tabEl) tabEl.classList.add('active');
  if (panelEl) panelEl.classList.add('active');
}

// MODE SWITCH (audit) 
function switchMode(mode) {
  if (mode === 'live' && !isAdmin) {
    toast('Live stream is admin-only', 'err');
    return;
  }
  const tabHistory = document.getElementById('tab-history');
  const tabLive = document.getElementById('tab-live');
  const panelHistory = document.getElementById('panel-history');
  const panelLive = document.getElementById('panel-live');
  const exportCsv = document.getElementById('export-csv-btn');
  const exportPdf = document.getElementById('export-pdf-btn');

  if (tabHistory) tabHistory.classList.toggle('active', mode === 'history');
  if (tabLive) tabLive.classList.toggle('active', mode === 'live');
  if (panelHistory) panelHistory.style.display = mode === 'history' ? 'block' : 'none';
  if (panelLive) panelLive.style.display = mode === 'live' ? 'block' : 'none';
  if (exportCsv) exportCsv.style.display = mode === 'history' ? '' : 'none';
  if (exportPdf) exportPdf.style.display = mode === 'history' ? '' : 'none';
}

// MODALS 
function openModal(name) {
  const el = document.getElementById('modal-' + name);
  if (el) el.classList.add('open');
}

function closeModal(name) {
  const el = document.getElementById('modal-' + name);
  if (el) el.classList.remove('open');
}

// Auto-close on overlay click
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.modal-overlay').forEach(el => {
    el.addEventListener('click', e => { if (e.target === el) el.classList.remove('open'); });
  });
});

// FILTER PILLS 
function setFilter(f, el) {
  if (typeof activeFilter !== 'undefined') activeFilter = f;
  document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
  if (el) el.classList.add('active');
  if (typeof renderUserTable === 'function') renderUserTable();
}

// PAGINATION 
let currentPage = 0;
const PAGE_SIZE = 25;

function goToPage(p, renderFn) {
  currentPage = p;
  if (typeof expandedTxHash !== 'undefined') expandedTxHash = null;
  if (renderFn) renderFn();
  const tableWrap = document.getElementById('results-table-wrap');
  if (tableWrap) tableWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// SORTING 
let sortDir = 'desc';
let sortField = 'timestamp';

function setSortDir(dir, renderFn) {
  sortDir = dir;
  const descBtn = document.getElementById('sort-desc');
  const ascBtn = document.getElementById('sort-asc');
  if (descBtn) descBtn.classList.toggle('active', dir === 'desc');
  if (ascBtn) ascBtn.classList.toggle('active', dir === 'asc');
  if (typeof allResults !== 'undefined' && allResults) {
    allResults.sort((a, b) => dir === 'desc' ? b.timestamp - a.timestamp : a.timestamp - b.timestamp);
    currentPage = 0;
    if (renderFn) renderFn();
  }
}

function sortBy(field, renderFn) {
  if (sortField === field) {
    sortDir = sortDir === 'desc' ? 'asc' : 'desc';
  } else {
    sortField = field;
    sortDir = 'desc';
  }
  if (typeof allResults !== 'undefined' && allResults) {
    allResults.sort((a, b) => {
      const av = a[field] ?? '', bv = b[field] ?? '';
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'desc' ? bv - av : av - bv;
      }
      return sortDir === 'desc'
        ? String(bv).localeCompare(String(av))
        : String(av).localeCompare(String(bv));
    });
    currentPage = 0;
    if (renderFn) renderFn();
  }
}

// EXPAND ROW 
let expandedTxHash = null;

function toggleExpand(idx, key, renderFn) {
  expandedTxHash = (expandedTxHash === key) ? null : key;
  if (renderFn) renderFn();
}

// RESET FILTERS 
function resetFilters() {
  ['f-from','f-to','f-block-from','f-block-to'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const fType = document.getElementById('f-type');
  if (fType) fType.value = 'all';
  const fAnomaly = document.getElementById('f-anomaly');
  if (fAnomaly) fAnomaly.value = 'all';
  const fLimit = document.getElementById('f-limit');
  if (fLimit) fLimit.value = '100';
  
  // For non-admin users, keep their address pre-filled
  const fActor = document.getElementById('f-actor');
  if (fActor && !isAdmin && userAddress) {
    fActor.value = userAddress;
  } else if (fActor) {
    fActor.value = '';
  }
  const fTarget = document.getElementById('f-target');
  if (fTarget) fTarget.value = '';
}