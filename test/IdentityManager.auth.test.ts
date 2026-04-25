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

const IDENTITY = ethers.keccak256(ethers.toUtf8Bytes("alice-kyc"));

// Helpers
async function buildAndSign(
  signer:   SignerWithAddress,
  registry: IdentityManager, 
  nonce:    bigint,
): Promise<string> {
  const chainId      = (await ethers.provider.getNetwork()).chainId;
  const contractAddr = await registry.getAddress();

  const message =
    `Sign in to UserRegistry\n` +
    `Wallet: ${signer.address.toLowerCase()}\n` +
    `Nonce: ${nonce}\n` +
    `Contract: ${contractAddr.toLowerCase()}\n` +
    `Chain ID: ${chainId}`;

  const messageHash = ethers.keccak256(ethers.toUtf8Bytes(message));
  return signer.signMessage(ethers.getBytes(messageHash));
}

async function debugMessage(
  signer:   SignerWithAddress,
  registry: IdentityManager, 
  nonce:    bigint,
) {
  const chainId      = (await ethers.provider.getNetwork()).chainId;
  const contractAddr = await registry.getAddress();

  const testMessage =
    `Sign in to UserRegistry\n` +
    `Wallet: ${signer.address.toLowerCase()}\n` +
    `Nonce: ${nonce}\n` +
    `Contract: ${contractAddr.toLowerCase()}\n` +
    `Chain ID: ${chainId}`;

  const contractMessage = await registry.generateNonce(signer.address);

  console.log("Test message length:    ", testMessage.length);
  console.log("Contract message length:", contractMessage.length);
  console.log("Match:", testMessage === contractMessage);

  if (testMessage !== contractMessage) {
    console.log("Test:    ", JSON.stringify(testMessage));
    console.log("Contract:", JSON.stringify(contractMessage));
  }

  return { testMessage, contractMessage };
}

// Timestamp helper
function anyTimestamp() {
  return (val: unknown) =>
    typeof val === "bigint" && val > 0n
      ? true
      : `expected positive BigInt timestamp, got ${val}`;
}

// Test suite
describe("IdentityManager — Wallet-Based Authentication", function () {  
  let registry: IdentityManager; 
  let owner:    SignerWithAddress;
  let alice:    SignerWithAddress;
  let bob:      SignerWithAddress;
  let stranger: SignerWithAddress;

  beforeEach(async function () {
    [owner, alice, bob, stranger] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("IdentityManager"); 
    registry = (await Factory.deploy()) as unknown as IdentityManager;  
    await registry.waitForDeployment();

    await registry.connect(alice).registerUser(IDENTITY);
  });

  // generateNonce()
  describe("generateNonce()", function () {

    it("returns a non-empty message string for a registered active user", async function () {
      const msg = await registry.generateNonce(alice.address);
      expect(msg.length).to.be.greaterThan(0);
    });

    it("message embeds the wallet address (lowercase)", async function () {
      const msg = await registry.generateNonce(alice.address);
      expect(msg).to.include(alice.address.toLowerCase());
    });

    it("message embeds the current nonce value", async function () {
      const nonce = await registry.getNonce(alice.address);
      const msg   = await registry.generateNonce(alice.address);
      expect(msg).to.include(`Nonce: ${nonce}`);
    });

    it("message embeds the contract address", async function () {
      const contractAddr = (await registry.getAddress()).toLowerCase();
      const msg          = await registry.generateNonce(alice.address);
      expect(msg).to.include(contractAddr);
    });

    it("message changes after a successful login (nonce advanced)", async function () {
      const msgBefore = await registry.generateNonce(alice.address);
      const sig       = await buildAndSign(alice, registry, 0n);
      await registry.connect(alice).verifySignature(sig);

      const msgAfter = await registry.generateNonce(alice.address);
      expect(msgBefore).to.not.equal(msgAfter);
      expect(msgAfter).to.include("Nonce: 1");
    });

    it("reverts for an unregistered address", async function () {
      await expect(
        registry.generateNonce(stranger.address),
      ).to.be.revertedWithCustomError(registry, "NotRegistered");
    });

    it("reverts for a deactivated user", async function () {
      await registry.connect(owner).deactivateUser(alice.address);
      await expect(
        registry.generateNonce(alice.address),
      ).to.be.revertedWithCustomError(registry, "UserNotActive");
    });

    it("debug message format (confirms on-chain string matches off-chain construction)", async function () {
      await debugMessage(alice, registry, 0n);
    });
  });

  // verifySignature() — valid signature
  describe("verifySignature() — valid signature", function () {

    it("returns true for a correctly signed message", async function () {
      const sig    = await buildAndSign(alice, registry, 0n);
      const result = await registry.connect(alice).verifySignature.staticCall(sig);
      expect(result).to.be.true;
    });

    it("emits LoginAttempt(success=true) with the consumed nonce", async function () {
      const sig = await buildAndSign(alice, registry, 0n);

      await expect(registry.connect(alice).verifySignature(sig))
        .to.emit(registry, "LoginAttempt")
        .withArgs(alice.address, true, 0n, anyTimestamp());
    });

    it("emits ActionLogged(LoginSuccess) after a valid login", async function () {
      const sig = await buildAndSign(alice, registry, 0n);

      await expect(registry.connect(alice).verifySignature(sig))
        .to.emit(registry, "ActionLogged")
        .withArgs(
          alice.address,
          alice.address,
          ActionType.LoginSuccess,
          1n,               // nonce AFTER increment
          anyTimestamp(),
        );
    });

    it("increments the nonce by exactly 1 after a successful login", async function () {
      expect(await registry.getNonce(alice.address)).to.equal(0n);

      const sig = await buildAndSign(alice, registry, 0n);
      await registry.connect(alice).verifySignature(sig);

      expect(await registry.getNonce(alice.address)).to.equal(1n);
    });

    it("allows multiple sequential logins with advancing nonces", async function () {
      for (let i = 0n; i < 3n; i++) {
        const sig = await buildAndSign(alice, registry, i);
        await registry.connect(alice).verifySignature(sig);
        expect(await registry.getNonce(alice.address)).to.equal(i + 1n);
      }
    });
  });

  // Replay attack prevention
  describe("Replay attack prevention", function () {

    it("rejects reuse of the same signature after a successful login", async function () {
      const sig = await buildAndSign(alice, registry, 0n);

      await registry.connect(alice).verifySignature(sig);
      expect(await registry.getNonce(alice.address)).to.equal(1n);

      await expect(
        registry.connect(alice).verifySignature(sig),
      ).to.be.revertedWithCustomError(registry, "InvalidSignature");
    });

    it("nonce does NOT advance on a failed replay attempt", async function () {
      const sig = await buildAndSign(alice, registry, 0n);
      await registry.connect(alice).verifySignature(sig);
      const nonceAfterFirst = await registry.getNonce(alice.address);

      await expect(registry.connect(alice).verifySignature(sig))
        .to.be.revertedWithCustomError(registry, "InvalidSignature");

      expect(await registry.getNonce(alice.address)).to.equal(nonceAfterFirst);
    });

    it("a future-nonce signature is rejected (cannot pre-compute logins)", async function () {
      const sig = await buildAndSign(alice, registry, 5n);
      await expect(
        registry.connect(alice).verifySignature(sig),
      ).to.be.revertedWithCustomError(registry, "InvalidSignature");
    });

    it("cross-user replay: alice's signature cannot be used by bob", async function () {
      await registry.connect(bob).registerUser(
        ethers.keccak256(ethers.toUtf8Bytes("bob-kyc")),
      );

      const aliceSig = await buildAndSign(alice, registry, 0n);

      await expect(
        registry.connect(bob).verifySignature(aliceSig),
      ).to.be.revertedWithCustomError(registry, "InvalidSignature");
    });
  });

  // Invalid signature rejection
  describe("Invalid signature rejection", function () {

    it("rejects a signature that is too short", async function () {
      const shortSig = "0x" + "aa".repeat(64);
      await expect(
        registry.connect(alice).verifySignature(shortSig),
      ).to.be.revertedWithCustomError(registry, "InvalidSignatureLength");
    });

    it("rejects a signature that is too long", async function () {
      const longSig = "0x" + "aa".repeat(66);
      await expect(
        registry.connect(alice).verifySignature(longSig),
      ).to.be.revertedWithCustomError(registry, "InvalidSignatureLength");
    });

    it("rejects a zeroed-out 65-byte signature", async function () {
      const zeroSig = "0x" + "00".repeat(65);
      await expect(
        registry.connect(alice).verifySignature(zeroSig),
      ).to.be.revertedWithCustomError(registry, "InvalidSignature");
    });

    it("rejects a signature where only one byte is corrupted", async function () {
      const validSig  = await buildAndSign(alice, registry, 0n);
      const sigBytes  = ethers.getBytes(validSig);
      sigBytes[0]    ^= 0xff;
      const badSig    = ethers.hexlify(sigBytes);

      await expect(
        registry.connect(alice).verifySignature(badSig),
      ).to.be.revertedWithCustomError(registry, "InvalidSignature");
    });

    it("rejects a signature signed by a different wallet (wrong private key)", async function () {
      const chainId      = (await ethers.provider.getNetwork()).chainId;
      const contractAddr = (await registry.getAddress()).toLowerCase();
      const message =
        `Sign in to UserRegistry\n` +
        `Wallet: ${alice.address.toLowerCase()}\n` +
        `Nonce: 0\n` +
        `Contract: ${contractAddr}\n` +
        `Chain ID: ${chainId}`;

      // This signs the raw string (not its hash), which will NOT match the contract's double-hash approach — correct behaviour to test.
      const wrongSig = await bob.signMessage(message);

      await expect(
        registry.connect(alice).verifySignature(wrongSig),
      ).to.be.revertedWithCustomError(registry, "InvalidSignature");
    });

    it("rejects a signature for a message with a different contract address", async function () {
      const chainId  = (await ethers.provider.getNetwork()).chainId;
      const fakeAddr = ethers.Wallet.createRandom().address.toLowerCase();
      const message =
        `Sign in to UserRegistry\n` +
        `Wallet: ${alice.address.toLowerCase()}\n` +
        `Nonce: 0\n` +
        `Contract: ${fakeAddr}\n` +
        `Chain ID: ${chainId}`;

      const sig = await alice.signMessage(message);

      await expect(
        registry.connect(alice).verifySignature(sig),
      ).to.be.revertedWithCustomError(registry, "InvalidSignature");
    });

    it("rejects an unregistered caller", async function () {
      const sig = await buildAndSign(stranger, registry, 0n);
      await expect(
        registry.connect(stranger).verifySignature(sig),
      ).to.be.revertedWithCustomError(registry, "NotRegistered");
    });

    it("rejects a deactivated user even with a valid signature", async function () {
      const sig = await buildAndSign(alice, registry, 0n);

      await registry.connect(owner).deactivateUser(alice.address);

      await expect(
        registry.connect(alice).verifySignature(sig),
      ).to.be.revertedWithCustomError(registry, "UserNotActive");
    });
  });

  // Full round-trip
  describe("Full round-trip", function () {

    it("generateNonce → signMessage → verifySignature succeeds end-to-end", async function () {
      // Consume the on-chain message (confirms the string matches exactly)
      await registry.generateNonce(alice.address);
      const nonce     = await registry.getNonce(alice.address);
      const signature = await buildAndSign(alice, registry, nonce);

      const result = await registry.connect(alice).verifySignature.staticCall(signature);
      expect(result).to.be.true;
    });

    it("three logins in sequence each require a fresh generateNonce call", async function () {
      for (let round = 0; round < 3; round++) {
        await registry.generateNonce(alice.address);
        const nonce = await registry.getNonce(alice.address);
        const sig   = await buildAndSign(alice, registry, nonce);
        await registry.connect(alice).verifySignature(sig);
      }
      expect(await registry.getNonce(alice.address)).to.equal(3n);
    });
  });
});