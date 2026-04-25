const CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

// Shared State 
let provider, signer, contract, userAddress, ownerAddress;
let isOwner = false;
let isAdmin = false;
let userRole = 0;
let blockPollInterval;
let toastTimer;

// Role Maps 
const RoleName  = { 0:'None', 1:'User', 2:'Moderator', 3:'Admin' };
const RoleClass = { 0:'none', 1:'user', 2:'moderator', 3:'admin' };

// Event Maps 
const ActionName = { 0:'Registered', 1:'Role Changed', 2:'Deactivated', 3:'Reactivated', 4:'Nonce Incremented', 5:'Login ✓', 6:'Login ✗', 7:'Critical Requested', 8:'Critical Approved'};
const ActionIcon = { 0:'👤', 1:'🔑', 2:'⛔', 3:'✅', 4:'⟳', 5:'🔓', 6:'🔒' };
const ActionClass= { 0:'register', 1:'role', 2:'deactivate', 3:'reactivate', 4:'nonce', 5:'login', 6:'deactivate' };

// Event Metadata 
const EventMeta = {
  'action-0': { label: 'Registered',        icon: '👤', cls: 'register'   },
  'action-1': { label: 'Role Changed',       icon: '🔑', cls: 'role'       },
  'action-2': { label: 'Deactivated',        icon: '⛔', cls: 'deactivate' },
  'action-3': { label: 'Reactivated',        icon: '✅', cls: 'reactivate' },
  'action-4': { label: 'Nonce Incremented',  icon: '⟳', cls: 'nonce'      },
  'action-5': { label: 'Login Success',      icon: '🔓', cls: 'login-ok'   },
  'action-6': { label: 'Login Failed',       icon: '🔒', cls: 'login-fail' },
  'login-ok':  { label: 'Login Success',     icon: '🔓', cls: 'login-ok'   },
  'login-fail':{ label: 'Login Failed',      icon: '🔒', cls: 'login-fail' },
  'critical-req': { label: 'Critical Req.',  icon: '🔐', cls: 'critical'   },
  'critical-app': { label: 'Critical App.',  icon: '✔',  cls: 'approved'   },
  'user-registered': { label: 'Registered',  icon: '👤', cls: 'register'   },
  'role-changed':    { label: 'Role Changed', icon: '🔑', cls: 'role'    },
};

// Common ABI Fragments 
const COMMON_ABI = [
  "function owner() external view returns (address)",
  "function getRole(address wallet) external view returns (uint8)",
  "function isRegistered(address wallet) external view returns (bool)",
  "function hasRole(address wallet, uint8 role) external view returns (bool)",
  "function getUserDetails(address wallet) external view returns (tuple(address walletAddress, uint8 role, bytes32 identityHash, bool isActive, uint256 nonce))",
  "function getNonce(address wallet) external view returns (uint256)",
  "function isActiveUser(address wallet) external view returns (bool)",
  "function assignRole(address target, uint8 newRole) external",
  "function deactivateUser(address target) external",
  "function reactivateUser(address target) external",
  "function requestCriticalAction(address target, uint8 actionType, bytes32 actionData) external returns (bytes32)",
  "function approveCriticalAction(bytes32 approvalId) external",
  "function buildApprovalId(address requester, address target, uint8 actionType, bytes32 actionData) external view returns (bytes32)",
  "function getApprovalRequest(bytes32 approvalId) external view returns (tuple(bool exists, bool isApproved, address requester, address target, uint8 actionType, bytes32 actionData, uint256 requestedAt, uint256 approvedAt, address approver))",
  "function getSecondaryWallet(address wallet) external view returns (address)",
  "function setSecondaryWallet(address secondary) external",
  "function incrementNonce() external returns (uint256)",
  "function registerUser(bytes32 identityHash) external returns (bool)",
  "function generateNonce(address wallet) external view returns (string memory)",
  "function verifySignature(bytes calldata signature) external returns (bool)",
  "event ActionLogged(address indexed actor, address indexed target, uint8 indexed action, uint256 nonce, uint256 timestamp)",
  "event LoginAttempt(address indexed wallet, bool success, uint256 nonce, uint256 timestamp)",
  "event UserRegistered(address indexed wallet, bytes32 identityHash, uint256 timestamp)",
  "event RoleChanged(address indexed user, uint8 oldRole, uint8 newRole, address indexed actor, uint256 timestamp)",
  "event UserDeactivated(address indexed user, address indexed actor, uint256 timestamp)",
  "event UserReactivated(address indexed user, address indexed actor, uint256 timestamp)",
  "event CriticalActionRequested(bytes32 indexed approvalId, address indexed requester, address indexed target, uint8 actionType, uint256 expiresAt)",
  "event CriticalActionApproved(bytes32 indexed approvalId, address indexed approver, uint256 timestamp)",
  "event SecondaryWalletSet(address indexed primary, address indexed secondary, uint256 timestamp)"
];

// Wallet Connection 
async function connectWallet() {
  if (!window.ethereum) {
    toast('MetaMask not detected — install it to continue.', 'err');
    return false;
  }
  try {
    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    signer      = await provider.getSigner();
    userAddress = await signer.getAddress();
    contract    = new ethers.Contract(CONTRACT_ADDRESS, COMMON_ABI, signer);

    const code = await provider.getCode(CONTRACT_ADDRESS);
    if (code === '0x') {
      toast('No contract found at ' + CONTRACT_ADDRESS.slice(0,10) + '…', 'err');
      return false;
    }

    const network = await provider.getNetwork();
    const netName = network.name === 'unknown' ? 'Chain ' + network.chainId : network.name;

    // Update UI elements that exist
    const chainLabel = document.getElementById('chain-label');
    if (chainLabel) chainLabel.textContent = netName;

    const chainDot = document.getElementById('chain-dot');
    if (chainDot) chainDot.classList.add('live');

    const hdrDot = document.getElementById('hdr-dot');
    if (hdrDot) hdrDot.classList.add('live');

    const hdrNetwork = document.getElementById('hdr-network');
    if (hdrNetwork) hdrNetwork.textContent = netName;

    const contractLabel = document.getElementById('contract-label');
    if (contractLabel) contractLabel.textContent = 'Contract: ' + CONTRACT_ADDRESS.slice(0,10) + '…' + CONTRACT_ADDRESS.slice(-8);

    // Setup listeners
    window.ethereum.on('accountsChanged', () => location.reload());
    window.ethereum.on('chainChanged',    () => location.reload());

    return true;
  } catch (e) {
    toast(parseErr(e), 'err');
    return false;
  }
}

async function queryFilterChunked(filter, chunkSize = 2000) {
  const latest = await provider.getBlockNumber();
  const results = [];
  for (let from = 0; from <= latest; from += chunkSize) {
    const to = Math.min(from + chunkSize - 1, latest);
    const logs = await contract.queryFilter(filter, from, to);
    results.push(...logs);
  }
  return results;
}

// Initialize with access check 
async function initWithCheck(requiredRole = 0, requireRegistered = false) {
  const ok = await connectWallet();
  if (!ok) return false;

  try {
    ownerAddress = await contract.owner();
    isOwner = userAddress.toLowerCase() === ownerAddress.toLowerCase();
    userRole = Number(await contract.getRole(userAddress));
    isAdmin = userRole >= 3;

    if (requireRegistered) {
      const registered = await contract.isRegistered(userAddress);
      if (!registered) {
        showLoadingError(
          'Wallet not registered.<br><br>' +
          '<a href="register.html" style="color:var(--accent2)">Register first →</a>'
        );
        return false;
      }
    }

    if (requiredRole > 0 && userRole < requiredRole && !isOwner) {
      showLoadingError(
        'Access Denied — Admin role required.<br><br>' +
        '<a href="dashboard.html" style="color:var(--accent2)">← Back to Dashboard</a>'
      );
      return false;
    }

    // Update header address
    const hdrAddr = document.getElementById('hdr-addr');
    if (hdrAddr) hdrAddr.textContent = userAddress.slice(0,8) + '…' + userAddress.slice(-6);

    // Update role badge
    const roleBadge = document.getElementById('role-badge');
    if (roleBadge) {
      roleBadge.textContent = isAdmin ? 'Admin' : 'User';
      if (isAdmin) roleBadge.classList.add('admin');
    }

    // Show admin link if admin
    if (isAdmin) {
      const adminLink = document.getElementById('admin-link');
      if (adminLink) adminLink.style.display = 'inline-flex';
    }

    // Show owner chip
    if (isOwner) {
      const ownerChip = document.getElementById('owner-chip');
      if (ownerChip) ownerChip.style.display = 'inline-flex';
    }

    startBlockPolling();
    return true;
  } catch (e) {
    showLoadingError(parseErr(e));
    return false;
  }
}

// Block Polling 
function startBlockPolling() {
  const update = async () => {
    try {
      const blockNum = await provider.getBlockNumber();
      const el = document.getElementById('block-num');
      if (el) el.textContent = '#' + blockNum;
    } catch(e) {}
  };
  update();
  blockPollInterval = setInterval(update, 4000);
}

// Toast 
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast show' + (type === 'err' ? ' err' : type === 'ok' ? ' ok' : type === 'warn' ? ' warn' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

// Error Parser 
function parseErr(e) {
  if (e.reason) return e.reason;
  const m = e.message || '';
  const c = m.match(/reverted with custom error '([^']+)'/);
  if (c) return c[1];
  const r = m.match(/reason="([^"]+)"/);
  if (r) return r[1];
  if (m.includes('user rejected')) return 'Rejected by user';
  return m.length > 100 ? m.slice(0, 100) + '…' : m || 'Transaction failed';
}

// HTML Escape 
function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}

// Loading Error 
function showLoadingError(msg) {
  const screen = document.getElementById('loading-screen');
  if (screen) {
    screen.innerHTML = `
      <div style="font-family:var(--mono);font-size:14px;color:var(--error);text-align:center;max-width:380px;line-height:1.8;padding:24px">
        <div style="font-size:28px;margin-bottom:14px">🚫</div>
        ${msg}
      </div>`;
  }
}

// Hide Loading 
function hideLoading() {
  const screen = document.getElementById('loading-screen');
  const app = document.getElementById('app');
  if (screen) screen.classList.add('hidden');
  if (app) app.style.display = 'grid';
}

// Address Shortener 
function addrShort(addr) {
  if (!addr || addr === '—') return '—';
  if (addr.length < 15) return addr;
  return addr.slice(0, 10) + '…' + addr.slice(-6);
}

// TX Explorer Link 
function getTxLink(hash) {
  if (!hash) return null;
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
    const base = map[chainId];
    return base ? base + hash : null;
  } catch { return null; }
}

// Copy to Clipboard 
function copyToClipboard(text, successMsg = 'Copied ✓') {
  navigator.clipboard.writeText(text).then(() => toast(successMsg, 'ok'));
}

// Copy Address 
function copyAddr(addr) {
  copyToClipboard(addr, 'Address copied');
}

// Disconnect 
function disconnect() {
  clearInterval(blockPollInterval);
  window.location.href = 'login.html';
}

// Update Timestamp 
function updateTimestamp(id = 'last-refresh') {
  const el = document.getElementById(id);
  if (el) el.textContent = 'Updated ' + new Date().toLocaleTimeString();
}