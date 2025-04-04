const { ethers } = require("ethers");
const FlashArbitrageV3 = require("../artifacts/contracts/Fv3.sol/FlashArbitrageV3.json");
const IUniswapV3Factory = require("../artifacts/@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json");
const INonfungiblePositionManager = require("../artifacts/@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol/INonfungiblePositionManager.json");
const { GraphQLClient, gql } = require("graphql-request");

const graphClient = new GraphQLClient("https://api.studio.thegraph.com/query/87062/pos/version/latest");

// Set up provider and wallet
const provider = new ethers.providers.JsonRpcProvider({
  url: "https://polygon-mainnet.g.alchemy.com/v2/DcqRhPPSW0upcwmCtR8oa3Pb2clizqgG",
  timeout: 20000 // Increase timeout to 20 seconds
});

const wallet = new ethers.Wallet("", provider); // Replace with your private key

// Contract addresses
const flashArbitrageAddress = "0xaDBE79DdAC961a2ea340E5595C94D67675c0b1B7";
const uniswapFactoryAddress = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const positionManagerAddress = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";

const GET_POSITIONS_BY_POOL = gql`
    query GetPositionsByPool($poolAddress: Bytes!) {
        positions(where: { poolAddress: $poolAddress }) {
            id
            tokenId
        }
    }
`;

const GET_POOL_ADDRESS = gql`
    query GetPoolAddress($token0: Bytes!, $token1: Bytes!, $fee: String!) {
        pools(where: { token0: $token0, token1: $token1, fee: $fee }) {
            id
            poolAddress
        }
    }
`;

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


/*async function getPoolAddress(uniswapFactoryContract, token0, token1) {
    return await uniswapFactoryContract.getPool(token0, token1, 3000);
}*/
// Function to get the pool address from Uniswap V3 Factory
// Fetch pool address using The Graph
async function getPoolAddress(token0, token1, fee) {
    const variables = {
        token0: token0.toLowerCase(),
        token1: token1.toLowerCase(),
        fee: fee.toString()
    };

    const response = await graphClient.request(GET_POOL_ADDRESS, variables);
    if (response.pools.length > 0) {
        return response.pools[0].address;
    } else {
        throw new Error(`No pool found for tokens ${token0} and ${token1} with fee ${fee}`);
    }
}

// Fetch position IDs for a specific pool using The Graph
async function getPositionIdsForPool(poolAddress) {
    const variables = { poolAddress: poolAddress.toLowerCase() };

    const response = await graphClient.request(GET_POSITIONS_BY_POOL, variables);
    if (response.positions.length > 0) {
        return response.positions.map(position => position.tokenId);
    } else {
        throw new Error(`No positions found for pool ${poolAddress}`);
    }
}

async function executeFlashArbitrage() {
    try {
        // Initialize contracts (no change here)
        const { flashArbitrageContract, uniswapFactoryContract, positionManagerContract } = await initializeContracts();

        // Fetch pool addresses using The Graph
        const poolAddressAB = await getPoolAddress( tokenA, tokenB, 3000);
        const poolAddressBC = await getPoolAddress( tokenB, tokenC, 3000);
        const poolAddressCA = await getPoolAddress( tokenC, tokenA,3000);

        // Log pool addresses
        console.log('Pool address AB:', poolAddressAB);
        console.log('Pool address BC:', poolAddressBC);
        console.log('Pool address CA:', poolAddressCA);

        // Fetch position IDs for specific pools using The Graph
        const positionIdsAB = await getPositionIdsForPool(poolAddressAB);
        const positionIdsBC = await getPositionIdsForPool(poolAddressBC);
        const positionIdsCA = await getPositionIdsForPool(poolAddressCA);

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
