const { ethers } = require("ethers");
const FlashArbitrageV3 = require("../artifacts/contracts/Fv3.sol/FlashArbitrageV3.json");
const IUniswapV3Factory = require("../artifacts/@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json");
const INonfungiblePositionManager = require("../artifacts/@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol/INonfungiblePositionManager.json");

// Set up provider and wallet
const provider = new ethers.providers.JsonRpcProvider({
  url: "https://polygon-mainnet.g.alchemy.com/v2/DcqRhPPSW0upcwmCtR8oa3Pb2clizqgG",
  timeout: 20000 // Increase timeout to 20 seconds
});

const wallet = new ethers.Wallet("0xc1101453fdd090e6cf6f3bc2f56564dd8e7c277e76c711ada47e45721fd9ab51", provider); // Replace with your private key

// Contract addresses
const flashArbitrageAddress = "0xaDBE79DdAC961a2ea340E5595C94D67675c0b1B7";
const uniswapFactoryAddress = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const positionManagerAddress = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";

// Initialize contracts
async function initializeContracts() {
    let flashArbitrageContract = new ethers.Contract(flashArbitrageAddress, FlashArbitrageV3.abi, wallet);
    let uniswapFactoryContract = new ethers.Contract(uniswapFactoryAddress, IUniswapV3Factory.abi, wallet);
    let positionManagerContract = new ethers.Contract(positionManagerAddress, INonfungiblePositionManager.abi, provider);

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

// Utility function to query logs with retry logic
async function queryLogsWithRetry(filter, fromBlock, toBlock, maxRetries = 3, retryDelay = 2000) {
    let attempts = 0;
    while (attempts < maxRetries) {
        try {
            return await provider.getLogs({
                ...filter,
                fromBlock,
                toBlock
            });
        } catch (error) {
            attempts++;
            if (attempts >= maxRetries) {
                throw error;
            }
            console.warn(`Retrying due to error: ${error.message}. Attempt ${attempts} of ${maxRetries}`);
            await new Promise(resolve => setTimeout(resolve, retryDelay)); // Wait before retrying
        }
    }
}

// Function to get position IDs for a specific pool address
async function getPositionIdsForPool(positionManagerContract, poolAddress) {
    const currentBlock = await provider.getBlockNumber();
    const step = 2000;  // Adjust the step size based on your needs
    const positionIds = [];

    for (let i = 0; i < currentBlock; i += step) {
        const fromBlock = i;
        const toBlock = Math.min(i + step, currentBlock);

        const filter = positionManagerContract.filters.Transfer(null, null); // Capture all transfers

        try {
            const events = await queryLogsWithRetry(filter, fromBlock, toBlock);

            for (const event of events) {
                const { tokenId } = event.args;
                const positionInfo = await positionManagerContract.positions(tokenId);

                if (positionInfo && positionInfo.pool && positionInfo.pool.toLowerCase() === poolAddress.toLowerCase()) {
                    console.log(`Matching Position Found: Token ID ${tokenId.toString()} belongs to Pool ${poolAddress}`);
                    positionIds.push(tokenId);
                }
            }
        } catch (error) {
            console.error(`Failed to query logs for blocks ${fromBlock} to ${toBlock}: ${error.message}`);
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

        // Check for valid position IDs
        if (positionIdsAB.length === 0 || positionIdsBC.length === 0 || positionIdsCA.length === 0) {
            throw new Error("One or more pools have no associated positions.");
        }

        // Validate and select position IDs
        const positionIdAB = positionIdsAB[0];
        const positionIdBC = positionIdsBC[0];
        const positionIdCA = positionIdsCA[0];

        if (!positionIdAB || !positionIdBC || !positionIdCA) {
            throw new Error("Invalid Position IDs retrieved.");
        }

        // Prepare pool data
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

        // Execute flash arbitrage
        const tx = await flashArbitrageContract.executeFlashArbitrage(
            path1,
            path2,
            path3,
            ethers.utils.parseEther("1"),
            poolData,
            { gasLimit: 2000000 }
        );

        // Wait for transaction confirmation
        const receipt = await tx.wait();
        console.log("Transaction successful:", receipt);
    } catch (error) {
        console.error("Error during flash arbitrage execution:", error);
    }
}

// Run the flash arbitrage
executeFlashArbitrage()
    .then(() => console.log("Arbitrage executed successfully"))
    .catch((err) => console.error("Error executing arbitrage:", err));
