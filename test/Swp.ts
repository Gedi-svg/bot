const { ethers } = require("ethers");
const FlashArbitrageV3 = require("../artifacts/contracts/Fv3.sol/FlashArbitrageV3.json");
const IUniswapV3Factory = require("../artifacts/@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json");
const INonfungiblePositionManager = require("../artifacts/@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol/INonfungiblePositionManager.json");

// Set up provider and walle
const provider = new ethers.providers.JsonRpcProvider({
  url: "https://polygon-mainnet.g.alchemy.com/v2/DcqRhPPSW0upcwmCtR8oa3Pb2clizqgG",
  timeout: 20000 // Increase timeout to 20 seconds
});

const wallet = new ethers.Wallet("0xc1101453fdd090e6cf6f3bc2f56564dd8e7c277e76c711ada47e45721fd9ab51", provider);  // Replace with your private key

// Contract addresses
const flashArbitrageAddress = "0xaDBE79DdAC961a2ea340E5595C94D67675c0b1B7";
const uniswapFactoryAddress = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const positionManagerAddress = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";

// Initialize contracts
async function initializeContracts() {
    let flashArbitrageContract = new ethers.Contract(flashArbitrageAddress, FlashArbitrageV3.abi, wallet);
    let uniswapFactoryContract = new ethers.Contract(uniswapFactoryAddress, IUniswapV3Factory.abi, wallet);
    let positionManagerContract = new ethers.Contract(positionManagerAddress, INonfungiblePositionManager.abi, wallet);

    return { flashArbitrageContract, uniswapFactoryContract, positionManagerContract };
}

// Token addresses
const tokenA = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"; 
const tokenB = "0xb33eaad8d922b1083446dc23f610c2567fb5180f";
const tokenC = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619";

// Function to get the pool address from Uniswap V3 Factory
async function getPoolAddress(uniswapFactoryContract, token0, token1) {
    return await uniswapFactoryContract.getPool(token0, token1, 3000);
}

// Function to get position IDs for a specific pool address
async function getPositionIdsForPool(positionManagerContract, poolAddress) {
    const totalSupply = await positionManagerContract.totalSupply();
    const positionIds = [];

    // Iterate through all positions
    for (let i = 0; i < totalSupply.toNumber(); i++) {
        const positionId = await positionManagerContract.tokenByIndex(i);
        const positionInfo = await positionManagerContract.positions(positionId);

        // Check if the pool address matches
        if (positionInfo.poolAddress === poolAddress) {
            positionIds.push(positionId);
        }
    }

    return positionIds;
}

async function executeFlashArbitrage() {
    try {
        // Initialize contracts
        const { flashArbitrageContract, uniswapFactoryContract, positionManagerContract } = await initializeContracts();

        // Fetch pool addresses
        const poolAddressAB = await getPoolAddress(uniswapFactoryContract, tokenA, tokenB);
        const poolAddressBC = await getPoolAddress(uniswapFactoryContract, tokenB, tokenC);
        const poolAddressCA = await getPoolAddress(uniswapFactoryContract, tokenC, tokenA);

        // Log pool addresses
        console.log('Pool address AB:', poolAddressAB);
        console.log('Pool address BC:', poolAddressBC);
        console.log('Pool address CA:', poolAddressCA);

        // Fetch position IDs for specific pools
        const positionIdsAB = await getPositionIdsForPool(positionManagerContract, poolAddressAB);
        const positionIdsBC = await getPositionIdsForPool(positionManagerContract, poolAddressBC);
        const positionIdsCA = await getPositionIdsForPool(positionManagerContract, poolAddressCA);

        // Log position IDs
        console.log('Position IDs for Pool AB:', positionIdsAB);
        console.log('Position IDs for Pool BC:', positionIdsBC);
        console.log('Position IDs for Pool CA:', positionIdsCA);

        // Assuming you need the first position ID for each pool
        const positionIdAB = positionIdsAB[0];
        const positionIdBC = positionIdsBC[0];
        const positionIdCA = positionIdsCA[0];

        const poolData = {
            poolAddressAB,
            poolAddressBC,
            poolAddressCA,
            positionIdAB,
            positionIdBC,
            positionIdCA,
            borrowAmount: ethers.utils.parseEther("5"), // Example borrow amount
            profit1: 0,
            profit2: 0,
            profit3: 0
        };

        // Paths for token pairs
        const path1 = [tokenA, tokenB, tokenC];
        const path2 = [tokenB, tokenC, tokenA];
        const path3 = [tokenC, tokenA, tokenB];

        // Execute flash arbitrage (non-blocking)
        flashArbitrageContract.executeFlashArbitrage(path1, path2, path3, ethers.utils.parseEther("1"), poolData, { gasLimit: 2000000 })
            .then(() => console.log("Arbitrage executed successfully"))
            .catch((err) => console.error("Error executing arbitrage:", err));
    } catch (error) {
        console.error("Error during flash arbitrage setup:", error);
    }
}

// Run the flash arbitrage
executeFlashArbitrage();
