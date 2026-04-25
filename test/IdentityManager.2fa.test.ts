import { expect }           from "chai";
import { ethers }           from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { IdentityManager }  from "../typechain-types";
import { time }             from "@nomicfoundation/hardhat-network-helpers";

// Constants
const Role = { None: 0n, User: 1n, Moderator: 2n, Admin: 3n } as const;

const CriticalAction = {
    RoleChange:   0n,
    Deactivation: 1n,
} as const;

const ONE_HOUR = 3600; // seconds

// Encode actionData the same way IdentityManager does internally
function roleChangeData(newRole: bigint): string {
    return ethers.zeroPadValue(ethers.toBeHex(newRole), 32);
}

function deactivationData(targetAddr: string): string {
    return ethers.zeroPadValue(targetAddr, 32);
}

// Fixture
describe("IdentityManager — Second-Factor (2FA)", function () {
    let registry:  IdentityManager;
    let owner:     SignerWithAddress;   // contract owner — bypasses 2FA
    let adminA:    SignerWithAddress;   // non-owner admin (the requester)
    let adminB:    SignerWithAddress;   // second active admin (fallback approver)
    let alice:     SignerWithAddress;   // regular user
    let secondary: SignerWithAddress;   // adminA's secondary wallet
    let stranger:  SignerWithAddress;

    beforeEach(async function () {
        [owner, adminA, adminB, alice, secondary, stranger] =
            await ethers.getSigners();

        const Factory = await ethers.getContractFactory("IdentityManager");
        registry = (await Factory.deploy()) as unknown as IdentityManager;
        await registry.waitForDeployment();

        // Register users
        await registry.connect(adminA).registerUser(
            ethers.keccak256(ethers.toUtf8Bytes("adminA-kyc"))
        );
        await registry.connect(adminB).registerUser(
            ethers.keccak256(ethers.toUtf8Bytes("adminB-kyc"))
        );
        await registry.connect(alice).registerUser(
            ethers.keccak256(ethers.toUtf8Bytes("alice-kyc"))
        );

        // Promote adminA and adminB to Admin via owner (no 2FA needed for owner)
        await registry.connect(owner).assignRole(adminA.address, Role.Admin);
        await registry.connect(owner).assignRole(adminB.address, Role.Admin);
    });

    // setSecondaryWallet()
    describe("setSecondaryWallet()", function () {

        it("registers a secondary wallet and emits SecondaryWalletSet", async function () {
            await expect(registry.connect(adminA).setSecondaryWallet(secondary.address))
                .to.emit(registry, "SecondaryWalletSet")
                .withArgs(adminA.address, secondary.address, (v: bigint) => v > 0n);

            expect(await registry.getSecondaryWallet(adminA.address))
                .to.equal(secondary.address);
        });

        it("allows clearing the secondary wallet (set to address(0))", async function () {
            await registry.connect(adminA).setSecondaryWallet(secondary.address);
            await registry.connect(adminA).setSecondaryWallet(ethers.ZeroAddress);
            expect(await registry.getSecondaryWallet(adminA.address))
                .to.equal(ethers.ZeroAddress);
        });

        it("reverts if secondary == primary wallet", async function () {
            await expect(
                registry.connect(adminA).setSecondaryWallet(adminA.address)
            ).to.be.revertedWithCustomError(registry, "InvalidSecondaryWallet");
        });

        it("reverts if secondary == owner", async function () {
            await expect(
                registry.connect(adminA).setSecondaryWallet(owner.address)
            ).to.be.revertedWithCustomError(registry, "InvalidSecondaryWallet");
        });

        it("reverts for an unregistered caller", async function () {
            await expect(
                registry.connect(stranger).setSecondaryWallet(secondary.address)
            ).to.be.revertedWithCustomError(registry, "NotRegistered");
        });
    });
  
    // requestCriticalAction()
    describe("requestCriticalAction()", function () {

        it("emits CriticalActionRequested with correct fields", async function () {
            const data = roleChangeData(Role.Moderator);

            const tx = registry.connect(adminA).requestCriticalAction(
                alice.address, CriticalAction.RoleChange, data
            );

            await expect(tx).to.emit(registry, "CriticalActionRequested");
        });

        it("returns a non-zero approvalId", async function () {
            const data = roleChangeData(Role.Moderator);
            const id   = await registry.connect(adminA).requestCriticalAction
                .staticCall(alice.address, CriticalAction.RoleChange, data);
            expect(id).to.not.equal(ethers.ZeroHash);
        });

        it("stores the request — getApprovalRequest reflects it", async function () {
            const data = roleChangeData(Role.Moderator);
            await registry.connect(adminA).requestCriticalAction(
                alice.address, CriticalAction.RoleChange, data
            );

            const id  = await registry.buildApprovalId(
                adminA.address, alice.address, CriticalAction.RoleChange, data
            );
            const req = await registry.getApprovalRequest(id);

            expect(req.exists).to.be.true;
            expect(req.isApproved).to.be.false;
            expect(req.requester).to.equal(adminA.address);
            expect(req.target).to.equal(alice.address);
        });

        it("reverts for non-admin caller", async function () {
            const data = roleChangeData(Role.Moderator);
            await expect(
                registry.connect(alice).requestCriticalAction(
                    stranger.address, CriticalAction.RoleChange, data
                )
            ).to.be.revertedWithCustomError(registry, "NotAdmin");
        });

        it("reverts when owner calls (owner needs no 2FA)", async function () {
            const data = roleChangeData(Role.Moderator);
            await expect(
                registry.connect(owner).requestCriticalAction(
                    alice.address, CriticalAction.RoleChange, data
                )
            ).to.be.revertedWith("IM: owner needs no 2FA");
        });

        it("reverts for an unregistered target", async function () {
            const data = roleChangeData(Role.Moderator);
            await expect(
                registry.connect(adminA).requestCriticalAction(
                    stranger.address, CriticalAction.RoleChange, data
                )
            ).to.be.revertedWithCustomError(registry, "NotRegistered");
        });
    });

    // approveCriticalAction() — admin fallback path (no secondary wallet)
    describe("approveCriticalAction() — admin fallback", function () {
        let approvalId: string;

        beforeEach(async function () {
            const data = roleChangeData(Role.Moderator);
            await registry.connect(adminA).requestCriticalAction(
                alice.address, CriticalAction.RoleChange, data
            );
            approvalId = await registry.buildApprovalId(
                adminA.address, alice.address, CriticalAction.RoleChange, data
            );
        });

        it("another admin can approve and emits CriticalActionApproved", async function () {
            await expect(
                registry.connect(adminB).approveCriticalAction(approvalId)
            ).to.emit(registry, "CriticalActionApproved")
             .withArgs(approvalId, adminB.address, (v: bigint) => v > 0n);
        });

        it("owner can approve as fallback approver", async function () {
            await expect(
                registry.connect(owner).approveCriticalAction(approvalId)
            ).to.emit(registry, "CriticalActionApproved");
        });

        it("requester cannot self-approve", async function () {
            await expect(
                registry.connect(adminA).approveCriticalAction(approvalId)
            ).to.be.revertedWithCustomError(registry, "NotAuthorizedApprover");
        });

        it("a regular user cannot approve", async function () {
            await expect(
                registry.connect(alice).approveCriticalAction(approvalId)
            ).to.be.revertedWithCustomError(registry, "NotAuthorizedApprover");
        });

        it("double-approval reverts with AlreadyApproved", async function () {
            await registry.connect(adminB).approveCriticalAction(approvalId);
            await expect(
                registry.connect(adminB).approveCriticalAction(approvalId)
            ).to.be.revertedWithCustomError(registry, "AlreadyApproved");
        });

        it("reverts for unknown approvalId", async function () {
            await expect(
                registry.connect(adminB).approveCriticalAction(ethers.id("fake"))
            ).to.be.revertedWithCustomError(registry, "ApprovalNotFound");
        });

        it("reverts after TTL expires", async function () {
            await time.increase(ONE_HOUR + 1);
            await expect(
                registry.connect(adminB).approveCriticalAction(approvalId)
            ).to.be.revertedWithCustomError(registry, "ApprovalExpired");
        });
    });

    // approveCriticalAction() — secondary wallet path
    describe("approveCriticalAction() — secondary wallet path", function () {
        let approvalId: string;

        beforeEach(async function () {
            // adminA registers a secondary wallet
            await registry.connect(adminA).setSecondaryWallet(secondary.address);

            const data = roleChangeData(Role.Moderator);
            await registry.connect(adminA).requestCriticalAction(
                alice.address, CriticalAction.RoleChange, data
            );
            approvalId = await registry.buildApprovalId(
                adminA.address, alice.address, CriticalAction.RoleChange, data
            );
        });

        it("secondary wallet can approve", async function () {
            await expect(
                registry.connect(secondary).approveCriticalAction(approvalId)
            ).to.emit(registry, "CriticalActionApproved")
             .withArgs(approvalId, secondary.address, (v: bigint) => v > 0n);
        });

        it("another admin CANNOT approve when secondary wallet is set", async function () {
            // When a secondary is set, only that secondary wallet is valid
            await expect(
                registry.connect(adminB).approveCriticalAction(approvalId)
            ).to.be.revertedWithCustomError(registry, "NotAuthorizedApprover");
        });

        it("owner CANNOT approve when secondary wallet is set", async function () {
            await expect(
                registry.connect(owner).approveCriticalAction(approvalId)
            ).to.be.revertedWithCustomError(registry, "NotAuthorizedApprover");
        });
    });

    // Full 2FA flow — assignRole (non-owner admin)
    describe("assignRole() — full 2FA flow (non-owner admin)", function () {

        it("non-owner admin can promote a user after approval", async function () {
            const data = roleChangeData(Role.Moderator);

            await registry.connect(adminA).requestCriticalAction(
                alice.address, CriticalAction.RoleChange, data
            );
            const approvalId = await registry.buildApprovalId(
                adminA.address, alice.address, CriticalAction.RoleChange, data
            );
            await registry.connect(adminB).approveCriticalAction(approvalId);

            await registry.connect(adminA).assignRole(alice.address, Role.Moderator);

            expect(await registry.getRole(alice.address)).to.equal(Role.Moderator);
        });

        it("assignRole reverts without prior approval (non-owner admin)", async function () {
            // No request or approval made first
            await expect(
                registry.connect(adminA).assignRole(alice.address, Role.Moderator)
            ).to.be.revertedWithCustomError(registry, "ApprovalNotFound");
        });

        it("assignRole reverts if approval not yet granted", async function () {
            const data = roleChangeData(Role.Moderator);
            await registry.connect(adminA).requestCriticalAction(
                alice.address, CriticalAction.RoleChange, data
            );
            // Approval step skipped intentionally
            await expect(
                registry.connect(adminA).assignRole(alice.address, Role.Moderator)
            ).to.be.revertedWithCustomError(registry, "ApprovalRequired");
        });

        it("approval is single-use — second assignRole call reverts", async function () {
            const data = roleChangeData(Role.Moderator);

            await registry.connect(adminA).requestCriticalAction(
                alice.address, CriticalAction.RoleChange, data
            );
            const approvalId = await registry.buildApprovalId(
                adminA.address, alice.address, CriticalAction.RoleChange, data
            );
            await registry.connect(adminB).approveCriticalAction(approvalId);

            // First call succeeds and consumes the approval
            await registry.connect(adminA).assignRole(alice.address, Role.Moderator);

            // Second call for the same action must fail
            await expect(
                registry.connect(adminA).assignRole(alice.address, Role.Moderator)
            ).to.be.reverted;
        });
    });

    // Full 2FA flow — deactivateUser (non-owner admin)
    describe("deactivateUser() — full 2FA flow (non-owner admin)", function () {

        it("non-owner admin can deactivate after approval", async function () {
            const data = deactivationData(alice.address);

            await registry.connect(adminA).requestCriticalAction(
                alice.address, CriticalAction.Deactivation, data
            );
            const approvalId = await registry.buildApprovalId(
                adminA.address, alice.address, CriticalAction.Deactivation, data
            );
            await registry.connect(adminB).approveCriticalAction(approvalId);

            await registry.connect(adminA).deactivateUser(alice.address);

            expect(
                (await registry.getUserDetails(alice.address)).isActive
            ).to.be.false;
        });

        it("deactivateUser reverts without prior approval (non-owner admin)", async function () {
            await expect(
                registry.connect(adminA).deactivateUser(alice.address)
            ).to.be.revertedWithCustomError(registry, "ApprovalNotFound");
        });

        it("deactivateUser reverts if TTL expired before execution", async function () {
            const data = deactivationData(alice.address);

            await registry.connect(adminA).requestCriticalAction(
                alice.address, CriticalAction.Deactivation, data
            );
            const approvalId = await registry.buildApprovalId(
                adminA.address, alice.address, CriticalAction.Deactivation, data
            );
            await registry.connect(adminB).approveCriticalAction(approvalId);

            // Advance past the TTL
            await time.increase(ONE_HOUR + 1);

            await expect(
                registry.connect(adminA).deactivateUser(alice.address)
            ).to.be.revertedWithCustomError(registry, "ApprovalExpired");
        });
    });
  
    // Owner bypass — no 2FA required
    describe("Owner bypass", function () {

        it("owner can assignRole directly without requestCriticalAction", async function () {
            await registry.connect(owner).assignRole(alice.address, Role.Moderator);
            expect(await registry.getRole(alice.address)).to.equal(Role.Moderator);
        });

        it("owner can deactivateUser directly without requestCriticalAction", async function () {
            await registry.connect(owner).deactivateUser(alice.address);
            expect(
                (await registry.getUserDetails(alice.address)).isActive
            ).to.be.false;
        });
    });
});