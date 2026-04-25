import { expect }            from "chai";
import { ethers }            from "hardhat";
import { SignerWithAddress }  from "@nomicfoundation/hardhat-ethers/signers";
import { IdentityManager }   from "../typechain-types"; 

// Constants
const Role = { None: 0n, User: 1n, Moderator: 2n, Admin: 3n } as const;

const ActionType = {
  Registered:       0n,
  RoleChanged:      1n,
  Deactivated:      2n,
  Reactivated:      3n,
  NonceIncremented: 4n,
  LoginSuccess:     5n,
  LoginFailed:      6n,
} as const;

const CriticalAction = {
  RoleChange: 0,
  Deactivation: 1,
} as const;

const IDENTITY      = ethers.keccak256(ethers.toUtf8Bytes("alice-kyc"));
const BOB_IDENTITY  = ethers.keccak256(ethers.toUtf8Bytes("bob-kyc"));

// Helpers
function anyTimestamp() {
  return (val: unknown) =>
    typeof val === "bigint" && val > 0n
      ? true
      : `expected positive BigInt timestamp, got ${val}`;
}

// Fixture
describe("IdentityManager — Core Registry", function () {
  let registry: IdentityManager; 
  let owner:    SignerWithAddress;
  let alice:    SignerWithAddress;
  let bob:      SignerWithAddress;
  let stranger: SignerWithAddress;

  beforeEach(async function () {
    [owner, alice, bob, stranger] = await ethers.getSigners();

    // Factory name changed
    const Factory = await ethers.getContractFactory("IdentityManager");
    registry = (await Factory.deploy()) as unknown as IdentityManager; 
    await registry.waitForDeployment();
  });

  // Deployment
  describe("Deployment", function () {

    it("registers the deployer as Admin on construction", async function () {
      const admin = await registry.getUserDetails(owner.address);
      expect(admin.role).to.equal(Role.Admin);
      expect(admin.isActive).to.be.true;
      expect(admin.walletAddress).to.equal(owner.address);
    });

    it("sets owner to the deployer", async function () {
      expect(await registry.owner()).to.equal(owner.address);
    });

    it("emits UserRegistered for the deployer on deploy", async function () {
      // Re-deploy so we can capture the constructor event
      const Factory  = await ethers.getContractFactory("IdentityManager"); 
      const freshReg = await Factory.deploy();
      await expect(freshReg.deploymentTransaction())
        .to.emit(freshReg, "UserRegistered");
    });
  });

  // registerUser()
  describe("registerUser()", function () {

    it("registers a new user with Role.User", async function () {
      await registry.connect(alice).registerUser(IDENTITY);
      const user = await registry.getUserDetails(alice.address);
      expect(user.role).to.equal(Role.User);
      expect(user.isActive).to.be.true;
      expect(user.identityHash).to.equal(IDENTITY);
    });

    it("emits UserRegistered on success", async function () {
      await expect(registry.connect(alice).registerUser(IDENTITY))
        .to.emit(registry, "UserRegistered")
        .withArgs(alice.address, IDENTITY, anyTimestamp());
    });

    it("emits ActionLogged(Registered) on success", async function () {
      await expect(registry.connect(alice).registerUser(IDENTITY))
        .to.emit(registry, "ActionLogged")
        .withArgs(alice.address, alice.address, ActionType.Registered, 0n, anyTimestamp());
    });

    it("reverts with AlreadyRegistered if called twice", async function () {
      await registry.connect(alice).registerUser(IDENTITY);
      await expect(
        registry.connect(alice).registerUser(IDENTITY),
      ).to.be.revertedWithCustomError(registry, "AlreadyRegistered");
    });

    it("reverts with EmptyIdentityHash for zero hash", async function () {
      await expect(
        registry.connect(alice).registerUser(ethers.ZeroHash),
      ).to.be.revertedWithCustomError(registry, "EmptyIdentityHash");
    });
  });

  // assignRole()
  describe("assignRole()", function () {

    beforeEach(async function () {
      await registry.connect(alice).registerUser(IDENTITY);
      await registry.connect(bob).registerUser(BOB_IDENTITY);
    });

    it("owner can promote a User to Moderator", async function () {
      await registry.connect(owner).assignRole(alice.address, Role.Moderator);
      expect(await registry.getRole(alice.address)).to.equal(Role.Moderator);
    });

    it("owner can promote a User to Admin", async function () {
      await registry.connect(owner).assignRole(alice.address, Role.Admin);
      expect(await registry.getRole(alice.address)).to.equal(Role.Admin);
    });

    it("emits RoleChanged on success", async function () {
      await expect(
        registry.connect(owner).assignRole(alice.address, Role.Moderator),
      ).to.emit(registry, "RoleChanged")
        .withArgs(alice.address, Role.User, Role.Moderator, owner.address, anyTimestamp());
    });

    it("non-admin cannot assign roles", async function () {
      await expect(
        registry.connect(alice).assignRole(bob.address, Role.Moderator),
      ).to.be.revertedWithCustomError(registry, "NotAdmin");
    });

    it("cannot assign Role.None", async function () {
      await expect(
        registry.connect(owner).assignRole(alice.address, Role.None),
      ).to.be.revertedWithCustomError(registry, "CannotAssignNoneRole");
    });

    it("cannot assign the same role twice", async function () {
      await expect(
        registry.connect(owner).assignRole(alice.address, Role.User),
      ).to.be.revertedWithCustomError(registry, "SameRoleAssigned");
    });

    it("cannot downgrade the owner", async function () {
      await expect(
        registry.connect(owner).assignRole(owner.address, Role.User),
      ).to.be.revertedWithCustomError(registry, "CannotDowngradeOwner");
    });

    it("only the owner can promote to Admin (non-owner admin cannot)", async function () {
      // Make alice an admin first (owner bypasses 2FA)
      await registry.connect(owner).assignRole(alice.address, Role.Admin);

      // Alice (admin, not owner) must request 2FA approval for role change
      const actionData = ethers.zeroPadValue(ethers.toBeHex(ethers.toBigInt(Role.Admin)), 32);
      const approvalId = await registry.connect(alice).requestCriticalAction.staticCall(
        bob.address,
        CriticalAction.RoleChange,  // number type
        actionData
      );
      
      // Now actually send the transaction
      await registry.connect(alice).requestCriticalAction(
        bob.address,
        CriticalAction.RoleChange,
        actionData
      );

      // Owner approves the request (admin fallback approver)
      await registry.connect(owner).approveCriticalAction(approvalId);

      // Now alice tries to promote bob to Admin — should fail with UnauthorizedRoleChange
      await expect(
        registry.connect(alice).assignRole(bob.address, Role.Admin),
      ).to.be.revertedWithCustomError(registry, "UnauthorizedRoleChange");
    });
  });

  // deactivateUser()
  describe("deactivateUser()", function () {

    beforeEach(async function () {
      await registry.connect(alice).registerUser(IDENTITY);
      await registry.connect(bob).registerUser(BOB_IDENTITY);
    });

    it("admin can deactivate a regular user", async function () {
      await registry.connect(owner).deactivateUser(alice.address);
      expect((await registry.getUserDetails(alice.address)).isActive).to.be.false;
    });

    it("emits UserDeactivated on success", async function () {
      await expect(registry.connect(owner).deactivateUser(alice.address))
        .to.emit(registry, "UserDeactivated")
        .withArgs(alice.address, owner.address, anyTimestamp());
    });

    it("moderator cannot request critical action (NotAdmin)", async function () {
      await registry.connect(owner).assignRole(alice.address, Role.Moderator);
      await registry.connect(owner).assignRole(bob.address, Role.Admin);

      const actionData = ethers.zeroPadValue(ethers.toBeHex(ethers.toBigInt(ethers.getAddress(bob.address))), 32);
      
      await expect(
        registry.connect(alice).requestCriticalAction(
          bob.address,
          CriticalAction.Deactivation,
          actionData
        ),
      ).to.be.revertedWithCustomError(registry, "NotAdmin");
    });

    it("reverts CannotSelfDeactivate", async function () {
      await expect(
        registry.connect(owner).deactivateUser(owner.address),
      ).to.be.revertedWithCustomError(registry, "CannotSelfDeactivate");
    });

    it("reverts CannotDeactivateOwner", async function () {
      // Must use a different admin account
      await registry.connect(owner).assignRole(alice.address, Role.Admin);

      // Alice (admin) must request 2FA approval for deactivation
      const actionData = ethers.zeroPadValue(ethers.toBeHex(ethers.toBigInt(ethers.getAddress(owner.address))), 32);
      const approvalId = await registry.connect(alice).requestCriticalAction.staticCall(
        owner.address,
        CriticalAction.Deactivation,
        actionData
      );
      
      await registry.connect(alice).requestCriticalAction(
        owner.address,
        CriticalAction.Deactivation,
        actionData
      );

      // Owner approves the request
      await registry.connect(owner).approveCriticalAction(approvalId);

      // Now alice tries to deactivate owner — should fail with CannotDeactivateOwner
      await expect(
        registry.connect(alice).deactivateUser(owner.address),
      ).to.be.revertedWithCustomError(registry, "CannotDeactivateOwner");
    });

    it("reverts if user is already inactive", async function () {
      await registry.connect(owner).deactivateUser(alice.address);
      await expect(
        registry.connect(owner).deactivateUser(alice.address),
      ).to.be.revertedWithCustomError(registry, "UserNotActive");
    });
  });

  // reactivateUser()
  describe("reactivateUser()", function () {

    beforeEach(async function () {
      await registry.connect(alice).registerUser(IDENTITY);
      await registry.connect(owner).deactivateUser(alice.address);
    });

    it("admin can reactivate a deactivated user", async function () {
      await registry.connect(owner).reactivateUser(alice.address);
      expect((await registry.getUserDetails(alice.address)).isActive).to.be.true;
    });

    it("emits UserReactivated on success", async function () {
      await expect(registry.connect(owner).reactivateUser(alice.address))
        .to.emit(registry, "UserReactivated")
        .withArgs(alice.address, owner.address, anyTimestamp());
    });

    it("reverts if user is already active", async function () {
      await registry.connect(owner).reactivateUser(alice.address);
      await expect(
        registry.connect(owner).reactivateUser(alice.address),
      ).to.be.revertedWithCustomError(registry, "UserAlreadyActive");
    });

    it("non-admin cannot reactivate", async function () {
      await expect(
        registry.connect(alice).reactivateUser(alice.address),
      ).to.be.revertedWithCustomError(registry, "NotAdmin");
    });
  });

  // incrementNonce()
  describe("incrementNonce()", function () {

    beforeEach(async function () {
      await registry.connect(alice).registerUser(IDENTITY);
    });

    it("increments the caller's nonce by 1", async function () {
      const before = await registry.getNonce(alice.address);
      await registry.connect(alice).incrementNonce();
      expect(await registry.getNonce(alice.address)).to.equal(before + 1n);
    });

    it("returns the consumed (pre-increment) nonce", async function () {
      const consumed = await registry.connect(alice).incrementNonce.staticCall();
      expect(consumed).to.equal(0n);
    });

    it("emits ActionLogged(NonceIncremented)", async function () {
      await expect(registry.connect(alice).incrementNonce())
        .to.emit(registry, "ActionLogged")
        .withArgs(
          alice.address, alice.address,
          ActionType.NonceIncremented,
          1n,               // nonce AFTER increment
          anyTimestamp(),
        );
    });

    it("reverts for an unregistered caller", async function () {
      await expect(
        registry.connect(stranger).incrementNonce(),
      ).to.be.revertedWithCustomError(registry, "NotRegistered");
    });
  });

  // View helpers
  describe("View helpers", function () {

    beforeEach(async function () {
      await registry.connect(alice).registerUser(IDENTITY);
    });

    it("isRegistered returns true for a registered address", async function () {
      expect(await registry.isRegistered(alice.address)).to.be.true;
    });

    it("isRegistered returns false for an unknown address", async function () {
      expect(await registry.isRegistered(stranger.address)).to.be.false;
    });

    it("hasRole returns true when role matches and user is active", async function () {
      expect(await registry.hasRole(alice.address, Role.User)).to.be.true;
    });

    it("hasRole returns false after deactivation", async function () {
      await registry.connect(owner).deactivateUser(alice.address);
      expect(await registry.hasRole(alice.address, Role.User)).to.be.false;
    });

    it("isActiveUser returns true for an active registered user", async function () {
      expect(await registry.isActiveUser(alice.address)).to.be.true;
    });

    it("isActiveUser returns false for an unregistered address", async function () {
      expect(await registry.isActiveUser(stranger.address)).to.be.false;
    });

    it("getNonce starts at 0 for a fresh user", async function () {
      expect(await registry.getNonce(alice.address)).to.equal(0n);
    });
  });
});