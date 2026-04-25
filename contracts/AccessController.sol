// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./AuditLogger.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract AccessController is AuditLogger {

    error NotOwner();
    error NotAdmin();
    error NotModerator();
    error NotRegistered(address user);
    error AlreadyRegistered(address user);
    error UserNotActive(address user);
    error UserAlreadyActive(address user);
    error ZeroAddress();
    error EmptyIdentityHash();
    error CannotAssignNoneRole();
    error SameRoleAssigned();
    error CannotSelfDeactivate();
    error CannotDeactivateOwner();
    error CannotDowngradeOwner();
    error UnauthorizedRoleChange();
    error InvalidSignature();
    error InvalidSignatureLength();
    error ApprovalNotFound(bytes32 approvalId);
    error AlreadyApproved(bytes32 approvalId);
    error NotAuthorizedApprover(bytes32 approvalId, address caller);
    error ApprovalExpired(bytes32 approvalId);
    error ApprovalRequired(bytes32 approvalId);
    error InvalidSecondaryWallet();

    constructor(address _owner) AuditLogger(_owner) {}

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAdmin() {
        if (msg.sender != owner && !(_getRole(msg.sender) == Role.Admin && _isActive(msg.sender))) revert NotAdmin();
        _;
    }

    modifier onlyModeratorOrAbove() {
        bool isMod   = _getRole(msg.sender) == Role.Moderator && _isActive(msg.sender);
        bool isAdmin = _getRole(msg.sender) == Role.Admin     && _isActive(msg.sender);
        bool isOwner = msg.sender == owner;
        if (!isMod && !isAdmin && !isOwner) revert NotModerator();
        _;
    }

    modifier userExists(address _user) {
        if (!_exists(_user)) revert NotRegistered(_user);
        _;
    }

    modifier onlyActiveUser(address _user) {
        if (!_isActive(_user)) revert UserNotActive(_user);
        _;
    }

    modifier onlyInactiveUser(address _user) {
        if (_isActive(_user)) revert UserAlreadyActive(_user);
        _;
    }

    // Validates 2FA approval state and deletes record after use
    modifier requiresApproval(bytes32 approvalId) {
        if (msg.sender != owner) {
            ApprovalRequest storage req = _getApproval(approvalId);
            if (!req.exists)     revert ApprovalNotFound(approvalId);
            if (!req.isApproved) revert ApprovalRequired(approvalId);
            if (block.timestamp > req.requestedAt + APPROVAL_TTL) revert ApprovalExpired(approvalId);
            _;
            _deleteApproval(approvalId);
        } else {
            _;
        }
    }

    // Constructs SIWE message string
    function _buildMessage(address _user, uint256 nonce) internal view returns (string memory) {
        return string(abi.encodePacked(
                "Sign in to UserRegistry\n",
                "Wallet: ",   _toHexString(uint160(_user), 20), "\n",
                "Nonce: ",    _uint2str(nonce),                  "\n",
                "Contract: ", _toHexString(uint160(address(this)), 20), "\n",
                "Chain ID: ", _uint2str(block.chainid)
            ));
    }

    // Recovers signer from signature and validates against sender
    function _verifyLogin(bytes calldata _signature) internal returns (uint256 consumedNonce) {
        consumedNonce = _getNonce(msg.sender);
        string memory message = _buildMessage(msg.sender, consumedNonce);
        bytes32 ethSignedHash = MessageHashUtils.toEthSignedMessageHash(bytes(message));
        address recovered = ECDSA.recover(ethSignedHash, _signature);
        if (recovered != msg.sender) {
            _logLogin(msg.sender, false, consumedNonce);
            _logAction(msg.sender, msg.sender, ActionType.LoginFailed, consumedNonce);
            revert InvalidSignature();
        }
    }

    // Generates deterministic hash for 2FA requests
    function _buildApprovalId(address requester, address target, CriticalAction action, bytes32 actionData) internal view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), requester, target, action, actionData));
    }

    // Stores new 2FA request and logs event
    function _createApprovalRequest(address requester, address target, CriticalAction action, bytes32 actionData) internal returns (bytes32 approvalId) {
        require(requester != address(0), "AC: zero requester");
        require(target    != address(0), "AC: zero target");
        approvalId = _buildApprovalId(requester, target, action, actionData);
        uint256 expiresAt = block.timestamp + APPROVAL_TTL;
        _storeApproval(approvalId, ApprovalRequest({
            requester:   requester,
            target:      target,
            action:      action,
            actionData:  actionData,
            isApproved:  false,
            exists:      true,
            requestedAt: block.timestamp
        }));
        _logCriticalRequest(approvalId, requester, target, action, actionData, expiresAt);
    }

    // Validates approver identity and updates request status
    function _processApproval(bytes32 approvalId) internal {
        ApprovalRequest storage req = _getApproval(approvalId);
        if (!req.exists)     revert ApprovalNotFound(approvalId);
        if (req.isApproved)  revert AlreadyApproved(approvalId);
        if (block.timestamp > req.requestedAt + APPROVAL_TTL) revert ApprovalExpired(approvalId);
        address secondary = _getSecondaryWallet(req.requester);
        bool isSecondaryApprover = secondary != address(0) && msg.sender == secondary;
        bool isAdminFallback = secondary == address(0) && msg.sender != req.requester && (msg.sender == owner || (_getRole(msg.sender) == Role.Admin && _isActive(msg.sender)));
        if (!isSecondaryApprover && !isAdminFallback) revert NotAuthorizedApprover(approvalId, msg.sender);
        _markApproved(approvalId);
        _logCriticalApproval(approvalId, msg.sender);
        _logAction(msg.sender, req.target, ActionType.CriticalApproved, _getNonce(req.target));
    }

    function transferOwnership(address _newOwner) external onlyOwner {
        require(_newOwner != address(0), "AC: zero address");
        pendingOwner = _newOwner;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "AC: not pending owner");
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    function _uint2str(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits--;
            buffer[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    function _toHexString(uint256 value, uint256 length) internal pure returns (string memory) {
        bytes memory buffer = new bytes(2 + length * 2);
        buffer[0] = "0";
        buffer[1] = "x";
        bytes16 hexChars = "0123456789abcdef";
        for (uint256 i = 2 + length * 2 - 1; i >= 2; i--) {
            buffer[i] = hexChars[value & 0xf];
            value >>= 4;
            if (i == 2) break;
        }
        return string(buffer);
    }
}