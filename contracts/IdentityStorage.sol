// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// Pure storage layer for user data and 2FA requests
abstract contract IdentityStorage {

    enum Role { None, User, Moderator, Admin }

    enum ActionType {
        Registered,
        RoleChanged,
        Deactivated,
        Reactivated,
        NonceIncremented,
        LoginSuccess,
        LoginFailed,
        CriticalRequested,
        CriticalApproved
    }

    enum CriticalAction {
        RoleChange,
        Deactivation
    }

    struct User {
        address walletAddress;
        Role    role;
        bytes32 identityHash;
        bool    isActive;
        uint256 nonce;
    }

    struct ApprovalRequest {
        address         requester;
        address         target;
        CriticalAction action;
        bytes32        actionData;
        bool           isApproved;
        bool           exists;
        uint256        requestedAt;
    }

    uint256 internal constant APPROVAL_TTL = 1 hours;
    address public immutable owner;
    mapping(address => User) private _users;
    mapping(bytes32 => ApprovalRequest) internal _approvals;
    mapping(address => address) internal _secondaryWallets;

    constructor(address _owner) {
        owner = _owner;
    }

    function _getUser(address _user) internal view returns (User memory) {
        return _users[_user];
    }

    function _getUserStorage(address _user) internal view returns (User storage) {
        return _users[_user];
    }

    function _setUser(address _user, User memory data) internal {
        _users[_user] = data;
    }

    function _exists(address _user) internal view returns (bool) {
        return _users[_user].walletAddress != address(0);
    }

    function _isActive(address _user) internal view returns (bool) {
        return _users[_user].isActive;
    }

    function _getRole(address _user) internal view returns (Role) {
        return _users[_user].role;
    }

    function _getNonce(address _user) internal view returns (uint256) {
        return _users[_user].nonce;
    }

    function _setRole(address _user, Role _role) internal {
        _users[_user].role = _role;
    }

    function _setActive(address _user, bool _active) internal {
        _users[_user].isActive = _active;
    }

    function _incrementNonce(address _user) internal {
        unchecked { _users[_user].nonce++; }
    }

    function _storeApproval(bytes32 id, ApprovalRequest memory req) internal {
        _approvals[id] = req;
    }

    function _getApproval(bytes32 id) internal view returns (ApprovalRequest storage) {
        return _approvals[id];
    }

    function _markApproved(bytes32 id) internal {
        _approvals[id].isApproved = true;
    }

    function _deleteApproval(bytes32 id) internal {
        delete _approvals[id];
    }

    function _getSecondaryWallet(address _user) internal view returns (address) {
        return _secondaryWallets[_user];
    }

    function _setSecondaryWallet(address _user, address _secondary) internal {
        _secondaryWallets[_user] = _secondary;
    }
}