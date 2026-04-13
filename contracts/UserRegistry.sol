// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// On-chain user registry with SIWE-style signature authentication
contract UserRegistry {

    // Types

    enum Role { None, User, Moderator, Admin }

    enum ActionType {
        Registered,
        RoleChanged,
        Deactivated,
        Reactivated,
        NonceIncremented,
        LoginSuccess,
        LoginFailed
    }

    struct User {
        address walletAddress;
        Role    role;
        bytes32 identityHash;
        bool    isActive;
        uint256 nonce;
    }

    // State

    address public immutable owner;
    mapping(address => User) private _users;

    // Events

    event UserRegistered(
        address indexed walletAddress,
        bytes32         identityHash,
        uint256         timestamp
    );

    event RoleChanged(
        address indexed walletAddress,
        Role    indexed oldRole,
        Role    indexed newRole,
        address         changedBy,
        uint256         timestamp
    );

    event UserDeactivated(
        address indexed walletAddress,
        address         deactivatedBy,
        uint256         timestamp
    );

    event UserReactivated(
        address indexed walletAddress,
        address         reactivatedBy,
        uint256         timestamp
    );

    event ActionLogged(
        address    indexed actor,
        address    indexed target,
        ActionType indexed action,
        uint256            nonce,
        uint256            timestamp
    );

    event LoginAttempt(
        address indexed wallet,
        bool            success,
        uint256         nonce,
        uint256         timestamp
    );

    // Errors

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

    // Modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAdmin() {
        if (
            msg.sender != owner &&
            !(
                _users[msg.sender].role == Role.Admin &&
                _users[msg.sender].isActive
            )
        ) revert NotAdmin();
        _;
    }

    modifier onlyModeratorOrAbove() {
        bool isMod   = _users[msg.sender].role == Role.Moderator && _users[msg.sender].isActive;
        bool isAdmin = _users[msg.sender].role == Role.Admin     && _users[msg.sender].isActive;
        bool isOwner = msg.sender == owner;
        if (!isMod && !isAdmin && !isOwner) revert NotModerator();
        _;
    }

    modifier userExists(address _user) {
        if (_users[_user].walletAddress == address(0)) revert NotRegistered(_user);
        _;
    }

    modifier onlyActiveUser(address _user) {
        if (!_users[_user].isActive) revert UserNotActive(_user);
        _;
    }

    modifier onlyInactiveUser(address _user) {
        if (_users[_user].isActive) revert UserAlreadyActive(_user);
        _;
    }

    // Constructor

    constructor() {
        owner = msg.sender;
        _users[msg.sender] = User({
            walletAddress: msg.sender,
            role:          Role.Admin,
            identityHash:  bytes32(0),
            isActive:      true,
            nonce:         0
        });
        emit UserRegistered(msg.sender, bytes32(0), block.timestamp);
        emit ActionLogged(msg.sender, msg.sender, ActionType.Registered, 0, block.timestamp);
    }

    // Authentication functions

    function generateNonce(address _user)
        external
        view
        userExists(_user)
        onlyActiveUser(_user)
        returns (string memory)
    {
        uint256 currentNonce = _users[_user].nonce;

        return string(
            abi.encodePacked(
                "Sign in to UserRegistry\n",
                "Wallet: ",   _toHexString(uint160(_user), 20), "\n",
                "Nonce: ",    _uint2str(currentNonce),           "\n",
                "Contract: ", _toHexString(uint160(address(this)), 20), "\n",
                "Chain ID: ", _uint2str(block.chainid)
            )
        );
    }

    function verifySignature(bytes calldata _signature)
        external
        userExists(msg.sender)
        onlyActiveUser(msg.sender)
        returns (bool)
    {
        if (_signature.length != 65) revert InvalidSignatureLength();

        uint256 currentNonce = _users[msg.sender].nonce;

        string memory message = string(
            abi.encodePacked(
                "Sign in to UserRegistry\n",
                "Wallet: ",   _toHexString(uint160(msg.sender), 20), "\n",
                "Nonce: ",    _uint2str(currentNonce),                "\n",
                "Contract: ", _toHexString(uint160(address(this)), 20), "\n",
                "Chain ID: ", _uint2str(block.chainid)
            )
        );

        bytes32 msgHash = keccak256(bytes(message));
        bytes32 prefixedHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", msgHash)
        );

        bytes32 r;
        bytes32 s;
        uint8   v;
        bytes memory sig = _signature;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }

        if (v < 27) v += 27;

        address recovered = ecrecover(prefixedHash, v, r, s);

        if (recovered == address(0) || recovered != msg.sender) {
            emit LoginAttempt(msg.sender, false, currentNonce, block.timestamp);
            emit ActionLogged(
                msg.sender, msg.sender,
                ActionType.LoginFailed,
                currentNonce, block.timestamp
            );
            revert InvalidSignature();
        }

        unchecked { _users[msg.sender].nonce++; }

        emit LoginAttempt(msg.sender, true, currentNonce, block.timestamp);
        emit ActionLogged(
            msg.sender, msg.sender,
            ActionType.LoginSuccess,
            _users[msg.sender].nonce,
            block.timestamp
        );
        return true;
    }

    // User management functions

    function registerUser(bytes32 _identityHash) external returns (bool) {
        if (_users[msg.sender].walletAddress != address(0)) revert AlreadyRegistered(msg.sender);
        if (_identityHash == bytes32(0))                    revert EmptyIdentityHash();

        _users[msg.sender] = User({
            walletAddress: msg.sender,
            role:          Role.User,
            identityHash:  _identityHash,
            isActive:      true,
            nonce:         0
        });

        emit UserRegistered(msg.sender, _identityHash, block.timestamp);
        emit ActionLogged(msg.sender, msg.sender, ActionType.Registered, 0, block.timestamp);
        return true;
    }

    function assignRole(address _user, Role _newRole)
        external
        onlyAdmin
        userExists(_user)
        returns (bool)
    {
        if (_user == address(0))   revert ZeroAddress();
        if (_newRole == Role.None) revert CannotAssignNoneRole();

        Role oldRole = _users[_user].role;
        if (oldRole == _newRole)   revert SameRoleAssigned();

        if (_user == owner && _newRole != Role.Admin) revert CannotDowngradeOwner();
        if (_newRole == Role.Admin && msg.sender != owner) revert UnauthorizedRoleChange();

        _users[_user].role = _newRole;

        emit RoleChanged(_user, oldRole, _newRole, msg.sender, block.timestamp);
        emit ActionLogged(
            msg.sender, _user, ActionType.RoleChanged,
            _users[_user].nonce, block.timestamp
        );
        return true;
    }

    function deactivateUser(address _user)
        external
        onlyModeratorOrAbove
        userExists(_user)
        onlyActiveUser(_user)
        returns (bool)
    {
        if (_user == msg.sender) revert CannotSelfDeactivate();
        if (_user == owner)      revert CannotDeactivateOwner();

        Role callerRole = _users[msg.sender].role;
        Role targetRole = _users[_user].role;
        if (callerRole == Role.Moderator && targetRole == Role.Admin) revert NotAdmin();

        _users[_user].isActive = false;

        emit UserDeactivated(_user, msg.sender, block.timestamp);
        emit ActionLogged(
            msg.sender, _user, ActionType.Deactivated,
            _users[_user].nonce, block.timestamp
        );
        return true;
    }

    function reactivateUser(address _user)
        external
        onlyAdmin
        userExists(_user)
        onlyInactiveUser(_user)
        returns (bool)
    {
        _users[_user].isActive = true;

        emit UserReactivated(_user, msg.sender, block.timestamp);
        emit ActionLogged(
            msg.sender, _user, ActionType.Reactivated,
            _users[_user].nonce, block.timestamp
        );
        return true;
    }

    function incrementNonce()
        external
        userExists(msg.sender)
        onlyActiveUser(msg.sender)
        returns (uint256 consumed)
    {
        consumed = _users[msg.sender].nonce;
        unchecked { _users[msg.sender].nonce++; }

        emit ActionLogged(
            msg.sender, msg.sender,
            ActionType.NonceIncremented,
            _users[msg.sender].nonce,
            block.timestamp
        );
    }

    // View functions

    function getUserDetails(address _user)
        external
        view
        userExists(_user)
        returns (User memory)
    {
        return _users[_user];
    }

    function isRegistered(address _user) external view returns (bool) {
        return _users[_user].walletAddress != address(0);
    }

    function getRole(address _user) external view returns (Role) {
        return _users[_user].role;
    }

    function hasRole(address _user, Role _role) external view returns (bool) {
        return _users[_user].role == _role && _users[_user].isActive;
    }

    function getNonce(address _user) external view returns (uint256) {
        return _users[_user].nonce;
    }

    function isActiveUser(address _user) external view returns (bool) {
        return _users[_user].walletAddress != address(0) && _users[_user].isActive;
    }

    // Internal helpers

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

    function _toHexString(uint256 value, uint256 length)
        internal
        pure
        returns (string memory)
    {
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