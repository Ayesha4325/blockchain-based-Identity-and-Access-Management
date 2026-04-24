// Event Normalizers 
function normalizeActionLog(l) {
  if (!l.args) return null;
  const actionNum = Number(l.args.action);
  const key = 'action-' + actionNum;
  const meta = EventMeta[key] || { label: 'Action', icon: '·', cls: 'nonce' };
  return {
    source:    'action',
    eventKey:  key,
    actionNum,
    txHash:    l.transactionHash,
    blockNum:  l.blockNumber,
    logIndex:  l.index ?? l.logIndex,
    timestamp: Number(l.args.timestamp) * 1000,
    actor:     l.args.actor,
    target:    l.args.target,
    nonce:     l.args.nonce ? l.args.nonce.toString() : '—',
    label:     meta.label,
    icon:      meta.icon,
    cls:       meta.cls,
    raw:       l,
    isAnomaly: false,
  };
}

function normalizeLoginAttempt(l) {
  if (!l.args) return null;
  const success = l.args.success;
  const key = success ? 'login-ok' : 'login-fail';
  const meta = EventMeta[key];
  return {
    source:    'login',
    eventKey:  key,
    actionNum: success ? 5 : 6,
    txHash:    l.transactionHash,
    blockNum:  l.blockNumber,
    logIndex:  l.index ?? l.logIndex,
    timestamp: Number(l.args.timestamp) * 1000,
    actor:     l.args.wallet,
    target:    l.args.wallet,
    wallet:    l.args.wallet,
    nonce:     l.args.nonce ? l.args.nonce.toString() : '—',
    label:     meta.label,
    icon:      meta.icon,
    cls:       meta.cls,
    raw:       l,
    isAnomaly: false,
  };
}

function normalizeUserRegistered(l) {
  if (!l.args) return null;
  return {
    source:    'user-registered',
    eventKey:  'user-registered',
    actionNum: 0,
    txHash:    l.transactionHash,
    blockNum:  l.blockNumber,
    logIndex:  l.index ?? l.logIndex,
    timestamp: Number(l.args.timestamp) * 1000,
    actor:     l.args.wallet,
    target:    l.args.wallet,
    wallet:    l.args.wallet,
    nonce:     '—',
    identityHash: l.args.identityHash,
    label:     'Registered',
    icon:      '👤',
    cls:       'register',
    raw:       l,
    isAnomaly: false,
  };
}

function normalizeRoleChanged(l) {
  if (!l.args) return null;
  return {
    source:    'role-changed',
    eventKey:  'role-changed',
    actionNum: 1,
    txHash:    l.transactionHash,
    blockNum:  l.blockNumber,
    logIndex:  l.index ?? l.logIndex,
    timestamp: Number(l.args.timestamp) * 1000,
    actor:     l.args.actor,
    target:    l.args.user,
    wallet:    l.args.user,
    oldRole:   Number(l.args.oldRole),
    newRole:   Number(l.args.newRole),
    nonce:     '—',
    label:     'Role Changed',
    icon:      '🔑',
    cls:       'role',
    raw:       l,
    isAnomaly: false,
  };
}

function normalizeCriticalReq(l) {
  if (!l.args) return null;
  return {
    source:    'critical-req',
    eventKey:  'critical-req',
    actionNum: -1,
    txHash:    l.transactionHash,
    blockNum:  l.blockNumber,
    logIndex:  l.index ?? l.logIndex,
    timestamp: Number(l.args.expiresAt) * 1000,
    actor:     l.args.requester,
    target:    l.args.target,
    requester: l.args.requester,
    nonce:     '—',
    approvalId: l.args.approvalId,
    label:     'Critical Req.',
    icon:      '🔐',
    cls:       'critical',
    raw:       l,
    isAnomaly: false,
  };
}

function normalizeCriticalApp(l) {
  if (!l.args) return null;
  return {
    source:    'critical-app',
    eventKey:  'critical-app',
    actionNum: -2,
    txHash:    l.transactionHash,
    blockNum:  l.blockNumber,
    logIndex:  l.index ?? l.logIndex,
    timestamp: Number(l.args.timestamp) * 1000,
    actor:     l.args.approver,
    approver:  l.args.approver,
    target:    '—',
    nonce:     '—',
    approvalId: l.args.approvalId,
    label:     'Critical App.',
    icon:      '✔',
    cls:       'approved',
    raw:       l,
    isAnomaly: false,
  };
}

// Anomaly Detection 
function detectAnomalies(rows) {
  const failsByAddr = {};
  const nonceByAddr = {};
  const anomalyAddrs = new Set();

  rows.forEach(r => {
    if (r.source === 'login' && !r.raw.args.success) {
      const addr = r.actor?.toLowerCase();
      if (addr) {
        if (!failsByAddr[addr]) failsByAddr[addr] = [];
        failsByAddr[addr].push(r.timestamp);
      }
    }
    if (r.source === 'action' && r.actionNum === 4) {
      const addr = r.actor?.toLowerCase();
      if (addr) {
        if (!nonceByAddr[addr]) nonceByAddr[addr] = [];
        nonceByAddr[addr].push(r.timestamp);
      }
    }
  });

  // Check fail windows (>= 3 in 5 min)
  Object.entries(failsByAddr).forEach(([addr, times]) => {
    times.sort((a,b) => a - b);
    for (let i = 0; i <= times.length - 3; i++) {
      if (times[i + 2] - times[i] <= 300000) {
        anomalyAddrs.add(addr);
        break;
      }
    }
  });

  // Check nonce rapid-fire (>= 5 in 10 min)
  Object.entries(nonceByAddr).forEach(([addr, times]) => {
    times.sort((a,b) => a - b);
    for (let i = 0; i <= times.length - 5; i++) {
      if (times[i + 4] - times[i] <= 600000) {
        anomalyAddrs.add(addr);
        break;
      }
    }
  });

  // Tag rows
  rows.forEach(r => {
    const addr = (r.actor || r.wallet || '').toLowerCase();
    if (anomalyAddrs.has(addr)) r.isAnomaly = true;
    if (r.source === 'login' && !r.raw.args?.success) r.isAnomaly = true;
  });

  const anomalyCount = rows.filter(r => r.isAnomaly).length;
  const statAnomalies = document.getElementById('stat-anomalies');
  if (statAnomalies) statAnomalies.textContent = anomalyCount;

  // Anomaly bar (admin only)
  const anomalyBar = document.getElementById('anomaly-bar');
  if (anomalyAddrs.size > 0 && isAdmin) {
    if (anomalyBar) anomalyBar.style.display = 'flex';
    const items = document.getElementById('anomaly-items');
    if (items) {
      items.innerHTML = '';
      anomalyAddrs.forEach(addr => {
        const chip = document.createElement('span');
        chip.className = 'anomaly-chip';
        chip.textContent = addr.slice(0,10) + '…' + addr.slice(-6);
        chip.title = addr;
        chip.onclick = () => {
          const fActor = document.getElementById('f-actor');
          if (fActor) fActor.value = addr;
          if (typeof runQuery === 'function') runQuery();
        };
        items.appendChild(chip);
      });
    }
  } else {
    if (anomalyBar) anomalyBar.style.display = 'none';
  }
}

// Export CSV 
function exportCSV(data, filename) {
  if (!data || !data.length) return;
  const headers = ['Event Type','Source','Actor','Target','Nonce','Block','Timestamp','Tx Hash','Anomaly'];
  const rows = data.map(r => [
    r.label, r.source,
    r.actor || r.wallet || '',
    r.target || '',
    r.nonce, r.blockNum,
    r.timestamp ? new Date(r.timestamp).toISOString() : '',
    r.txHash || '',
    r.isAnomaly ? 'YES' : 'NO',
  ]);

  const csv = [headers, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g,'""')}"`).join(','))
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = filename || `identitymanager-audit-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('CSV exported ✓', 'ok');
}

// Export Print Report 
function exportPrintReport(data) {
  if (!data || !data.length) return;
  const now = new Date().toLocaleString();
  const contractShort = CONTRACT_ADDRESS.slice(0,10) + '…' + CONTRACT_ADDRESS.slice(-8);

  const tableRows = data.slice(0, 500).map(r => `
    <tr style="background:${r.isAnomaly ? '#fce8e8' : 'white'}">
      <td>${escHtml(r.label)}</td>
      <td style="font-family:monospace;font-size:11px">${escHtml((r.actor || r.wallet || '').slice(0,14) + '…')}</td>
      <td style="font-family:monospace;font-size:11px">${r.target && r.target !== '—' ? escHtml(r.target.slice(0,14) + '…') : '—'}</td>
      <td style="text-align:center">${r.nonce}</td>
      <td style="text-align:center">#${r.blockNum}</td>
      <td style="font-size:11px">${r.timestamp ? new Date(r.timestamp).toLocaleString() : '—'}</td>
      <td style="text-align:center;color:${r.isAnomaly ? '#d63030' : '#1a9c5b'}">${r.isAnomaly ? '⚠ YES' : 'No'}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>IdentityManager Audit Report</title>
<style>
  body { font-family: 'Segoe UI', sans-serif; color: #0d0d0d; padding: 32px; }
  h1   { font-size: 22px; font-weight: 800; margin-bottom: 4px; }
  .meta { font-family: monospace; font-size: 11px; color: #888; margin-bottom: 24px; }
  .stats { display: flex; gap: 20px; margin-bottom: 24px; }
  .stat  { background: #f4f1eb; border: 1px solid #c9c4b8; border-radius: 8px; padding: 12px 20px; min-width: 90px; text-align: center; }
  .stat .n { font-size: 22px; font-weight: 800; }
  .stat .l { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.1em; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  thead th { background: #0d0d0d; color: white; padding: 9px 12px; text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; }
  tbody tr:nth-child(even) { background: #f9f7f3; }
  tbody td { padding: 8px 12px; border-bottom: 1px solid #e0ddd6; }
  .footer { margin-top: 24px; font-family: monospace; font-size: 10px; color: #aaa; text-align: center; }
  @media print { body { padding: 16px; } }
</style></head><body>
<h1>IdentityManager · Audit Report</h1>
<div class="meta">Generated: ${now} · Contract: ${contractShort} · Total events: ${data.length}</div>
<div class="stats">
  <div class="stat"><div class="n">${data.length}</div><div class="l">Total</div></div>
  <div class="stat"><div class="n">${data.filter(r => r.source === 'login' && r.cls === 'login-ok').length}</div><div class="l">Logins</div></div>
  <div class="stat"><div class="n" style="color:#d63030">${data.filter(r => r.isAnomaly).length}</div><div class="l">Anomalies</div></div>
</div>
<table>
  <thead><tr>
    <th>Event</th><th>Actor</th><th>Target</th><th>Nonce</th><th>Block</th><th>Timestamp</th><th>Anomaly</th>
  </tr></thead>
  <tbody>${tableRows}</tbody>
</table>
<div class="footer">
  All events are permanently recorded on-chain and cannot be modified or deleted. This report is a point-in-time snapshot.
</div>
</body></html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const win  = window.open(url, '_blank');
  if (win) {
    win.addEventListener('load', () => {
      setTimeout(() => { win.print(); URL.revokeObjectURL(url); }, 300);
    });
  }
  toast('Print report opened ✓', 'ok');
}

// Copy Raw Event 
function copyRawEvent(r) {
  if (!r) return;
  const payload = {
    eventKey: r.eventKey,
    txHash: r.txHash,
    blockNumber: r.blockNum,
    timestamp: new Date(r.timestamp).toISOString(),
    actor: r.actor || r.wallet,
    target: r.target,
    nonce: r.nonce,
    approvalId: r.approvalId,
    contract: CONTRACT_ADDRESS,
  };
  navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
    .then(() => toast('Raw event JSON copied ✓', 'ok'));
}