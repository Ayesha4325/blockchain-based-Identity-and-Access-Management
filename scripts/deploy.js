const { ethers } = require("hardhat");

async function main() {
  const IdentityManager = await ethers.getContractFactory("IdentityManager");
  const identityManager = await IdentityManager.deploy();
  
  await identityManager.waitForDeployment();
  
  console.log("IdentityManager deployed to:", await identityManager.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});