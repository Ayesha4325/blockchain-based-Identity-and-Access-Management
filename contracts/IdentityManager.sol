// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./AccessController.sol";

contract IdentityManager is AccessController {

    constructor() AccessController(msg.sender) {
        _setUser(msg.sender, User({
            walletAddress: msg.sender,
            role:          Role.Admin,
            identityHash:  bytes32(0),
            isActive:      true,
            nonce:         0
        }));
        emit UserRegistered(msg.sender, bytes32(0), block.timestamp);
        _logAction(msg.sender, msg.sender, ActionType.Registered, 0);
    }

    // Returns SIWE-style message for signing
    function generateNonce(address _user)
        external
        view
        userExists(_user)
        onlyActiveUser(_user)
        returns (string memory)
    {
        return _buildMessage(_user, _getNonce(_user));
    }

    // Verifies ECDSA signature and increments nonce
    function verifySignature(bytes calldata _signature)
        external
        userExists(msg.sender)
        onlyActiveUser(msg.sender)
        returns (bool)
    {
        uint256 consumedNonce = _verifyLogin(_signature);
        _incrementNonce(msg.sender);
        _logLogin(msg.sender, true, consumedNonce);
        _logAction(msg.sender, msg.sender, ActionType.LoginSuccess, _getNonce(msg.sender));
        return true;
    }

    // Self-registration with KYC hash
    function registerUser(bytes32 _identityHash) external returns (bool) {
        if (_exists(msg.sender))         revert AlreadyRegistered(msg.sender);
        if (_identityHash == bytes32(0)) revert EmptyIdentityHash();
        _setUser(msg.sender, User({
            walletAddress: msg.sender,
            role:          Role.User,
            identityHash:  _identityHash,
            isActive:      true,
            nonce:         0
        }));
        emit UserRegistered(msg.sender, _identityHash, block.timestamp);
        _logAction(msg.sender, msg.sender, ActionType.Registered, 0);
        return true;
    }

    // Updates user role with 2FA gate for admins
    function assignRole(address _user, Role _newRole)
        external
        onlyAdmin
        userExists(_user)
        returns (bool)
    {
        if (_user == address(0))   revert ZeroAddress();
        if (_newRole == Role.None) revert CannotAssignNoneRole();
        Role oldRole = _getRole(_user);
        if (oldRole == _newRole)   revert SameRoleAssigned();
        if (_user == owner && _newRole != Role.Admin)      revert CannotDowngradeOwner();
        if (_newRole == Role.Admin && msg.sender != owner) revert UnauthorizedRoleChange();

        if (msg.sender != owner) {
            bytes32 actionData = bytes32(uint256(_newRole));
            bytes32 approvalId = _buildApprovalId(msg.sender, _user, CriticalAction.RoleChange, actionData);
            ApprovalRequest storage req = _getApproval(approvalId);
            if (!req.exists)     revert ApprovalNotFound(approvalId);
            if (!req.isApproved) revert ApprovalRequired(approvalId);
            if (block.timestamp > req.requestedAt + APPROVAL_TTL) revert ApprovalExpired(approvalId);
            _deleteApproval(approvalId);
        }
        _setRole(_user, _newRole);
        emit RoleChanged(_user, oldRole, _newRole, msg.sender, block.timestamp);
        _logAction(msg.sender, _user, ActionType.RoleChanged, _getNonce(_user));
        return true;
    }

    // Deactivates user with 2FA gate for non-owners
    function deactivateUser(address _user)
        external
        onlyModeratorOrAbove
        userExists(_user)
        onlyActiveUser(_user)
        returns (bool)
    {
        if (_user == msg.sender) revert CannotSelfDeactivate();
        if (_user == owner)      revert CannotDeactivateOwner();
        Role callerRole = _getRole(msg.sender);
        Role targetRole = _getRole(_user);
        if (callerRole == Role.Moderator && targetRole == Role.Admin) revert NotAdmin();

        if (msg.sender != owner) {
            bytes32 actionData = bytes32(uint256(uint160(_user)));
            bytes32 approvalId = _buildApprovalId(msg.sender, _user, CriticalAction.Deactivation, actionData);
            ApprovalRequest storage req = _getApproval(approvalId);
            if (!req.exists)     revert ApprovalNotFound(approvalId);
            if (!req.isApproved) revert ApprovalRequired(approvalId);
            if (block.timestamp > req.requestedAt + APPROVAL_TTL) revert ApprovalExpired(approvalId);
            _deleteApproval(approvalId);
        }
        _setActive(_user, false);
        emit UserDeactivated(_user, msg.sender, block.timestamp);
        _logAction(msg.sender, _user, ActionType.Deactivated, _getNonce(_user));
        return true;
    }

    // Reactivates a user
    function reactivateUser(address _user)
        external
        onlyAdmin
        userExists(_user)
        onlyInactiveUser(_user)
        returns (bool)
    {
        _setActive(_user, true);
        emit UserReactivated(_user, msg.sender, block.timestamp);
        _logAction(msg.sender, _user, ActionType.Reactivated, _getNonce(_user));
        return true;
    }

    // Manual nonce increment for security
    function incrementNonce()
        external
        userExists(msg.sender)
        onlyActiveUser(msg.sender)
        returns (uint256 consumed)
    {
        consumed = _getNonce(msg.sender);
        _incrementNonce(msg.sender);
        _logAction(msg.sender, msg.sender, ActionType.NonceIncremented, _getNonce(msg.sender));
    }

    // Queues critical action for approval
    function requestCriticalAction(address _target, CriticalAction _action, bytes32 _actionData)
        external
        onlyAdmin
        userExists(_target)
        returns (bytes32 approvalId)
    {
        require(_target != address(0), "IM: zero target");
        require(msg.sender != owner,   "IM: owner needs no 2FA");
        approvalId = _createApprovalRequest(msg.sender, _target, _action, _actionData);
    }

    // Authorizes a pending critical action
    function approveCriticalAction(bytes32 _approvalId) external {
        require(_approvalId != bytes32(0), "IM: zero approvalId");
        _processApproval(_approvalId);
    }

    // Sets 2FA secondary wallet
    function setSecondaryWallet(address _secondary) external userExists(msg.sender) {
        if (_secondary == msg.sender) revert InvalidSecondaryWallet();
        if (_secondary == owner)      revert InvalidSecondaryWallet();
        _setSecondaryWallet(msg.sender, _secondary);
        _logSecondaryWalletSet(msg.sender, _secondary);
    }

    // Returns secondary wallet address
    function getSecondaryWallet(address _user) external view returns (address) {
        return _getSecondaryWallet(_user);
    }

    // Returns full approval request details
    function getApprovalRequest(bytes32 _approvalId) external view returns (ApprovalRequest memory) {
        return _getApproval(_approvalId);
    }

    // Pre-calculates approval ID
    function buildApprovalId(address _requester, address _target, CriticalAction _action, bytes32 _actionData) 
        external 
        view 
        returns (bytes32) 
    {
        return _buildApprovalId(_requester, _target, _action, _actionData);
    }

    function getUserDetails(address _user) external view userExists(_user) returns (User memory) {
        return _getUser(_user);
    }

    function isRegistered(address _user) external view returns (bool) {
        return _exists(_user);
    }

    function getRole(address _user) external view returns (Role) {
        return _getRole(_user);
    }

    function hasRole(address _user, Role _role) external view returns (bool) {
        return _getRole(_user) == _role && _isActive(_user);
    }

    function getNonce(address _user) external view returns (uint256) {
        return _getNonce(_user);
    }

    function isActiveUser(address _user) external view returns (bool) {
        return _exists(_user) && _isActive(_user);
    }
}