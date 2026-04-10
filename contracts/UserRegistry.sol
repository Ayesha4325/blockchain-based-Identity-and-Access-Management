// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract UserRegistry {
    enum Role { None, User, Admin, Moderator }
    
    struct User {
        address walletAddress;
        Role role;
        bytes32 identityHash;
        bool isActive;
        uint256 nonce;
    }
    
    mapping(address => User) public users;
    address public immutable owner;
    
    event UserRegistered(address indexed walletAddress, bytes32 identityHash, uint256 timestamp);
    event RoleChanged(address indexed walletAddress, Role indexed oldRole, Role indexed newRole, address changedBy, uint256 timestamp);
    event UserDeactivated(address indexed walletAddress, address deactivatedBy, uint256 timestamp);
    event UserReactivated(address indexed walletAddress, address reactivatedBy, uint256 timestamp);
    
    modifier onlyAdmin() {
        require(msg.sender == owner || (users[msg.sender].role == Role.Admin && users[msg.sender].isActive), "UserRegistry: Caller is not an admin");
        _;
    }
    
    modifier onlyActiveUser(address _user) {
        require(users[_user].isActive, "UserRegistry: User is not active");
        _;
    }
    
    constructor() {
        owner = msg.sender;
        users[msg.sender] = User(msg.sender, Role.Admin, bytes32(0), true, 0);
        emit UserRegistered(msg.sender, bytes32(0), block.timestamp);
    }
    
    function registerUser(bytes32 _identityHash) external returns (bool) {
        require(users[msg.sender].walletAddress == address(0), "UserRegistry: User already registered");
        require(_identityHash != bytes32(0), "UserRegistry: Identity hash required");
        users[msg.sender] = User(msg.sender, Role.User, _identityHash, true, 0);
        emit UserRegistered(msg.sender, _identityHash, block.timestamp);
        return true;
    }
    
    function assignRole(address _user, Role _newRole) external onlyAdmin returns (bool) {
        require(_user != address(0), "UserRegistry: Invalid address");
        require(users[_user].walletAddress != address(0), "UserRegistry: User not registered");
        require(_newRole != Role.None, "UserRegistry: Cannot assign None role");
        Role oldRole = users[_user].role;
        require(oldRole != _newRole, "UserRegistry: New role must be different");
        users[_user].role = _newRole;
        emit RoleChanged(_user, oldRole, _newRole, msg.sender, block.timestamp);
        return true;
    }
    
    function deactivateUser(address _user) external onlyAdmin onlyActiveUser(_user) returns (bool) {
        require(_user != msg.sender, "UserRegistry: Cannot self-deactivate");
        require(_user != owner, "UserRegistry: Cannot deactivate owner");
        users[_user].isActive = false;
        emit UserDeactivated(_user, msg.sender, block.timestamp);
        return true;
    }
    
    function reactivateUser(address _user) external onlyAdmin returns (bool) {
        require(users[_user].walletAddress != address(0), "UserRegistry: User not registered");
        require(!users[_user].isActive, "UserRegistry: User already active");
        users[_user].isActive = true;
        emit UserReactivated(_user, msg.sender, block.timestamp);
        return true;
    }
    
    function getUserDetails(address _user) external view returns (User memory) {
        require(users[_user].walletAddress != address(0), "UserRegistry: User not registered");
        return users[_user];
    }
    
    function incrementNonce() external onlyActiveUser(msg.sender) returns (uint256) {
        uint256 currentNonce = users[msg.sender].nonce;
        users[msg.sender].nonce++;
        return currentNonce;
    }
    
    function isRegistered(address _user) external view returns (bool) {
        return users[_user].walletAddress != address(0);
    }
    
    function getRole(address _user) external view returns (Role) {
        return users[_user].role;
    }
    
    function hasRole(address _user, Role _role) external view returns (bool) {
        return users[_user].role == _role && users[_user].isActive;
    }
}
