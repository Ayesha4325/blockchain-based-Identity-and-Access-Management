Identity Security Framework
A full-stack, on-chain identity and access control system built with Solidity and Hardhat. Users register a KYC identity hash to their wallet, authenticate via ECDSA signature verification (no passwords, no email), and admins manage roles and user lifecycle through a 2FA-gated approval workflow — all permanently logged on-chain.
A production-grade frontend (vanilla JS + ethers.js v6) provides a dashboard, admin console, and immutable audit viewer.

# Overview
Identity Security Framework replaces username/password auth with cryptographic wallet signatures. The contract stores a `keccak256` identity hash per wallet (your raw KYC label never touches the chain), issues a per-wallet nonce to prevent replay attacks, and verifies ECDSA signatures on-chain.
Administrative actions (role changes, deactivations) that are executed by non-owner admins require a second-factor approval before they take effect — either from the admin's registered secondary wallet or from another active admin, with a 1-hour TTL.

# Architecture
Identity Security Framework (Solidity)
│
├── User Registry         — registerUser, getUserDetails, isRegistered
├── Role Management       — assignRole (Admin / Moderator / User / None)
├── Auth / Nonce          — generateNonce, verifySignature, incrementNonce
├── Lifecycle             — deactivateUser, reactivateUser
├── 2FA Approval Queue    — requestCriticalAction, approveCriticalAction
└── Secondary Wallet      — setSecondaryWallet, getSecondaryWallet

Frontend (HTML + CSS + ethers.js v6)
│
├── register.html / register.js   — wallet connect + KYC hash registration
├── login.html    / login.js      — nonce fetch + signature sign-in
├── dashboard.html/ dashboard.js  — user profile, nonce, MFA config, activity
├── admin.html    / admin.js      — user table, approvals queue, emergency panel
├── audit.html    / audit.js      — historical query, live stream, CSV/PDF export
└── Shared: core.js, events.js, ui.js, base.css, components.css

# System Roles & Capabilities
None (Value: 0)
    This role is for unregistered individuals. Access is limited to public-facing content with no account privileges.
User (Value: 1)
    Standard account holders who have the ability to register, sign in, and increment nonce values for session security or transaction tracking.
Moderator (Value: 2)
    Staff members tasked with community oversight. They can deactivate regular users, though this action is protected by mandatory 2FA (Two-Factor Authentication).
Admin (Value: 3)
    High-level administrators with the power to assign roles and deactivate or reactivate any account. Note that 2FA is strictly required for these actions unless the target is the system owner.
The deployer is automatically registered as Admin and is the Owner. The owner bypasses all 2FA requirements. 

# Authentication Flow
1.  User calls  generateNonce(wallet)   →  returns the message string to sign
2.  Off-chain:  keccak256(messageString) is signed via MetaMask (personal_sign)
3.  User calls  verifySignature(sig)    →  contract recovers signer, checks nonce
4.  On success: nonce incremented, LoginAttempt + ActionLogged events emitted

The message format is:
Sign in to UserRegistry
Wallet: <lowercase wallet address>
Nonce: <current nonce>
Contract: <lowercase contract address>
Chain ID: <chainId>

Note: The message string is hashed client-side before signing (`keccak256(toUtf8Bytes(message))`), then the resulting bytes are passed to `personal_sign`. This double-hash approach matches the contract's recovery logic exactly.

# 2FA Critical Action Workflow
Non-owner admins must go through a two-step approval before executing sensitive operations.
1.  Admin calls  requestCriticalAction(target, actionType, actionData)
    → returns approvalId (bytes32), emits CriticalActionRequested, TTL = 1 hour
2.  Approver calls  approveCriticalAction(approvalId)
    → valid approvers: secondary wallet (if set) OR another active admin / owner
    → emits CriticalActionApproved
3.  Original admin calls  assignRole() or deactivateUser()
    → contract verifies approval exists, is approved, and is not expired
    → approval is consumed (single-use)

# Action Types
Defined for internal logic and logging:
RoleChange (Value: 0): Triggered by `assignRole()`.
Deactivation (Value: 1): Triggered by `deactivateUser()`.

# Custom Errors
These ensure the smart contract remains secure and reverts invalid state transitions:
Registration & Identity:
    * `NotRegistered`: Caller or target lacks a registered identity.
    * `AlreadyRegistered`: Wallet is already linked to an identity.
    * `EmptyIdentityHash`: A zero hash was passed during registration.
Status & Permissions:
    * `UserNotActive` / `UserAlreadyActive`: Action conflicts with the user's current status.
    * `NotAdmin`: Caller lacks Role 3.
Role Logic:
    * `CannotAssignNoneRole`: Prevention of "null" role assignment.
    * `SameRoleAssigned`: No change detected in the requested role.
    * `UnauthorizedRoleChange`: Non-owner Admins cannot promote others to Admin.
Owner Protection:
    * `CannotDowngradeOwner` / `CannotDeactivateOwner`: Hardcoded protection for the contract owner.
    * `CannotSelfDeactivate`: Prevents Admins from locking themselves out.
Security & 2FA:
    * `InvalidSignature`: Signature recovery mismatch.
    * `InvalidSignatureLength`: Signature must be exactly 65 bytes.
    * `InvalidSecondaryWallet`: Secondary wallet conflicts with primary or owner addresses.
    * `ApprovalNotFound` / `ApprovalRequired` / `AlreadyApproved`: State checks for the 2FA queue.
    * `ApprovalExpired`: Request exceeded the 1-hour TTL.
    * `NotAuthorizedApprover`: Caller is not eligible to sign off on the request.

# Events (Audit Log)
User Lifecycle: `UserRegistered`, `UserDeactivated`, `UserReactivated`.
Permissions: `RoleChanged` (tracks old vs. new role and the actor).
Security: `LoginAttempt`, `ActionLogged`, `SecondaryWalletSet`.
Workflows: `CriticalActionRequested` (initiates 2FA), `CriticalActionApproved`.

# Frontend Architecture
Public & User Access
Registration (`register.html`): Public access. Handles wallet connection, client-side KYC hashing, and contract interaction.
Login (`login.html`): For registered wallets. Uses a challenge-response system (nonce + MetaMask signature).
User Dashboard (`dashboard.html`): Personal account management, secondary wallet setup, and pending 2FA approvals.
Administrative & Audit
Admin Panel (`admin.html`): Restricted to Role 3. Features user management, the approval queue, and owner-only emergency tools.
Audit Center (`audit.html`): General access for event history. Admins receive enhanced views with anomaly detection and data export (CSV/PDF) capabilities.

# File Structure

project-root/
│
├── pages/
│   ├── register.html
│   ├── login.html
│   ├── dashboard.html
│   ├── admin.html
│   └── audit.html
│
├── css/
│   ├── base.css          ← design tokens, layout, loading screen, toast
│   ├── components.css    ← shared components (buttons, pills, cards, tables)
│   ├── login.css
│   ├── register.css
│   ├── dashboard.css
│   ├── admin.css
│   └── audit.css
│
├── js/
│   ├── core.js           ← wallet connection, ABI, shared state, helpers
│   ├── events.js         ← event normalizers, anomaly detection, CSV/PDF export
│   ├── ui.js             ← tabs, modals, filters, pagination, sorting
│   ├── login.js
│   ├── register.js
│   ├── dashboard.js
│   ├── admin.js
│   └── audit.js
│
├── contracts/
│   └── IdentityManager.sol
│   └── IdentityStorage.sol
│   └── AccessController.sol
│   └── AuditLogger.sol
│
├── test/
│   ├── IdentityManager.test.ts       ← Core registry tests
│   ├── IdentityManager.auth.test.ts  ← Wallet-based authentication tests
│   └── IdentityManager.2fa.test.ts   ← Second-factor approval flow tests
│
├── scripts/
│   ├── deploy.js
│   └── deploy.ts
│
└── hardhat.config.ts

# Getting Started

# Prerequisites
- Node.js v18+
- npm or yarn
- MetaMask browser extension (for frontend)
- Hardhat

# Installation
bash
git clone https://github.com/Ayesha4325/blockchain-based-Identity-and-Access-Management.git
cd identity-manager
npm install

# Deploy Locally
bash
Start a local Hardhat node
npx hardhat node
In a separate terminal, deploy the contract
npx hardhat run scripts/deploy.ts --network localhost
The default local deployment address is `0x5FbDB2315678afecb367f032d93F642f64180aa3` (Hardhat's deterministic first address). This address is already hardcoded in `core.js`, `login.js`, and `register.js` for local development.
To use a different network, update `CONTRACT_ADDRESS` in `js/core.js`, `js/login.js`, and `js/register.js`, and add the network to `hardhat.config.ts`.

# Run Tests
bash
All tests
npx hardhat test
With gas report
REPORT_GAS=true npx hardhat test
Specific suite
npx hardhat test test/IdentityManager.2fa.test.ts

# Testing
Three test suites cover the full contract surface:
`IdentityManager.test.ts` — Core Registry
Covers deployment, `registerUser`, `assignRole`, `deactivateUser`, `reactivateUser`, `incrementNonce`, and all view helpers. Includes edge cases: double registration, zero identity hash, self-deactivation, owner downgrade protection, and non-admin role escalation attempts.
`IdentityManager.auth.test.ts` — Wallet Authentication
Covers `generateNonce` (message format, embedding, reverts), `verifySignature` (valid flow, nonce advancement, sequential logins), replay attack prevention (same sig, future nonce, cross-user replay), and a full round-trip integration test.
`IdentityManager.2fa.test.ts` — Second-Factor Approval
Covers `setSecondaryWallet`, `requestCriticalAction`, `approveCriticalAction` via both the admin fallback path and the secondary wallet path, TTL expiry, double-approval prevention, full `assignRole` and `deactivateUser` flows under 2FA, and owner bypass behaviour.

# Security Considerations
- Replay protection — every successful login increments the nonce. Old signatures are permanently invalid.
- Cross-wallet replay protection — the message embeds the caller's address; a signature for wallet A cannot be used by wallet B.
- Cross-contract replay protection — the message embeds the contract address and chain ID.
- Signature length enforcement — signatures not exactly 65 bytes revert with `InvalidSignatureLength` before any ECDSA recovery is attempted.
- Owner immutability — the owner cannot be deactivated or downgraded, and only the owner can promote other users to Admin.
- Single-use approvals — a 2FA approval is deleted upon execution and cannot be reused.
- TTL enforcement — approvals expire after 1 hour; both the `approveCriticalAction` and the final action call check expiry.
- Raw KYC label privacy — only the `keccak256` hash of the identity label is stored on-chain; the raw string never leaves the client.
- No admin self-deactivation — prevents admins from locking themselves out.

# License
MIT