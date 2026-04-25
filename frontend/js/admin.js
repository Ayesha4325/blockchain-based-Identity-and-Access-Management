let allUsers = [];
let activeFilter = 'all';
let pendingRoleTarget = null;
let pendingDeactTarget = null;
let pendingDeactAction = null;

// BOOT 
window.addEventListener('DOMContentLoaded', async () => {
  if (!window.ethereum) { showLoadingError('MetaMask not found. Install it to continue.'); return; }
  
  const ok = await initWithCheck(3); // Requires admin role
  if (!ok) return;
  
  document.getElementById('loading-msg').textContent = 'Verifying admin role…';
  
  await setupAdminUI();
  await loadAll();
  setupLiveEvents();
  
  hideLoading();
});

async function setupAdminUI() {
  const short = userAddress.slice(0,8) + '…' + userAddress.slice(-6);
  const bannerAddr = document.getElementById('banner-addr');
  if (bannerAddr) bannerAddr.textContent = userAddress;
  
  const bannerMeta = document.getElementById('banner-meta');
  if (bannerMeta && isOwner) {
    bannerMeta.innerHTML = '<span class="role-pill owner">Owner</span><span class="role-pill admin">Admin</span>';
  }
  if (isOwner) {
    const emergencyTab = document.getElementById('tab-emergency');
    if (emergencyTab) emergencyTab.style.display = 'inline-flex';
  }
  const network = await provider.getNetwork();
  const netName = network.name === 'unknown' ? 'Chain ' + network.chainId : network.name;
  const chainLabel = document.getElementById('chain-label');
  if (chainLabel) chainLabel.textContent = netName;
}

async function loadAll() {
  await Promise.all([ loadUsers(), loadApprovals() ]);
}

// USER REGISTRY 
async function loadUsers() {
  const wrap = document.getElementById('user-table-wrap');
  if (wrap) wrap.innerHTML = '<div class="table-empty"><span class="spinner"></span></div>';

  try {
    const regFilter = contract.filters.UserRegistered();
    const regLogs = await queryFilterChunked(regFilter);
    const addresses = [...new Set(regLogs.map(l => l.args.wallet))];

    const details = await Promise.all(addresses.map(async addr => {
      try { const d = await contract.getUserDetails(addr); return { address: addr, details: d }; }
      catch(e) { return null; }
    }));
    allUsers = details.filter(Boolean);

    const total = allUsers.length;
    const active = allUsers.filter(u => u.details.isActive).length;
    const admins = allUsers.filter(u => Number(u.details.role) >= 3).length;

    const statTotal = document.getElementById('stat-total');
    const statActive = document.getElementById('stat-active');
    const statAdmins = document.getElementById('stat-admins');
    const tabCount = document.getElementById('tab-users-count');
    
    if (statTotal) statTotal.textContent = total;
    if (statActive) statActive.textContent = active;
    if (statAdmins) statAdmins.textContent = admins;
    if (tabCount) tabCount.textContent = total;

    const statPending = document.getElementById('stat-pending');
    if (statPending && statPending.textContent === '—') statPending.textContent = '0';

    renderUserTable();
  } catch(e) {
    if (wrap) wrap.innerHTML = `<div class="table-empty">Failed to load users: ${escHtml(parseErr(e))}</div>`;
    toast(parseErr(e), 'err');
  }
}

function renderUserTable() {
  const searchEl = document.getElementById('user-search');
  const search = searchEl ? searchEl.value.toLowerCase().trim() : '';
  let users = allUsers;

  if (activeFilter === 'active')   users = users.filter(u => u.details.isActive);
  if (activeFilter === 'inactive') users = users.filter(u => !u.details.isActive);
  if (activeFilter === 'admin')    users = users.filter(u => Number(u.details.role) >= 3);
  if (search) users = users.filter(u => u.address.toLowerCase().includes(search));

  const wrap = document.getElementById('user-table-wrap');
  if (!wrap) return;

  if (users.length === 0) {
    wrap.innerHTML = '<div class="table-empty">No users match this filter.</div>';
    return;
  }

  const rowsHtml = users.map(u => {
    const addr = u.address;
    const d = u.details;
    const role = Number(d.role);
    const isMe = addr.toLowerCase() === userAddress.toLowerCase();
    const isOw = addr.toLowerCase() === ownerAddress.toLowerCase();
    const rCls = isOw ? 'owner' : (RoleClass[role] || 'user');
    const rNam = isOw ? 'Owner' : (RoleName[role] || 'Unknown');
    const avatarLetter = addr.slice(2,4).toUpperCase();
    const hashShort = d.identityHash.slice(0,14) + '…';

    return `<tr>
      <td>
        <div class="addr-cell">
          <div class="addr-avatar ${rCls}">${avatarLetter}</div>
          <span class="addr-mono">${addr.slice(0,10)}…${addr.slice(-8)}</span>
          ${isMe ? '<span class="you-tag">you</span>' : ''}
        </div>
      </td>
      <td><span class="role-pill ${rCls}">${rNam}</span></td>
      <td>
        <div class="active-indicator">
          <div class="status-dot ${d.isActive ? 'on' : 'off'}"></div>
          <span>${d.isActive ? 'Active' : 'Inactive'}</span>
        </div>
      </td>
      <td class="hash-cell" title="${d.identityHash}">${hashShort}</td>
      <td style="font-family:var(--mono);font-size:12px">${d.nonce.toString()}</td>
      <td>
        <div class="row-actions">
          ${!isMe && !isOw ? `
            <button class="row-btn" onclick="openRoleModal('${addr}')">Set Role</button>
            ${d.isActive
              ? `<button class="row-btn danger" onclick="openDeactModal('${addr}','deactivate')">Deactivate</button>`
              : `<button class="row-btn success-btn" onclick="openDeactModal('${addr}','reactivate')">Reactivate</button>`}
          ` : '<span style="font-family:var(--mono);font-size:10px;color:var(--muted)">' + (isOw ? 'Owner' : 'You') + '</span>'}
          <button class="row-btn" onclick="openAuditForUser('${addr}')">Audit ↗</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <table>
      <thead><tr><th>Address</th><th>Role</th><th>Status</th><th>Identity Hash</th><th>Nonce</th><th>Actions</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}

function filterUsers() { renderUserTable(); }

// APPROVALS 
async function loadApprovals() {
  const grid = document.getElementById('approvals-grid');
  if (grid) grid.innerHTML = '<div class="no-approvals"><span class="spinner"></span></div>';

  try {
    const reqFilter = contract.filters.CriticalActionRequested();
    const reqLogs = await queryFilterChunked(reqFilter);
    const appFilter = contract.filters.CriticalActionApproved();
    const appLogs = await queryFilterChunked(appFilter);
    const approvedIds = new Set(appLogs.map(l => l.args.approvalId));

    const results = [];
    for (const log of reqLogs) {
      const id = log.args.approvalId;
      const expiresAt = Number(log.args.expiresAt) * 1000;
      const expired = Date.now() > expiresAt;
      let isApproved = approvedIds.has(id);
      let req = null;
      try { req = await contract.getApprovalRequest(id); if (req.exists) isApproved = req.isApproved; }
      catch(e) {}
      results.push({ id, req, log, expiresAt, expired, isApproved });
    }

    results.sort((a, b) => {
      if (!a.isApproved && !a.expired && (b.isApproved || b.expired)) return -1;
      if (!b.isApproved && !b.expired && (a.isApproved || a.expired)) return 1;
      return b.expiresAt - a.expiresAt;
    });

    const pendingCount = results.filter(r => !r.isApproved && !r.expired).length;
    const statPending = document.getElementById('stat-pending');
    const tabCount = document.getElementById('tab-approvals-count');
    if (statPending) statPending.textContent = pendingCount;
    if (tabCount) tabCount.textContent = pendingCount;

    if (results.length === 0) {
      if (grid) grid.innerHTML = '<div class="no-approvals">No critical action requests found in contract history.</div>';
      return;
    }
    if (grid) grid.innerHTML = results.map(r => buildApprovalCard(r)).join('');
  } catch(e) {
    if (grid) grid.innerHTML = `<div class="no-approvals">Failed to load approvals: ${escHtml(parseErr(e))}</div>`;
    toast(parseErr(e), 'err');
  }
}

function buildApprovalCard({ id, req, log, expiresAt, expired, isApproved }) {
  const actionType = Number(log.args.actionType || 0);
  const typeName = actionType === 0 ? 'Role Change' : 'Deactivation';
  const typeClass = actionType === 0 ? 'role-change' : 'deactivation';
  const requester = req ? req.requester : log.args.requester;
  const target = req ? req.target : log.args.target;
  const ttlPct = expired ? 0 : Math.min(100, Math.round(((expiresAt - Date.now()) / 3600000) * 100));
  let statusLabel = isApproved ? 'Approved' : expired ? 'Expired' : 'Pending';
  let statusClass = isApproved ? 'approved' : expired ? 'expired' : 'pending';
  let cardClass = expired && !isApproved ? 'approval-card expired' : 'approval-card';
  const canApprove = !isApproved && !expired && req && requester.toLowerCase() !== userAddress.toLowerCase();

  return `<div class="${cardClass}">
    <div class="ap-card-header">
      <span class="ap-type-chip ${typeClass}">${typeName}</span>
      <span class="ap-status-chip ${statusClass}">${statusLabel}</span>
    </div>
    <div class="ap-field"><div class="ap-label">Requester</div><div class="ap-val">${requester.slice(0,12)}…${requester.slice(-8)}</div></div>
    <div class="ap-field"><div class="ap-label">Target</div><div class="ap-val">${target.slice(0,12)}…${target.slice(-8)}</div></div>
    <div class="ap-field"><div class="ap-label">Approval ID</div><div class="ap-val" style="font-size:10px">${id.slice(0,20)}…</div></div>
    ${!isApproved ? `<div><div class="ap-ttl-bar"><div class="ap-ttl-fill ${expired ? 'expired-fill' : ''}" style="width:${ttlPct}%"></div></div></div>` : ''}
    <div class="ap-card-actions">
      ${canApprove ? `<button class="ap-approve-btn" onclick="doApproveById('${id}', this)">Approve ✓</button>` : ''}
      <button class="ap-id-copy" onclick="copyToClipboard('${id}', 'Approval ID copied ✓')">Copy ID</button>
    </div>
  </div>`;
}

async function doApproveById(id, btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  try {
    const tx = await contract.approveCriticalAction(id);
    toast('Approving…', 'info');
    await tx.wait();
    toast('Critical action approved ✓', 'ok');
    await loadApprovals();
  } catch(e) {
    toast(parseErr(e), 'err');
    if (btn) { btn.disabled = false; btn.textContent = 'Approve ✓'; }
  }
}

// AUDIT LOG (admin panel version) 
async function runAuditQuery() {
  const addrRaw = document.getElementById('audit-addr-input').value.trim();
  const typeVal = document.getElementById('audit-type-filter').value;
  const limit = parseInt(document.getElementById('audit-limit').value);
  const btn = document.getElementById('audit-run-btn');

  if (addrRaw && !ethers.isAddress(addrRaw)) { toast('Invalid wallet address', 'err'); return; }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Querying…';
  document.getElementById('audit-list').innerHTML = '<div class="audit-empty"><span class="spinner"></span></div>';

  try {
    let filter = addrRaw ? contract.filters.ActionLogged(null, addrRaw) : contract.filters.ActionLogged();
    let logs = await queryFilterChunked(filter);

    if (typeVal !== 'all') {
      const t = parseInt(typeVal);
      logs = logs.filter(l => l.args && Number(l.args.action) === t);
    }
    logs.sort((a, b) => Number(b.args.timestamp) - Number(a.args.timestamp));
    const sliced = logs.slice(0, limit);

    document.getElementById('audit-result-label').textContent = addrRaw ? `Results for ${addrRaw.slice(0,10)}…` : 'All events';
    document.getElementById('audit-result-count').textContent = `${sliced.length} of ${logs.length} events`;

    if (sliced.length === 0) {
      document.getElementById('audit-list').innerHTML = '<div class="audit-empty">No events found matching your query.</div>';
      return;
    }

    document.getElementById('audit-list').innerHTML = sliced.map(log => {
      const type = Number(log.args.action);
      const ts = Number(log.args.timestamp) * 1000;
      const actor = log.args.actor;
      const target = log.args.target;
      const nonce = log.args.nonce.toString();
      return `
        <div class="audit-row">
          <div class="audit-icon ${ActionClass[type] || 'nonce'}">${ActionIcon[type] || '·'}</div>
          <div class="audit-body">
            <div class="audit-event">${ActionName[type] || 'Action'}</div>
            <div class="audit-sub">Actor: ${actor.slice(0,10)}…${actor.slice(-6)} → Target: ${target.slice(0,10)}…${target.slice(-6)} · Nonce: ${nonce}</div>
          </div>
          <div class="audit-time">${new Date(ts).toLocaleString()}</div>
        </div>`;
    }).join('');
  } catch(e) {
    document.getElementById('audit-list').innerHTML = `<div class="audit-empty">Query failed: ${escHtml(parseErr(e))}</div>`;
    toast(parseErr(e), 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Query';
  }
}

function openAuditForUser(addr) {
  const input = document.getElementById('audit-addr-input');
  if (input) input.value = addr;
  switchTab('audit');
  runAuditQuery();
}

// ROLE ASSIGNMENT FLOW 
function openRoleModal(addr) {
  pendingRoleTarget = addr;
  const targetInput = document.getElementById('modal-role-target');
  if (targetInput) targetInput.value = addr;

  const sub = document.getElementById('modal-role-sub');
  const note = document.getElementById('modal-role-note');
  const submit = document.getElementById('modal-role-submit');

  if (isOwner) {
    if (sub) sub.textContent = 'As owner, role change is immediate — no approval required.';
    if (note) note.textContent = 'This will call assignRole() directly. No 2FA queue.';
    if (submit) submit.textContent = 'Assign Role Directly';
  } else {
    if (sub) sub.textContent = 'Submits a critical action request requiring approval.';
    if (note) note.textContent = 'As a non-owner admin, this enters the 2FA approval queue. Another admin or your secondary wallet must approve before assignRole() executes.';
    if (submit) submit.textContent = 'Request Role Change';
  }
  openModal('assign-role');
}

async function doAssignRoleFlow() {
  const addr = pendingRoleTarget;
  const select = document.getElementById('modal-role-select');
  const newRole = select ? parseInt(select.value) : 1;
  if (!addr) return;

  const btn = document.getElementById('modal-role-submit');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Processing…';

  try {
    if (isOwner) {
      const tx = await contract.assignRole(addr, newRole);
      toast('Assigning role…');
      await tx.wait();
      toast(`Role assigned to ${RoleName[newRole]} ✓`, 'ok');
    } else {
      const data = ethers.zeroPadValue(ethers.toBeHex(newRole), 32);
      const tx = await contract.requestCriticalAction(addr, 0, data);
      toast('Submitting critical action request…');
      await tx.wait();
      const approvalId = await contract.buildApprovalId(userAddress, addr, 0, data);
      toast(`Role change requested ✓ · Approval ID: ${approvalId.slice(0,12)}…`, 'ok');
    }
    closeModal('assign-role');
    await loadUsers();
    await loadApprovals();
  } catch(e) {
    toast(parseErr(e), 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = isOwner ? 'Assign Role Directly' : 'Request Role Change';
  }
}

// DEACT / REACT FLOW 
function openDeactModal(addr, action) {
  pendingDeactTarget = addr;
  pendingDeactAction = action;
  const targetInput = document.getElementById('modal-deact-target');
  const title = document.getElementById('modal-deact-title');
  const submit = document.getElementById('modal-deact-submit');
  
  if (targetInput) targetInput.value = addr;
  if (title) title.textContent = action === 'deactivate' ? 'Deactivate User' : 'Reactivate User';
  if (submit) submit.textContent = isOwner
    ? (action === 'deactivate' ? 'Deactivate Immediately' : 'Reactivate Immediately')
    : 'Submit Request';
  openModal('deact');
}

async function doDeactFlow() {
  const addr = pendingDeactTarget;
  const action = pendingDeactAction;
  if (!addr) return;

  const btn = document.getElementById('modal-deact-submit');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Processing…';

  try {
    if (isOwner) {
      const tx = action === 'deactivate'
        ? await contract.deactivateUser(addr)
        : await contract.reactivateUser(addr);
      toast(`${action === 'deactivate' ? 'Deactivating' : 'Reactivating'}…`);
      await tx.wait();
      toast(`User ${action}d ✓`, 'ok');
    } else {
      const data = ethers.zeroPadValue(addr.toLowerCase(), 32);
      const tx = await contract.requestCriticalAction(addr, 1, data);
      toast('Submitting deactivation request…');
      await tx.wait();
      const approvalId = await contract.buildApprovalId(userAddress, addr, 1, data);
      toast(`Deactivation requested ✓ · ID: ${approvalId.slice(0,12)}…`, 'ok');
    }
    closeModal('deact');
    await loadUsers();
    await loadApprovals();
  } catch(e) {
    toast(parseErr(e), 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = isOwner ? (action === 'deactivate' ? 'Deactivate Immediately' : 'Reactivate Immediately') : 'Submit Request';
  }
}

// EMERGENCY (owner only) 
async function doEmgAssignRole() {
  if (!isOwner) { toast('Owner only', 'err'); return; }
  const addr = document.getElementById('emg-role-addr').value.trim();
  const newRole = parseInt(document.getElementById('emg-role-val').value);
  if (!ethers.isAddress(addr)) { toast('Invalid address', 'err'); return; }
  if (!confirm(`⚠️ Directly assign ${RoleName[newRole]} to ${addr}? This bypasses 2FA.`)) return;

  const btn = document.getElementById('emg-role-btn');
  btn.disabled = true; btn.textContent = '…';
  try {
    const tx = await contract.assignRole(addr, newRole);
    toast('Assigning role…');
    await tx.wait();
    toast('Role assigned ✓', 'ok');
    document.getElementById('emg-role-addr').value = '';
    await loadUsers();
  } catch(e) {
    toast(parseErr(e), 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ Assign Role Immediately';
  }
}

async function doEmgDeactReact() {
  if (!isOwner) { toast('Owner only', 'err'); return; }
  const addr = document.getElementById('emg-deact-addr').value.trim();
  const action = document.getElementById('emg-deact-action').value;
  if (!ethers.isAddress(addr)) { toast('Invalid address', 'err'); return; }
  if (!confirm(`⚠️ ${action} user ${addr} immediately? This bypasses 2FA.`)) return;

  const btn = document.getElementById('emg-deact-btn');
  btn.disabled = true; btn.textContent = '…';
  try {
    const tx = action === 'deactivate'
      ? await contract.deactivateUser(addr)
      : await contract.reactivateUser(addr);
    toast(`${action === 'deactivate' ? 'Deactivating' : 'Reactivating'}…`);
    await tx.wait();
    toast(`User ${action}d ✓`, 'ok');
    document.getElementById('emg-deact-addr').value = '';
    await loadUsers();
  } catch(e) {
    toast(parseErr(e), 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ Execute Immediately';
  }
}

// LIVE EVENTS 
function setupLiveEvents() {
  contract.on(contract.filters.UserRegistered(), () => setTimeout(loadUsers, 1500));
  contract.on(contract.filters.RoleChanged(), () => setTimeout(loadUsers, 1500));
  contract.on(contract.filters.UserDeactivated(), () => setTimeout(loadUsers, 1500));
  contract.on(contract.filters.UserReactivated(), () => setTimeout(loadUsers, 1500));
  contract.on(contract.filters.CriticalActionRequested(), () => setTimeout(loadApprovals, 1500));
  contract.on(contract.filters.CriticalActionApproved(), () => setTimeout(loadApprovals, 1500));
}