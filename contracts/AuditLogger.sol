// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./IdentityStorage.sol";

// Financial-grade audit trail contract
abstract contract AuditLogger is IdentityStorage {

    // Existing event definitions
    event UserRegistered(address indexed walletAddress, bytes32 identityHash, uint256 timestamp);
    event RoleChanged(address indexed walletAddress, Role indexed oldRole, Role indexed newRole, address changedBy, uint256 timestamp);
    event UserDeactivated(address indexed walletAddress, address deactivatedBy, uint256 timestamp);
    event UserReactivated(address indexed walletAddress, address reactivatedBy, uint256 timestamp);
    event ActionLogged(address indexed actor, address indexed target, ActionType indexed action, uint256 nonce, uint256 timestamp);
    event LoginAttempt(address indexed wallet, bool success, uint256 nonce, uint256 timestamp);

    // Second-factor/critical-action event definitions
    event CriticalActionRequested(bytes32 indexed approvalId, address indexed requester, address indexed target, CriticalAction action, bytes32 actionData, uint256 expiresAt, uint256 timestamp);
    event CriticalActionApproved(bytes32 indexed approvalId, address indexed approvedBy, uint256 timestamp);
    event SecondaryWalletSet(address indexed primaryWallet, address indexed secondaryWallet, uint256 timestamp);

    constructor(address _owner) IdentityStorage(_owner) {}

    // Internal helper to log standard actions
    function _logAction(address actor, address target, ActionType action, uint256 nonce) internal {
        emit ActionLogged(actor, target, action, nonce, block.timestamp);
    }

    // Internal helper to log login attempts
    function _logLogin(address wallet, bool success, uint256 nonce) internal {
        emit LoginAttempt(wallet, success, nonce, block.timestamp);
    }

    // Internal helper to log critical action requests
    function _logCriticalRequest(bytes32 approvalId, address requester, address target, CriticalAction action, bytes32 actionData, uint256 expiresAt) internal {
        emit CriticalActionRequested(approvalId, requester, target, action, actionData, expiresAt, block.timestamp);
        _logAction(requester, target, ActionType.CriticalRequested, _getNonce(target));
    }

    // Internal helper to log critical action approvals
    function _logCriticalApproval(bytes32 approvalId, address approvedBy) internal {
        emit CriticalActionApproved(approvalId, approvedBy, block.timestamp);
    }

    // Internal helper to log secondary wallet updates
    function _logSecondaryWalletSet(address primary, address secondary) internal {
        emit SecondaryWalletSet(primary, secondary, block.timestamp);
    }
}