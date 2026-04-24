let pendingApprovals = [];

// BOOT
window.addEventListener('DOMContentLoaded', async () => {
  if (!window.ethereum) { showError('MetaMask not found. Please install it.'); return; }
  try {
    provider    = new ethers.BrowserProvider(window.ethereum);
    await provider.send('eth_requestAccounts', []);
    signer      = await provider.getSigner();
    userAddress = await signer.getAddress();
    contract    = new ethers.Contract(CONTRACT_ADDRESS, COMMON_ABI, signer);

    const code = await provider.getCode(CONTRACT_ADDRESS);
    if (code === '0x') { showError('No contract at ' + CONTRACT_ADDRESS); return; }

    ownerAddress = await contract.owner();
    isOwner = userAddress.toLowerCase() === ownerAddress.toLowerCase();

    await loadAll();
    setupEventListeners();
    startBlockPolling();

    document.getElementById('loading-screen').classList.add('hidden');
    document.getElementById('app').style.display = 'grid';

    window.ethereum.on('accountsChanged', () => location.reload());
    window.ethereum.on('chainChanged',    () => location.reload());
  } catch (e) {
    showError(parseErr(e));
  }
});

async function loadAll() {
  await Promise.all([
    loadIdentityHeader(),
    loadSecurityBar(),
    loadMfaCard(),
    loadActivity(),
    loadPendingApprovals(),
  ]);
  updateTimestamp();
}

// IDENTITY HEADER
async function loadIdentityHeader() {
  try {
    const user  = await contract.getUserDetails(userAddress);
    const role  = Number(user.role);
    const short = userAddress.slice(0, 8) + '…' + userAddress.slice(-6);

    document.getElementById('id-wallet').textContent = short;

    const badge = document.getElementById('id-role-badge');
    badge.textContent = RoleName[role] || 'Unknown';
    badge.className   = 'role-badge ' + (RoleClass[role] || 'user');

    const dot = document.getElementById('id-status-dot');
    const txt = document.getElementById('id-status-text');
    if (user.isActive) { dot.className = 'status-dot active'; txt.textContent = 'Active'; }
    else               { dot.className = 'status-dot inactive'; txt.textContent = 'Inactive'; }

    document.getElementById('id-nonce').textContent  = user.nonce.toString();
    document.getElementById('sec-nonce').textContent = user.nonce.toString();

    if (role >= 3) {
      document.getElementById('btn-req-action').style.display = 'flex';
      document.getElementById('btn-approve').style.display    = 'flex';

      const headerRight = document.querySelector('.header-right');
      if (headerRight && !document.getElementById('admin-link')) {
        const adminLink = document.createElement('a');
        adminLink.id        = 'admin-link';
        adminLink.href      = 'admin.html';
        adminLink.className = 'nav-btn';
        adminLink.textContent = '↖ Admin Panel';
        headerRight.insertBefore(adminLink, headerRight.firstChild);
      }
    }
    return user;
  } catch (e) { console.error('loadIdentityHeader', e); }
}

// SECURITY STATUS BAR
async function loadSecurityBar() {
  try {
    const secondary = await contract.getSecondaryWallet(userAddress);
    const hasMfa    = secondary && secondary !== ethers.ZeroAddress;

    const mfaEl = document.getElementById('sec-mfa');
    mfaEl.textContent = hasMfa ? 'Configured ✓' : 'Not Set';
    mfaEl.className   = 'sec-item-val ' + (hasMfa ? 'ok' : 'warn');

    const filter = contract.filters.ActionLogged(null, userAddress);
    const logs   = await contract.queryFilter(filter);
    const logins = logs
      .filter(l => l.args && Number(l.args.action) === 5)
      .sort((a, b) => Number(b.args.timestamp) - Number(a.args.timestamp));

    const llEl = document.getElementById('sec-last-login');
    if (logins.length > 0) {
      llEl.textContent = new Date(Number(logins[0].args.timestamp) * 1000).toLocaleString();
      llEl.className   = 'sec-item-val ok';
    } else {
      llEl.textContent = 'No logins yet';
      llEl.className   = 'sec-item-val warn';
    }

    const network = await provider.getNetwork();
    const netName = network.name === 'unknown' ? 'Chain ' + network.chainId : network.name;
    document.getElementById('hdr-network').textContent   = netName;
    document.getElementById('chain-label').textContent   = netName;
    document.getElementById('hdr-dot').className         = 'chain-dot live';
    document.getElementById('chain-dot').className       = 'chain-dot live';
    document.getElementById('contract-label').textContent =
      'Contract: ' + CONTRACT_ADDRESS.slice(0, 10) + '…' + CONTRACT_ADDRESS.slice(-8);
  } catch (e) { console.error('loadSecurityBar', e); }
}

// ACTIVITY STREAM
async function loadActivity() {
  const listEl = document.getElementById('activity-list');
  listEl.innerHTML = '<div class="act-empty"><span class="spinner"></span></div>';
  try {
    const logs = await contract.queryFilter(contract.filters.ActionLogged(null, userAddress));
    const sorted = logs
      .filter(l => l.args)
      .sort((a, b) => Number(b.args.timestamp) - Number(a.args.timestamp))
      .slice(0, 30);

    if (sorted.length === 0) { listEl.innerHTML = '<div class="act-empty">No activity found</div>'; return; }
    listEl.innerHTML = '';
    sorted.forEach(log => listEl.appendChild(buildActivityItem(log)));
  } catch (e) {
    listEl.innerHTML = '<div class="act-empty">Failed to load events</div>';
    console.error('loadActivity', e);
  }
}

function buildActivityItem(log) {
  const type = Number(log.args.action);
  const ts   = Number(log.args.timestamp) * 1000;
  const el   = document.createElement('div');
  el.className = 'activity-item';
  el.innerHTML = `
    <div class="act-icon ${ActionClass[type] || 'nonce'}">${ActionIcon[type] || '·'}</div>
    <div class="act-body">
      <div class="act-title">${ActionName[type] || 'Action'}</div>
      <div class="act-time">${new Date(ts).toLocaleString()} · nonce ${log.args.nonce}</div>
    </div>
  `;
  return el;
}

// PENDING APPROVALS
async function loadPendingApprovals() {
  const listEl  = document.getElementById('approvals-list');
  const countEl = document.getElementById('approvals-count');
  const dotEl   = document.getElementById('approvals-dot');

  try {
    const reqLogs     = await contract.queryFilter(contract.filters.CriticalActionRequested());
    const appLogs     = await contract.queryFilter(contract.filters.CriticalActionApproved());
    const approvedIds = new Set(appLogs.map(l => l.args.approvalId));

    const secondary = await contract.getSecondaryWallet(userAddress);
    const role      = Number(await contract.getRole(userAddress));
    const isAdminL  = role >= 3;
    const isOwnerL  = userAddress.toLowerCase() === ownerAddress.toLowerCase();

    const pending = [];
    for (const log of reqLogs) {
      const id = log.args.approvalId;
      if (approvedIds.has(id)) continue;
      try {
        const req = await contract.getApprovalRequest(id);
        if (!req.exists || req.isApproved) continue;
        const expiresAt = Number(log.args.expiresAt) * 1000;
        if (Date.now() > expiresAt) continue;
        if (req.requester.toLowerCase() === userAddress.toLowerCase()) continue;

        const reqSec    = await contract.getSecondaryWallet(req.requester);
        const hasSec    = reqSec && reqSec !== ethers.ZeroAddress;
        const canApprove = hasSec
          ? userAddress.toLowerCase() === reqSec.toLowerCase()
          : isAdminL || isOwnerL;

        if (canApprove) pending.push({ id, req, expiresAt, log });
      } catch (e) { continue; }
    }

    countEl.textContent = pending.length;
    if (pending.length > 0) dotEl.classList.add('live');

    if (pending.length === 0) { listEl.innerHTML = '<div class="ap-empty">No pending approvals</div>'; return; }
    listEl.innerHTML = '';
    pending.forEach(({ id, req, expiresAt }) => {
      const actionType = Number(req.actionType);
      const typeName   = actionType === 0 ? 'Role Change' : 'Deactivation';
      const typeClass  = actionType === 0 ? 'role-change' : 'deactivation';
      const ttlMin     = Math.max(0, Math.round((expiresAt - Date.now()) / 60000));
      const el         = document.createElement('div');
      el.className = 'approval-item';
      el.innerHTML = `
        <div class="ap-header">
          <span class="ap-type ${typeClass}">${typeName}</span>
          <span class="ap-ttl">Expires in ~${ttlMin}m</span>
        </div>
        <div class="ap-target">Target: ${req.target.slice(0, 10)}…${req.target.slice(-6)}</div>
        <div class="ap-target" style="font-size:10px;margin-top:2px">ID: ${id.slice(0, 14)}…</div>
        <button class="ap-approve-btn" onclick="doApproveById('${id}')">Approve ✓</button>
      `;
      listEl.appendChild(el);
    });
    pendingApprovals = pending;
  } catch (e) {
    listEl.innerHTML = '<div class="ap-empty">Could not load approvals</div>';
    console.error('loadPendingApprovals', e);
  }
}

// MFA CARD
async function loadMfaCard() {
  try {
    const secondary = await contract.getSecondaryWallet(userAddress);
    const has       = secondary && secondary !== ethers.ZeroAddress;
    const iconEl    = document.getElementById('mfa-icon');
    const valEl     = document.getElementById('mfa-wallet-display');

    if (has) {
      iconEl.className = 'mfa-icon set'; iconEl.textContent = '🔐';
      valEl.className  = 'mfa-val set';
      valEl.textContent = secondary.slice(0, 10) + '…' + secondary.slice(-8);
    } else {
      iconEl.className = 'mfa-icon unset'; iconEl.textContent = '🔓';
      valEl.className  = 'mfa-val unset';
      valEl.textContent = 'No secondary wallet linked';
    }

    const mfaEl = document.getElementById('sec-mfa');
    mfaEl.textContent = has ? 'Configured ✓' : 'Not Set';
    mfaEl.className   = 'sec-item-val ' + (has ? 'ok' : 'warn');
  } catch (e) { console.error('loadMfaCard', e); }
}

// ACTIONS
async function doIncrementNonce() {
  const btn = document.getElementById('btn-inc-nonce');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span><span class="btn-label">Processing…</span>';
  try {
    const tx = await contract.incrementNonce();
    toast('Transaction submitted…');
    await tx.wait();
    toast('Nonce incremented ✓', 'ok');
    await loadIdentityHeader();
  } catch (e) {
    toast(parseErr(e), 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">⟳</span><span class="btn-label">Increment Nonce</span><span class="btn-arrow">→</span>';
  }
}

async function doSetSecondaryWallet() {
  const addr = document.getElementById('mfa-input').value.trim();
  if (!addr)                    { toast('Enter a wallet address', 'warn'); return; }
  if (!ethers.isAddress(addr)) { toast('Invalid address', 'err'); return; }

  const btn = document.getElementById('mfa-set-btn');
  btn.disabled = true; btn.textContent = '…';
  try {
    const tx = await contract.setSecondaryWallet(addr);
    toast('Setting secondary wallet…');
    await tx.wait();
    toast('Secondary wallet set ✓', 'ok');
    document.getElementById('mfa-input').value = '';
    await loadMfaCard();
  } catch (e) {
    toast(parseErr(e), 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Set Wallet';
  }
}

async function doClearSecondaryWallet() {
  if (!confirm('Clear your secondary wallet? This removes 2FA protection.')) return;
  const btn = document.getElementById('mfa-clear-btn');
  btn.disabled = true;
  try {
    const tx = await contract.setSecondaryWallet(ethers.ZeroAddress);
    toast('Clearing secondary wallet…');
    await tx.wait();
    toast('Secondary wallet cleared', 'ok');
    await loadMfaCard();
  } catch (e) {
    toast(parseErr(e), 'err');
  } finally {
    btn.disabled = false;
  }
}

async function doRequestCriticalAction() {
  const actionType = parseInt(document.getElementById('req-action-type').value);
  const target     = document.getElementById('req-target').value.trim();
  if (!ethers.isAddress(target)) { toast('Invalid target address', 'err'); return; }

  const actionData = actionType === 0
    ? ethers.zeroPadValue(ethers.toBeHex(parseInt(document.getElementById('req-new-role').value)), 32)
    : ethers.zeroPadValue(target.toLowerCase(), 32);

  const btn = document.getElementById('req-submit-btn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Submitting…';
  try {
    const tx = await contract.requestCriticalAction(target, actionType, actionData);
    toast('Requesting critical action…');
    await tx.wait();
    const approvalId = await contract.buildApprovalId(userAddress, target, actionType, actionData);
    closeModal('request-action');
    toast('Action requested ✓ · ID: ' + approvalId.slice(0, 12) + '…', 'ok');
    await loadPendingApprovals();
  } catch (e) {
    toast(parseErr(e), 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Submit Request';
  }
}

async function doApproveById(id) {
  try {
    const tx = await contract.approveCriticalAction(id);
    toast('Approving…');
    await tx.wait();
    toast('Approved ✓', 'ok');
    await loadPendingApprovals();
    await loadActivity();
  } catch (e) { toast(parseErr(e), 'err'); }
}

async function doApproveCriticalAction() {
  const id = document.getElementById('approve-id-input').value.trim();
  if (!id) { toast('Enter an approval ID', 'warn'); return; }

  const btn = document.getElementById('approve-submit-btn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Approving…';
  try {
    const tx = await contract.approveCriticalAction(id);
    toast('Approving critical action…');
    await tx.wait();
    closeModal('approve-action');
    toast('Critical action approved ✓', 'ok');
    await loadPendingApprovals();
    await loadActivity();
  } catch (e) {
    toast(parseErr(e), 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Approve';
  }
}

function onReqActionTypeChange() {
  const type = parseInt(document.getElementById('req-action-type').value);
  document.getElementById('req-role-field').style.display = type === 0 ? 'block' : 'none';
}
function openRequestActionModal() {
  document.getElementById('req-action-type').value = '0';
  onReqActionTypeChange();
  openModal('request-action');
}

// LIVE LISTENERS
function setupEventListeners() {
  contract.on(contract.filters.ActionLogged(null, userAddress), (actor, target, action, nonce, timestamp, event) => {
    const listEl = document.getElementById('activity-list');
    const item   = buildActivityItem(event.log);
    if (listEl.firstChild?.className === 'act-empty') listEl.innerHTML = '';
    listEl.prepend(item);
    document.getElementById('id-nonce').textContent  = nonce.toString();
    document.getElementById('sec-nonce').textContent = nonce.toString();
    toast('New event: ' + (ActionName[Number(action)] || 'Action'));
  });

  contract.on(contract.filters.CriticalActionRequested(), () => setTimeout(loadPendingApprovals, 1000));
  contract.on(contract.filters.CriticalActionApproved(),  () => setTimeout(loadPendingApprovals, 1000));
  contract.on(contract.filters.SecondaryWalletSet(userAddress), () => loadMfaCard());
}

// BLOCK POLLING
function startBlockPolling() {
  const update = async () => {
    try {
      const block = await provider.getBlockNumber();
      document.getElementById('block-num').textContent = '#' + block;
    } catch (e) {}
  };
  update();
  blockPollInterval = setInterval(update, 4000);
}

// HELPERS
function updateTimestamp() {
  const el = document.getElementById('last-refresh');
  if (el) el.textContent = 'Updated ' + new Date().toLocaleTimeString();
}

function disconnect() {
  clearInterval(blockPollInterval);
  window.location.href = 'login.html';
}

function showError(msg) {
  const screen = document.getElementById('loading-screen');
  if (screen) screen.innerHTML = `
    <div style="font-family:var(--mono);font-size:14px;color:var(--error);text-align:center;max-width:360px;line-height:1.7">
      <div style="font-size:24px;margin-bottom:12px">⚠</div>
      ${msg}
      <br><br>
      <a href="login.html" style="color:var(--accent2)">← Back to Login</a>
    </div>`;
}