// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title UserRegistry
 * @notice Manages user identities, roles, and account lifecycle on-chain.
 * @dev Includes role-based access control, account status validation,
 *      comprehensive action logging, and per-user nonces for replay protection.
 */
contract UserRegistry {

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum Role { None, User, Moderator, Admin }

    enum ActionType {
        Registered,
        RoleChanged,
        Deactivated,
        Reactivated,
        NonceIncremented
    }

    struct User {
        address walletAddress;
        Role    role;
        bytes32 identityHash;
        bool    isActive;
        uint256 nonce;          // per-user monotonic counter (replay protection)
    }

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    address public immutable owner;

    mapping(address => User) private _users;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted whenever a user registers for the first time.
    event UserRegistered(
        address indexed walletAddress,
        bytes32         identityHash,
        uint256         timestamp
    );

    /// @notice Emitted when an admin changes a user's role.
    event RoleChanged(
        address indexed walletAddress,
        Role    indexed oldRole,
        Role    indexed newRole,
        address         changedBy,
        uint256         timestamp
    );

    /// @notice Emitted when a user account is deactivated.
    event UserDeactivated(
        address indexed walletAddress,
        address         deactivatedBy,
        uint256         timestamp
    );

    /// @notice Emitted when a user account is reactivated.
    event UserReactivated(
        address indexed walletAddress,
        address         reactivatedBy,
        uint256         timestamp
    );

    /**
     * @notice Generic action log — provides a single, queryable stream of every
     *         state-changing operation performed on the registry.
     * @param actor     The address that triggered the action.
     * @param target    The address the action was performed on (may equal actor).
     * @param action    Enum discriminator describing what happened.
     * @param nonce     The target user's nonce *after* the action completed.
     * @param timestamp Block timestamp at the time of the action.
     */
    event ActionLogged(
        address    indexed actor,
        address    indexed target,
        ActionType indexed action,
        uint256            nonce,
        uint256            timestamp
    );

    // -------------------------------------------------------------------------
    // Errors  (gas-cheaper than require strings in Solidity >= 0.8.4)
    // -------------------------------------------------------------------------

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

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    /// @dev Restricts to the immutable contract owner.
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /**
     * @dev Restricts to active Admin-role users OR the contract owner.
     *      The owner always passes even before they appear in the mapping
     *      (constructor registers them, but guard is belt-and-suspenders).
     */
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

    /**
     * @dev Restricts to active Moderator-or-above users OR the contract owner.
     *      Moderators may perform lighter-weight administrative actions.
     */
    modifier onlyModeratorOrAbove() {
        bool isMod   = _users[msg.sender].role == Role.Moderator && _users[msg.sender].isActive;
        bool isAdmin = _users[msg.sender].role == Role.Admin     && _users[msg.sender].isActive;
        bool isOwner = msg.sender == owner;
        if (!isMod && !isAdmin && !isOwner) revert NotModerator();
        _;
    }

    /// @dev Validates that `_user` exists in the registry.
    modifier userExists(address _user) {
        if (_users[_user].walletAddress == address(0)) revert NotRegistered(_user);
        _;
    }

    /// @dev Validates that `_user` is currently active.
    modifier onlyActiveUser(address _user) {
        if (!_users[_user].isActive) revert UserNotActive(_user);
        _;
    }

    /// @dev Validates that `_user` is currently inactive.
    modifier onlyInactiveUser(address _user) {
        if (_users[_user].isActive) revert UserAlreadyActive(_user);
        _;
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor() {
        owner = msg.sender;

        // Register the deployer as the root Admin automatically.
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

    // -------------------------------------------------------------------------
    // External — write functions
    // -------------------------------------------------------------------------

    /**
     * @notice Register the caller as a new user.
     * @param _identityHash Off-chain identity commitment (e.g. keccak256 of KYC data).
     */
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

    /**
     * @notice Assign a new role to a registered user.
     * @dev Only Admins may promote/demote. The owner cannot be demoted by anyone.
     *      Only the owner may promote someone to Admin.
     * @param _user    Target user address.
     * @param _newRole Desired role (must not be Role.None).
     */
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

        // Guard: nobody can demote the owner.
        if (_user == owner && _newRole != Role.Admin) revert CannotDowngradeOwner();

        // Guard: only the owner can promote someone to Admin.
        if (_newRole == Role.Admin && msg.sender != owner) revert UnauthorizedRoleChange();

        _users[_user].role = _newRole;

        emit RoleChanged(_user, oldRole, _newRole, msg.sender, block.timestamp);
        emit ActionLogged(
            msg.sender, _user, ActionType.RoleChanged,
            _users[_user].nonce, block.timestamp
        );
        return true;
    }

    /**
     * @notice Deactivate an active user account.
     * @dev Admins and Moderators may deactivate regular Users.
     *      Only Admins may deactivate Moderators.
     *      Nobody may deactivate the owner.
     */
    function deactivateUser(address _user)
        external
        onlyModeratorOrAbove
        userExists(_user)
        onlyActiveUser(_user)
        returns (bool)
    {
        if (_user == msg.sender) revert CannotSelfDeactivate();
        if (_user == owner)      revert CannotDeactivateOwner();

        // Moderators cannot deactivate Admins.
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

    /**
     * @notice Reactivate a previously deactivated user account.
     * @dev Admin-only operation.
     */
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

    /**
     * @notice Increment the caller's nonce.
     * @dev Used externally to anchor off-chain signatures and prevent replay.
     *      Returns the nonce value consumed (i.e. before the increment).
     */
    function incrementNonce()
        external
        userExists(msg.sender)
        onlyActiveUser(msg.sender)
        returns (uint256 consumed)
    {
        consumed = _users[msg.sender].nonce;
        unchecked { _users[msg.sender].nonce++; }   // overflow impossible in practice

        emit ActionLogged(
            msg.sender,
            msg.sender,
            ActionType.NonceIncremented,
            _users[msg.sender].nonce,   // post-increment value
            block.timestamp
        );
    }

    // -------------------------------------------------------------------------
    // External — view / pure functions
    // -------------------------------------------------------------------------

    /// @notice Returns the full User struct for `_user`.
    function getUserDetails(address _user)
        external
        view
        userExists(_user)
        returns (User memory)
    {
        return _users[_user];
    }

    /// @notice Returns `true` if `_user` has ever registered.
    function isRegistered(address _user) external view returns (bool) {
        return _users[_user].walletAddress != address(0);
    }

    /// @notice Returns the current role of `_user`.
    function getRole(address _user) external view returns (Role) {
        return _users[_user].role;
    }

    /**
     * @notice Returns `true` if `_user` holds `_role` AND is currently active.
     * @dev Convenience helper for off-chain callers and other contracts.
     */
    function hasRole(address _user, Role _role) external view returns (bool) {
        return _users[_user].role == _role && _users[_user].isActive;
    }

    /// @notice Returns the current nonce of `_user` without modifying state.
    function getNonce(address _user) external view returns (uint256) {
        return _users[_user].nonce;
    }

    /// @notice Returns `true` if `_user` is registered and active.
    function isActiveUser(address _user) external view returns (bool) {
        return _users[_user].walletAddress != address(0) && _users[_user].isActive;
    }
}
