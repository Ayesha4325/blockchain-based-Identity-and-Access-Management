const CONTRACT_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

const REGISTER_ABI = [
  'function registerUser(bytes32 identityHash) external returns (bool)',
  'function isRegistered(address wallet) external view returns (bool)',
  'event UserRegistered(address indexed wallet, bytes32 identityHash, uint256 timestamp)',
];

let provider, signer, contract, userAddress;
let listenersAttached = false;
let toastTimer;

// HELPERS
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function toast(msg, isErr = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
}

// KYC INPUT
function onKycInput(val) {
  const preview  = document.getElementById('hash-preview');
  const badge    = document.getElementById('hash-badge');
  const btn      = document.getElementById('reg-btn');
  const sanitized = val.replace(/[<>"']/g, '');

  if (sanitized !== val) {
    document.getElementById('kyc-input').value = sanitized;
    return;
  }
  if (!sanitized.trim()) {
    preview.value     = '';
    badge.textContent = '—';
    badge.className   = 'hash-badge';
    btn.disabled      = true;
    return;
  }
  const hash        = ethers.keccak256(ethers.toUtf8Bytes(sanitized.trim()));
  preview.value     = hash;
  badge.textContent = 'Ready';
  badge.className   = 'hash-badge ready';
  btn.disabled      = !userAddress;
}

// CONNECT WALLET
async function connectWallet() {
  if (!window.ethereum) {
    toast('MetaMask not detected — install it to continue.', true);
    return;
  }
  try {
    provider    = new ethers.BrowserProvider(window.ethereum);
    await provider.send('eth_requestAccounts', []);
    signer      = await provider.getSigner();
    userAddress = await signer.getAddress();
    contract    = new ethers.Contract(CONTRACT_ADDRESS, REGISTER_ABI, signer);

    const code = await provider.getCode(CONTRACT_ADDRESS);
    if (code === '0x') {
      toast('No contract found at ' + CONTRACT_ADDRESS.slice(0, 10) + '…', true);
      return;
    }

    const network = await provider.getNetwork();

    // Header button
    document.getElementById('connect-label').textContent = userAddress.slice(0, 6) + '…' + userAddress.slice(-4);
    document.getElementById('connect-btn').classList.add('live');

    // Wallet strip
    document.getElementById('wallet-addr').textContent = userAddress;
    const pill = document.getElementById('wallet-pill');
    pill.textContent = 'Live';
    pill.classList.add('live');

    // Footer
    document.getElementById('chain-dot').classList.add('live');
    const netName = network.name === 'unknown' ? 'Chain ' + network.chainId : network.name;
    document.getElementById('chain-label').textContent    = netName;
    document.getElementById('contract-label').textContent =
      'Contract: ' + CONTRACT_ADDRESS.slice(0, 10) + '…' + CONTRACT_ADDRESS.slice(-6);

    const kycVal = document.getElementById('kyc-input').value;
    document.getElementById('reg-btn').disabled = !kycVal.trim();

    toast('Wallet connected — ' + userAddress.slice(0, 6) + '…' + userAddress.slice(-4));

    // Already-registered check
    try {
      const already = await contract.isRegistered(userAddress);
      if (already) {
        showResult('error', '⚠', 'Already registered', [
          { label: 'Wallet', val: userAddress },
          { label: 'Note',   val: 'This wallet is already registered on-chain.' },
        ]);
        document.getElementById('reg-btn').disabled = true;
      }
    } catch (e) { console.warn('isRegistered check failed:', parseErr(e)); }

    if (!listenersAttached) {
      window.ethereum.on('accountsChanged', () => location.reload());
      window.ethereum.on('chainChanged',    () => location.reload());
      listenersAttached = true;
    }
  } catch (e) {
    toast(parseErr(e), true);
  }
}

// REGISTER USER
async function registerUser() {
  if (!signer) { toast('Connect your wallet first', true); return; }
  const kycLabel = document.getElementById('kyc-input').value.trim();
  if (!kycLabel) { toast('Enter an identity label', true); return; }

  const hash = ethers.keccak256(ethers.toUtf8Bytes(kycLabel));
  const btn  = document.getElementById('reg-btn');
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span> Awaiting signature…';
  hideResult();

  try {
    const tx = await contract.registerUser(hash);
    btn.innerHTML = '<span class="spinner"></span> Confirming block…';
    toast('Transaction submitted — waiting for confirmation…');

    const receipt = await tx.wait();
    showResult('success', '✓', 'Registration successful', [
      { label: 'Wallet',        val: userAddress },
      { label: 'Identity hash', val: hash },
      { label: 'Block',         val: '#' + receipt.blockNumber },
      { label: 'Gas used',      val: receipt.gasUsed.toString() + ' gas' },
      { label: 'Tx hash',       val: receipt.hash, link: getTxLink(receipt.hash) },
    ]);
    toast('Registered successfully! Redirecting…');
    btn.innerHTML = '✓ Registered';

    setTimeout(() => { window.location.href = 'login.html'; }, 1500);
  } catch (e) {
    const msg = parseErr(e);
    showResult('error', '✕', 'Registration failed', [{ label: 'Reason', val: msg }]);
    toast(msg, true);
    btn.disabled  = false;
    btn.innerHTML = 'Register identity ↗';
  }
}

// RESULT PANEL
function showResult(type, icon, title, rows) {
  const panel = document.getElementById('result-panel');
  document.getElementById('result-icon').textContent  = icon;
  document.getElementById('result-title').textContent = title;
  document.getElementById('result-rows').innerHTML = rows.map(r => `
    <div class="result-row">
      <div class="result-row-label">${escapeHtml(r.label)}</div>
      ${r.link
        ? `<a class="tx-link" href="${escapeHtml(r.link)}" target="\_blank">${escapeHtml(r.val.slice(0, 20))}…${escapeHtml(r.val.slice(-12))} ↗</a>`
        : `<div class="result-row-val">${escapeHtml(r.val)}</div>`}
    </div>
  `).join('');
  panel.className    = 'result-panel ' + type;
  panel.style.display = 'block';
}

function hideResult() {
  document.getElementById('result-panel').style.display = 'none';
}

// HELPERS
function getTxLink(hash) {
  try {
    const chainId  = parseInt(window.ethereum.chainId, 16);
    const explorers = {
      1:        'https://etherscan.io/tx/',
      11155111: 'https://sepolia.etherscan.io/tx/',
      5:        'https://goerli.etherscan.io/tx/',
      137:      'https://polygonscan.com/tx/',
      80001:    'https://mumbai.polygonscan.com/tx/',
      31337:    null,
    };
    const base = explorers[chainId];
    return base ? base + hash : null;
  } catch { return null; }
}

function parseErr(e) {
  if (e.reason) return e.reason;
  const m = e.message || '';
  const custom = m.match(/reverted with custom error '([^']+)'/);
  if (custom) return custom[1];
  const reason = m.match(/reason="([^"]+)"/);
  if (reason) return reason[1];
  if (m.includes('user rejected')) return 'Transaction rejected by user';
  return m.length > 90 ? m.slice(0, 90) + '…' : m || 'Transaction failed';
}