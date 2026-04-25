const CONTRACT_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

const LOGIN_ABI = [
  'function generateNonce(address wallet) external view returns (string memory)',
  'function getNonce(address wallet) external view returns (uint256)',
  'function verifySignature(bytes calldata signature) external returns (bool)',
  'function isRegistered(address wallet) external view returns (bool)',
  'event LoginAttempt(address indexed wallet, bool success, uint256 nonce, uint256 timestamp)',
];

let provider, signer, contract, userAddress;
let currentNonce = null;
let nonceFetched = false;
let toastTimer;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// TOAST
function toast(msg, isErr = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
}

// STEP FLOW
function setStep(stepId, lineId, state) {
  const step = document.getElementById(stepId);
  const line = lineId ? document.getElementById(lineId) : null;
  step.className = 'step ' + state;
  if (line && state === 'done') line.classList.add('done');
}

function advanceToStep(num) {
  if (num >= 1) setStep('step-connect', 'line-1', 'done');
  if (num >= 2) setStep('step-fetch', 'line-2', num > 2 ? 'done' : 'active');
  if (num >= 3) setStep('step-sign', null, 'active');
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
    contract    = new ethers.Contract(CONTRACT_ADDRESS, LOGIN_ABI, signer);

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

    document.getElementById('fetch-btn').disabled = false;
    advanceToStep(2);
    toast('Wallet connected — ' + userAddress.slice(0, 6) + '…' + userAddress.slice(-4));

    // Registration check
    try {
      const isReg = await contract.isRegistered(userAddress);
      if (!isReg) {
        toast('Wallet not registered. Go to Register first.', true);
        document.getElementById('fetch-btn').disabled = true;
      }
    } catch (e) { console.warn('isRegistered check failed:', parseErr(e)); }

    window.ethereum.on('accountsChanged', () => location.reload());
    window.ethereum.on('chainChanged',    () => location.reload());
  } catch (e) {
    toast(parseErr(e), true);
  }
}

// FETCH NONCE
async function fetchNonce() {
  if (!signer) { toast('Connect your wallet first', true); return; }
  const fetchBtn = document.getElementById('fetch-btn');
  fetchBtn.textContent = '…';
  fetchBtn.disabled    = true;

  try {
    currentNonce = await contract.getNonce(userAddress);

    const nonceEl = document.getElementById('nonce-val');
    nonceEl.classList.add('loading');
    setTimeout(() => { nonceEl.textContent = currentNonce.toString(); nonceEl.classList.remove('loading'); }, 200);

    const tag = document.getElementById('nonce-tag');
    tag.textContent = 'Fresh';
    tag.className   = 'nonce-tag fresh';

    nonceFetched = true;
    document.getElementById('sign-btn').disabled = false;
    fetchBtn.textContent = 'Refresh';
    fetchBtn.disabled    = false;

    advanceToStep(3);
    toast('Nonce fetched: ' + currentNonce);
  } catch (e) {
    fetchBtn.textContent = 'Fetch nonce';
    fetchBtn.disabled    = false;
    toast(parseErr(e), true);
  }
}

// SIGN IN
async function signIn() {
  if (!signer)                              { toast('Connect your wallet first', true); return; }
  if (!nonceFetched || currentNonce === null) { toast('Fetch nonce first', true); return; }

  const btn = document.getElementById('sign-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Awaiting signature…';
  hideResult();

  try {
    const chainId = (await provider.getNetwork()).chainId;
    const addr    = await contract.getAddress();

    const message =
      `Sign in to UserRegistry\n` +
      `Wallet: ${userAddress.toLowerCase()}\n` +
      `Nonce: ${currentNonce}\n` +
      `Contract: ${addr.toLowerCase()}\n` +
      `Chain ID: ${chainId}`;

    const sig = await signer.signMessage(message);

    btn.innerHTML = '<span class="spinner"></span> Verifying on-chain…';
    toast('Transaction submitted — waiting for confirmation…');

    const tx      = await contract.verifySignature(sig);
    const receipt = await tx.wait();
    const nonceUsed = currentNonce;

    // Update nonce display
    currentNonce = currentNonce + 1n;
    document.getElementById('nonce-val').textContent = currentNonce.toString();
    const tag = document.getElementById('nonce-tag');
    tag.textContent = 'Used';
    tag.className   = 'nonce-tag';
    nonceFetched = false;
    document.getElementById('sign-btn').disabled = true;

    showResult('success', '✓', 'Authentication successful', [
      { label: 'Wallet',    val: userAddress },
      { label: 'Nonce used', val: nonceUsed.toString() },
      { label: 'Block',     val: '#' + receipt.blockNumber },
      { label: 'Gas used',  val: receipt.gasUsed.toString() + ' gas' },
      { label: 'Tx hash',   val: receipt.hash, link: getTxLink(receipt.hash) },
    ]);

    btn.classList.add('success-state');
    btn.innerHTML = '✓ Signed in';
    toast('Signed in successfully! 🎉 Redirecting…');
    setStep('step-sign', null, 'done');

    setTimeout(() => { window.location.href = 'dashboard.html'; }, 1500);
  } catch (e) {
    const msg = parseErr(e);
    showResult('error', '✕', 'Sign-in failed', [{ label: 'Reason', val: msg }]);
    toast(msg, true);
    btn.disabled = false;
    btn.classList.remove('success-state');
    btn.innerHTML = 'Sign in ↗';
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
    const chainId = parseInt(window.ethereum.chainId, 16);
    const map = {
      1: 'https://etherscan.io/tx/',
      11155111: 'https://sepolia.etherscan.io/tx/',
      5: 'https://goerli.etherscan.io/tx/',
      137: 'https://polygonscan.com/tx/',
      80001: 'https://mumbai.polygonscan.com/tx/',
      31337: null,
    };
    return (map[chainId] || null) ? map[chainId] + hash : null;
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