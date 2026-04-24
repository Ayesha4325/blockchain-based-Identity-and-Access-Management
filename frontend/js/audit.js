// State
let allResults    = [];
let liveActive    = false;
let liveListeners = [];
let liveCount     = 0;
let currentBlock  = 0;

// BOOT
window.addEventListener('DOMContentLoaded', async () => {
  if (!window.ethereum) { showLoadingError('MetaMask not found. Install it to continue.'); return; }
  try {
    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send('eth_requestAccounts', []);
    signer      = await provider.getSigner();
    userAddress = await signer.getAddress();
    contract    = new ethers.Contract(CONTRACT_ADDRESS, COMMON_ABI, signer);

    const code = await provider.getCode(CONTRACT_ADDRESS);
    if (code === '0x') { showLoadingError('No contract found at ' + CONTRACT_ADDRESS); return; }

    document.getElementById('loading-msg').textContent = 'Verifying access…';

    const registered = await contract.isRegistered(userAddress);
    if (!registered) {
      showLoadingError(
        'Wallet not registered.<br><br>' +
        '<a href="register.html" style="color:var(--accent2)">Register first →</a>'
      );
      return;
    }

    ownerAddress = await contract.owner();
    userRole     = Number(await contract.getRole(userAddress));
    isAdmin      = userRole >= 3;
    isOwner      = userAddress.toLowerCase() === ownerAddress.toLowerCase();

    await setupAuditUI();
    await loadBannerStats();
    startBlockPolling();

    document.getElementById('loading-screen').classList.add('hidden');
    document.getElementById('app').style.display = 'grid';

    window.ethereum.on('accountsChanged', () => location.reload());
    window.ethereum.on('chainChanged',    () => location.reload());
  } catch (e) {
    showLoadingError(parseErr(e));
  }
});

async function setupAuditUI() {
  document.getElementById('hdr-addr').textContent = userAddress.slice(0, 8) + '…' + userAddress.slice(-6);

  const roleBadge = document.getElementById('role-badge');
  if (isAdmin) {
    roleBadge.textContent = 'Admin';
    roleBadge.classList.add('admin');
    document.getElementById('admin-link').style.display = 'inline-flex';
  } else {
    roleBadge.textContent = 'User';
  }

  const network = await provider.getNetwork();
  const netName = network.name === 'unknown' ? 'Chain ' + network.chainId : network.name;
  document.getElementById('chain-label').textContent = netName;
  document.getElementById('chain-dot').classList.add('live');
  document.getElementById('contract-label').textContent =
    'Contract: ' + CONTRACT_ADDRESS.slice(0, 10) + '…' + CONTRACT_ADDRESS.slice(-8);

  const accessText = document.getElementById('access-level-text');
  if (!isAdmin) {
    if (accessText) accessText.textContent = 'Viewing events related to your wallet. Contact an admin for full access.';
    const fActor = document.getElementById('f-actor');
    if (fActor) { fActor.value = userAddress; fActor.disabled = true; }
    const tabLive = document.getElementById('tab-live');
    if (tabLive) { tabLive.disabled = true; tabLive.title = 'Admin only'; }
    const fAnomaly = document.getElementById('f-anomaly');
    if (fAnomaly) fAnomaly.disabled = true;
    const csvBtn = document.getElementById('export-csv-btn');
    const pdfBtn = document.getElementById('export-pdf-btn');
    if (csvBtn) csvBtn.style.display = 'none';
    if (pdfBtn) pdfBtn.style.display = 'none';
  }
}

async function loadBannerStats() {
  try {
    const [actionLogs, loginLogs] = await Promise.all([
      contract.queryFilter(contract.filters.ActionLogged()),
      contract.queryFilter(contract.filters.LoginAttempt()),
    ]);

    let logins, failed, total;
    if (isAdmin) {
      logins = loginLogs.filter(l => l.args?.success === true).length;
      failed = loginLogs.filter(l => l.args?.success === false).length;
      total  = actionLogs.length;
    } else {
      const u = userAddress.toLowerCase();
      logins = loginLogs.filter(l => l.args?.success === true  && l.args.wallet.toLowerCase() === u).length;
      failed = loginLogs.filter(l => l.args?.success === false && l.args.wallet.toLowerCase() === u).length;
      total  = actionLogs.filter(l => l.args && (l.args.actor.toLowerCase() === u || l.args.target.toLowerCase() === u)).length;
    }

    document.getElementById('stat-total').textContent  = total;
    document.getElementById('stat-logins').textContent = logins;
    document.getElementById('stat-failed').textContent = failed;
  } catch (e) { console.error('loadBannerStats', e); }
}

// QUERY ENGINE
async function runQuery() {
  const btn = document.getElementById('run-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Querying…';

  document.getElementById('results-header').style.display = 'none';
  document.getElementById('anomaly-bar').style.display    = 'none';
  document.getElementById('results-table-wrap').innerHTML =
    '<div class="table-empty"><span class="spinner"></span><span>Fetching events from blockchain…</span></div>';

  const fActor   = document.getElementById('f-actor').value.trim();
  const fTarget  = document.getElementById('f-target').value.trim();
  const fType    = document.getElementById('f-type').value;
  const fAnomaly = document.getElementById('f-anomaly').value;
  const fLimit   = parseInt(document.getElementById('f-limit').value);
  const fFrom    = document.getElementById('f-from').value;
  const fTo      = document.getElementById('f-to').value;
  const fBlkFrom = document.getElementById('f-block-from').value.trim();
  const fBlkTo   = document.getElementById('f-block-to').value.trim();

  const done = () => { btn.disabled = false; btn.innerHTML = 'Run Query'; };

  if (fActor  && !ethers.isAddress(fActor))  { toast('Invalid actor address', 'err'); done(); return; }
  if (fTarget && !ethers.isAddress(fTarget)) { toast('Invalid target address', 'err'); done(); return; }

  if (!isAdmin) {
    const ul = userAddress.toLowerCase();
    if (fActor  && fActor.toLowerCase()  !== ul) { toast('You can only query your own address', 'err'); done(); return; }
    if (fTarget && fTarget.toLowerCase() !== ul) { toast('You can only query events related to your address', 'err'); done(); return; }
  }

  const blockRange = {};
  if (fBlkFrom) {
    const n = parseInt(fBlkFrom);
    if (n < 0 || n > 1e9) { toast('Invalid From Block', 'err'); done(); return; }
    blockRange.fromBlock = n;
  }
  if (fBlkTo) {
    const n = parseInt(fBlkTo);
    if (n < 0 || n > 1e9) { toast('Invalid To Block', 'err'); done(); return; }
    blockRange.toBlock = n;
  }
  if (blockRange.fromBlock && blockRange.toBlock && blockRange.fromBlock > blockRange.toBlock) {
    toast('From Block must be ≤ To Block', 'err'); done(); return;
  }

  try {
    const needsAction     = fType === 'all' || fType.startsWith('action-');
    const needsLogin      = fType === 'all' || fType === 'login' || fType === 'action-5' || fType === 'action-6';
    const needsUserReg    = fType === 'all' || fType === 'action-0';
    const needsRoleChange = fType === 'all' || fType === 'action-1';
    const needsCritReq    = fType === 'all' || fType === 'critical-req';
    const needsCritApp    = fType === 'all' || fType === 'critical-app';

    const fetches = [];

    if (needsAction) {
      fetches.push(
        contract.queryFilter(
          contract.filters.ActionLogged(fActor || null, fTarget || null),
          blockRange.fromBlock, blockRange.toBlock
        ).then(logs => logs.map(normalizeActionLog))
      );
    }
    if (needsLogin) {
      const loginAddr = fActor || fTarget || null;
      fetches.push(
        contract.queryFilter(
          contract.filters.LoginAttempt(loginAddr),
          blockRange.fromBlock, blockRange.toBlock
        ).then(logs => {
          let normalized = logs.map(normalizeLoginAttempt).filter(Boolean);
          // If both fActor and fTarget are set, client-side filter for fTarget too
          if (fActor && fTarget) {
            normalized = normalized.filter(r =>
              r.target?.toLowerCase() === fTarget.toLowerCase()
            );
          }
          return normalized;
        })
      );
    }
    if (needsUserReg) {
      const rf = fActor ? contract.filters.UserRegistered(fActor)
               : fTarget ? contract.filters.UserRegistered(fTarget)
               : contract.filters.UserRegistered();
      fetches.push(
        contract.queryFilter(rf, blockRange.fromBlock, blockRange.toBlock)
          .then(logs => logs.map(normalizeUserRegistered))
      );
    }
    if (needsRoleChange) {
      const rf = fActor  ? contract.filters.RoleChanged(null, null, null, fActor)
               : fTarget ? contract.filters.RoleChanged(fTarget)
               : contract.filters.RoleChanged();
      fetches.push(
        contract.queryFilter(rf, blockRange.fromBlock, blockRange.toBlock)
          .then(logs => logs.map(normalizeRoleChanged))
      );
    }
    if (needsCritReq) {
      const rf = fActor  ? contract.filters.CriticalActionRequested(null, fActor)
               : fTarget ? contract.filters.CriticalActionRequested(null, null, fTarget)
               : contract.filters.CriticalActionRequested();
      fetches.push(
        contract.queryFilter(rf, blockRange.fromBlock, blockRange.toBlock)
          .then(logs => logs.map(normalizeCriticalReq))
      );
    }
    if (needsCritApp) {
      fetches.push(
        contract.queryFilter(
          contract.filters.CriticalActionApproved(),
          blockRange.fromBlock, blockRange.toBlock
        ).then(logs => logs.map(normalizeCriticalApp))
      );
    }

    let rows = (await Promise.all(fetches)).flat().filter(Boolean);

    if (fType === 'all') {
      const txHasSpecificEvent = new Set(
        rows.filter(r => r.source !== 'action').map(r => r.txHash)
      );
      rows = rows.filter(r => {
        if (r.source !== 'action') return true;
        // Keep action events only if NO specific event shares this txHash
        return !txHasSpecificEvent.has(r.txHash);
      });
    }

    // Post-filters
    if (fType.startsWith('action-')) {
      const num = parseInt(fType.split('-')[1]);
      rows = rows.filter(r => r.source === 'action' && r.actionNum === num);
    }
    if (fFrom) { const ts = new Date(fFrom).getTime();           rows = rows.filter(r => r.timestamp >= ts); }
    if (fTo)   { const ts = new Date(fTo + 'T23:59:59').getTime(); rows = rows.filter(r => r.timestamp <= ts); }

    if (fActor) {
      const al = fActor.toLowerCase();
      rows = rows.filter(r =>
        (r.actor?.toLowerCase()     === al) ||
        (r.wallet?.toLowerCase()    === al) ||
        (r.requester?.toLowerCase() === al) ||
        (r.approver?.toLowerCase()  === al)
      );
    }
    if (fTarget) {
      const tl = fTarget.toLowerCase();
      rows = rows.filter(r => r.target?.toLowerCase() === tl);
    }
    if (!isAdmin) {
      const ul = userAddress.toLowerCase();
      rows = rows.filter(r => {
        const a = (r.actor || r.wallet || r.requester || '').toLowerCase();
        const t = (r.target || '').toLowerCase();
        return a === ul || t === ul;
      });
    }

    // Deduplicate by txHash + logIndex
    const seen = new Set();
    rows = rows.filter(r => {
      const k = (r.txHash || '') + '_' + (r.logIndex ?? r.eventKey ?? '');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    detectAnomalies(rows);

    if (fAnomaly === 'anomaly') rows = rows.filter(r => r.isAnomaly);

    rows.sort((a, b) => sortDir === 'desc' ? b.timestamp - a.timestamp : a.timestamp - b.timestamp);
    allResults  = rows.slice(0, fLimit);
    currentPage = 0;

    renderResults();

    const csvBtn = document.getElementById('export-csv-btn');
    const pdfBtn = document.getElementById('export-pdf-btn');
    if (csvBtn) csvBtn.disabled = allResults.length === 0;
    if (pdfBtn) pdfBtn.disabled = allResults.length === 0;

    toast(`${allResults.length} event${allResults.length !== 1 ? 's' : ''} loaded`, 'ok');
  } catch (e) {
    document.getElementById('results-table-wrap').innerHTML =
      `<div class="table-empty"><span>⚠️</span><span>Query failed: ${escHtml(parseErr(e))}</span></div>`;
    toast(parseErr(e), 'err');
  }

  done();
}

// RENDER
function renderResults() {
  const total = allResults.length;
  const pages = Math.ceil(total / PAGE_SIZE);
  const start = currentPage * PAGE_SIZE;
  const end   = Math.min(start + PAGE_SIZE, total);
  const rows  = allResults.slice(start, end);

  document.getElementById('results-header').style.display = 'flex';
  document.getElementById('results-count').textContent = `${total} event${total !== 1 ? 's' : ''}`;
  document.getElementById('results-sub').textContent = total > 0
    ? `Showing ${start + 1}–${end} · Page ${currentPage + 1} of ${pages}` : '';

  if (total === 0) {
    document.getElementById('results-table-wrap').innerHTML =
      '<div class="table-empty"><span>🔍</span><span>No events match your filters.</span></div>';
    return;
  }

  const tbody = rows.map((r, idx) => {
    const globalIdx  = start + idx;
    const key        = r.txHash + '_' + (r.logIndex ?? r.eventKey ?? '');
    const isExpanded = expandedTxHash === key;
    const anomMark   = r.isAnomaly ? '<span class="anomaly-flag"></span>' : '';
    const ts         = r.timestamp ? new Date(r.timestamp).toLocaleString() : '—';
    const txShort    = r.txHash ? r.txHash.slice(0, 10) + '…' + r.txHash.slice(-8) : '—';
    const txLink     = getTxLink(r.txHash);
    const actorAddr  = r.actor || r.wallet || '';

    return `
      <tr class="${r.isAnomaly ? 'anomaly-row' : ''} ${isExpanded ? 'expanded' : ''}"
          onclick="toggleExpand(${globalIdx},'${key}')"
          title="Click to expand event details">
        <td>${anomMark}<span class="event-badge ${r.cls}">${r.icon} ${r.label}</span></td>
        <td>
          <div class="addr-short">
            <span>${addrShort(actorAddr)}</span>
            <span class="copy-icon" onclick="event.stopPropagation();copyAddr('${actorAddr}')" title="Copy">⎘</span>
          </div>
        </td>
        <td>
          <div class="addr-short">
            <span>${r.target && r.target !== '—' ? addrShort(r.target) : '—'}</span>
            ${r.target && r.target !== '—'
              ? `<span class="copy-icon" onclick="event.stopPropagation();copyAddr('${r.target}')" title="Copy">⎘</span>`
              : ''}
          </div>
        </td>
        <td><span class="nonce-badge">${r.nonce}</span></td>
        <td style="font-family:var(--mono);font-size:11px;color:var(--muted)">#${r.blockNum}</td>
        <td style="font-family:var(--mono);font-size:11px;color:var(--muted)">${ts}</td>
        <td>
          ${txLink
            ? `<a class="tx-link" href="${txLink}" target="_blank" onclick="event.stopPropagation()">${txShort} ↗</a>`
            : `<span style="font-family:var(--mono);font-size:11px;color:var(--muted)">${txShort}</span>`}
        </td>
      </tr>
      ${isExpanded ? buildExpandRow(r) : ''}
    `;
  }).join('');

  document.getElementById('results-table-wrap').innerHTML = `
    <table>
      <thead>
        <tr>
          <th onclick="sortBy('label')">Event Type <span class="sort-arrow">↕</span></th>
          <th onclick="sortBy('actor')">Actor / Wallet <span class="sort-arrow">↕</span></th>
          <th>Target</th>
          <th onclick="sortBy('nonce')">Nonce <span class="sort-arrow">↕</span></th>
          <th onclick="sortBy('blockNum')">Block <span class="sort-arrow">↕</span></th>
          <th onclick="sortBy('timestamp')" class="sorted">Timestamp <span class="sort-arrow">${sortDir === 'desc' ? '↓' : '↑'}</span></th>
          <th>Tx Hash</th>
        </tr>
      </thead>
      <tbody>${tbody}</tbody>
    </table>
    ${buildPagination(total, pages)}
  `;
}

function buildExpandRow(r) {
  const txLink = getTxLink(r.txHash);
  const ts = r.timestamp ? new Date(r.timestamp).toLocaleString() : '—';
  const ridx = allResults.indexOf(r);

  let extra = '';
  if (r.approvalId) extra += `<div class="exp-field"><div class="exp-label">Approval ID</div><div class="exp-val hash">${r.approvalId}</div></div>`;
  if (r.identityHash) extra += `<div class="exp-field"><div class="exp-label">Identity Hash</div><div class="exp-val hash">${r.identityHash}</div></div>`;
  if (r.oldRole !== undefined && r.newRole !== undefined)
    extra += `<div class="exp-field"><div class="exp-label">Role Change</div><div class="exp-val">${r.oldRole} → ${r.newRole}</div></div>`;

  return `
    <tr class="expand-row">
      <td colspan="7">
        <div class="expand-inner">
          <div class="exp-section">
            <div class="exp-title">Identity</div>
            <div class="exp-field"><div class="exp-label">Actor / Wallet</div><div class="exp-val">${r.actor || r.wallet || '—'}</div></div>
            <div class="exp-field"><div class="exp-label">Target</div><div class="exp-val">${r.target || '—'}</div></div>
            <div class="exp-field"><div class="exp-label">Event Type</div><div class="exp-val">${r.label} (source: ${r.source})</div></div>
            <div class="exp-field"><div class="exp-label">Nonce</div><div class="exp-val">${r.nonce}</div></div>
          </div>
          <div class="exp-section">
            <div class="exp-title">On-Chain Data</div>
            <div class="exp-field"><div class="exp-label">Block Number</div><div class="exp-val">${r.blockNum}</div></div>
            <div class="exp-field"><div class="exp-label">Timestamp</div><div class="exp-val">${ts}</div></div>
            <div class="exp-field"><div class="exp-label">Transaction Hash</div><div class="exp-val hash">${r.txHash || '—'}</div></div>
            ${r.logIndex !== undefined ? `<div class="exp-field"><div class="exp-label">Log Index</div><div class="exp-val">${r.logIndex}</div></div>` : ''}
            ${extra}
          </div>
          <div class="exp-section">
            <div class="exp-title">Cryptographic Proof</div>
            <div class="exp-field"><div class="exp-label">Log Index</div><div class="exp-val">${r.raw?.index ?? r.raw?.logIndex ?? '—'}</div></div>
            <div class="exp-field"><div class="exp-label">Removed</div><div class="exp-val">${r.raw?.removed === true ? '⚠ YES (reorg)' : 'No (canonical)'}</div></div>
            <div class="exp-field"><div class="exp-label">Contract</div><div class="exp-val hash">${r.raw?.address || CONTRACT_ADDRESS}</div></div>
            <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px">
              ${txLink ? `<a class="verify-btn" href="${txLink}" target="_blank">↗ View on Explorer</a>` : ''}
              <button class="verify-btn" style="border-color:var(--border);color:var(--muted)" onclick="copyRawEvent(allResults[${ridx}])">⎘ Copy Raw Event JSON</button>
            </div>
          </div>
        </div>
      </td>
    </tr>`;
}

function buildPagination(total, pages) {
  if (pages <= 1) return '';
  const start = currentPage * PAGE_SIZE;
  const end   = Math.min(start + PAGE_SIZE, total);
  const max   = 7;
  let sp = Math.max(0, currentPage - 3);
  let ep = Math.min(pages - 1, sp + max - 1);
  if (ep - sp < max - 1) sp = Math.max(0, ep - max + 1);

  let btns = '';
  if (sp > 0) btns += `<button class="page-btn" onclick="goToPage(0)">1</button><span class="page-info">…</span>`;
  for (let i = sp; i <= ep; i++) {
    btns += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="goToPage(${i})">${i + 1}</button>`;
  }
  if (ep < pages - 1) btns += `<span class="page-info">…</span><button class="page-btn" onclick="goToPage(${pages - 1})">${pages}</button>`;

  return `<div class="pagination">
    <button class="page-btn" onclick="goToPage(${currentPage - 1})" ${currentPage === 0 ? 'disabled' : ''}>← Prev</button>
    ${btns}
    <button class="page-btn" onclick="goToPage(${currentPage + 1})" ${currentPage >= pages - 1 ? 'disabled' : ''}>Next →</button>
    <span class="page-info">${start + 1}–${end} of ${total}</span>
  </div>`;
}

// Override ui.js goToPage to scroll table into view
function goToPage(p) {
  currentPage    = p;
  expandedTxHash = null;
  renderResults();
  document.getElementById('results-table-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Override ui.js toggleExpand for audit-specific logic
function toggleExpand(idx, key) {
  expandedTxHash = expandedTxHash === key ? null : key;
  renderResults();
}

// Audit-specific sort wrappers that call renderResults
function setSortDir(dir) {
  sortDir = dir;
  document.getElementById('sort-desc')?.classList.toggle('active', dir === 'desc');
  document.getElementById('sort-asc')?.classList.toggle('active', dir === 'asc');
  allResults.sort((a, b) => dir === 'desc' ? b.timestamp - a.timestamp : a.timestamp - b.timestamp);
  currentPage = 0;
  renderResults();
}

function sortBy(field) {
  if (sortField === field) {
    sortDir = sortDir === 'desc' ? 'asc' : 'desc';
  } else {
    sortField = field;
    sortDir   = 'desc';
  }
  allResults.sort((a, b) => {
    const av = a[field] ?? '', bv = b[field] ?? '';
    if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'desc' ? bv - av : av - bv;
    return sortDir === 'desc' ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv));
  });
  currentPage = 0;
  renderResults();
}

// EXPORT
function exportCSV() {
  window.exportCSV(allResults, `identitymanager-audit-${Date.now()}.csv`);
}

function exportPrintReport() {
  window.exportPrintReport(allResults);
}

// LIVE STREAM
function toggleLive() {
  liveActive ? stopLive() : startLive();
}

function startLive() {
  if (!isAdmin) { toast('Live stream is admin-only', 'err'); return; }
  liveActive = true;

  const toggleBtn   = document.getElementById('live-toggle-btn');
  const statusPill  = document.getElementById('live-status-pill');
  if (toggleBtn)  { toggleBtn.textContent = 'Stop Listening'; toggleBtn.classList.add('running'); }
  if (statusPill) { statusPill.className = 'live-status-pill running'; statusPill.textContent = '● Listening…'; }

  const streamEl = document.getElementById('live-stream');
  if (streamEl?.querySelector('.live-empty')) streamEl.innerHTML = '';

  const actionFilter  = contract.filters.ActionLogged();
  const loginFilter   = contract.filters.LoginAttempt();
  const critReqFilter = contract.filters.CriticalActionRequested();
  const critAppFilter = contract.filters.CriticalActionApproved();

  const actionHandler = (actor, target, action, nonce, timestamp, event) => {
    const num  = Number(action);
    const key  = 'action-' + num;
    const meta = EventMeta[key] || { label: 'Action', icon: '·', cls: 'nonce' };
    appendLiveItem({ label: meta.label, icon: meta.icon, cls: meta.cls, actor, target,
      nonce: nonce.toString(), timestamp: Number(timestamp) * 1000,
      txHash: event.log?.transactionHash || event.transactionHash, isAnomaly: num === 6 });
  };
  const loginHandler = (wallet, success, nonce, timestamp, event) => {
    const key  = success ? 'login-ok' : 'login-fail';
    const meta = EventMeta[key];
    appendLiveItem({ label: meta.label, icon: meta.icon, cls: meta.cls, actor: wallet, target: wallet,
      nonce: nonce.toString(), timestamp: Number(timestamp) * 1000,
      txHash: event.log?.transactionHash || event.transactionHash, isAnomaly: !success });
  };
  const critReqHandler = (approvalId, requester, target, actionType, expiresAt, event) => {
    appendLiveItem({ label: 'Critical Req.', icon: '🔐', cls: 'critical', actor: requester, target,
      nonce: '—', timestamp: Number(expiresAt) * 1000,
      txHash: event.log?.transactionHash || event.transactionHash, isAnomaly: false });
  };
  const critAppHandler = (approvalId, approver, timestamp, event) => {
    appendLiveItem({ label: 'Critical App.', icon: '✔', cls: 'approved', actor: approver, target: '—',
      nonce: '—', timestamp: Number(timestamp) * 1000,
      txHash: event.log?.transactionHash || event.transactionHash, isAnomaly: false });
  };

  contract.on(actionFilter,  actionHandler);
  contract.on(loginFilter,   loginHandler);
  contract.on(critReqFilter, critReqHandler);
  contract.on(critAppFilter, critAppHandler);

  liveListeners = [
    { filter: actionFilter,  handler: actionHandler },
    { filter: loginFilter,   handler: loginHandler },
    { filter: critReqFilter, handler: critReqHandler },
    { filter: critAppFilter, handler: critAppHandler },
  ];

  toast('Live stream started — listening for events…');
}

function stopLive() {
  liveActive = false;
  liveListeners.forEach(({ filter, handler }) => { try { contract.off(filter, handler); } catch (e) {} });
  liveListeners = [];

  const toggleBtn  = document.getElementById('live-toggle-btn');
  const statusPill = document.getElementById('live-status-pill');
  if (toggleBtn)  { toggleBtn.textContent = 'Start Listening'; toggleBtn.classList.remove('running'); }
  if (statusPill) { statusPill.className = 'live-status-pill stopped'; statusPill.textContent = '● Stopped'; }
  toast('Live stream stopped');
}

function clearLive() {
  const streamEl = document.getElementById('live-stream');
  if (streamEl) streamEl.innerHTML = `
    <div class="live-empty">
      <span>📡</span>
      <span>Stream cleared. Click <strong>Start Listening</strong> to resume.</span>
    </div>`;
  liveCount = 0;
}

function appendLiveItem(r) {
  liveCount++;
  const streamEl = document.getElementById('live-stream');
  if (!streamEl) return;
  const ts     = new Date(r.timestamp).toLocaleTimeString();
  const txLink = getTxLink(r.txHash);

  const item = document.createElement('div');
  item.className = 'live-item';
  if (r.isAnomaly) item.style.background = 'rgba(214,48,48,0.04)';

  item.innerHTML = `
    <div class="live-icon ${r.cls}">${r.icon}</div>
    <div>
      <div class="live-event">${r.label}</div>
      <div class="live-addrs">${addrShort(r.actor || '—')} → ${r.target && r.target !== '—' ? addrShort(r.target) : '—'}</div>
    </div>
    <div class="live-nonce">nonce&nbsp;${r.nonce}</div>
    <div class="live-time">${ts}</div>
    ${r.isAnomaly ? '<div class="live-anomaly-flag" title="Anomaly flagged"></div>' : '<div></div>'}
  `;

  if (txLink) {
    item.style.cursor = 'pointer';
    item.title = 'View tx on explorer';
    item.onclick = () => window.open(txLink, '_blank');
  }

  streamEl.prepend(item);

  const items = streamEl.querySelectorAll('.live-item');
  if (items.length > 200) items[items.length - 1].remove();
}