const { ethers, run } = require("hardhat");
const { deployer } = require("../.secret");

// WBNB address on BSC, WETH address on Polygon
const wbnb = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"; // Note: This is BSC, adjust if deploying on Polygon
const WmaticAddr = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"; // WMATIC on Polygon
const uniRout = "0xE592427A0AEce92De3Edee1F18E0157C05861564"; // Uniswap V3 SwapRouter
const posman = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88"; // NonfungiblePositionManager
const quoter = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e"; // QuoterV2
const factory = "0x1F98431c8aD98523631AE4a59f267346ea31F984"; // Uniswap V3 Factory

async function main() {
  // Compile the contracts
  await run("compile");

  // Get the contract factory
  const FlashBot = await ethers.getContractFactory("FlashArbitrageVn");

  // Deploy the contract
  const flashBot = await FlashBot.deploy(WmaticAddr, factory, uniRout, posman, quoter);//, {
   // gasPrice: ethers.utils.parseUnits("150", "gwei"),
   // gasLimit: 17000000,
 // });

  // Wait for the deployment transaction to be mined
 // const receipt = await flashBot.deployTransaction.wait();

  // Log the transaction hash, block number, and deployed address
  console.log(`FlashBot deployed to: ${flashBot.address}`);
  //console.log(`Transaction hash: ${receipt.transactionHash}`);
  //console.log(`Deployed in block: ${receipt.blockNumber}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });