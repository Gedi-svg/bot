const { BigNumber} = require("ethers");
const { ethers } = require("hardhat");
//const { deployer } = require("../.secret");
//const { Alchemy, Network } = require("@alch/alchemy-sdk");
const FlashArbitrageV3 = require("../artifacts/contracts/Fv3.sol/FlashArbitrageV3.json");
const UniswapFactory = require("../artifacts/@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json");
const { GraphQLClient, gql } = require("graphql-request");
//const { parseUnits , formatUnits} = require("ethers/lib/utils");

/*// Configure Alchemy
const alchemy = new Alchemy({
    apiKey: "DcqRhPPSW0upcwmCtR8oa3Pb2clizqgG",
    network: Network.MATIC_MAINNET,
});*/
// Set up GraphQL client for Uniswap V3 subgraph
const graphClient = new GraphQLClient("https://gateway.thegraph.com/api/a3b0cf80798ffdc9fa07f665b44aa809/subgraphs/id/3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm");

// Set up provider and wallet
const provider = new ethers.providers.JsonRpcProvider({
    url: "https://polygon-mainnet.g.alchemy.com/v2/DcqRhPPSW0upcwmCtR8oa3Pb2clizqgG",
    timeout: 500000,
});
//const api = "https://polygon-mainnet.g.alchemy.com/v2/DcqRhPPSW0upcwmCtR8oa3Pb2clizqgG";

//const provider = new ethers.providers.AlchemyProvider("mainnet", "DcqRhPPSW0upcwmCtR8oa3Pb2clizqgG");
//0x76E66845076A83B9BE2B1A023b7e45eA12691fD2

const wallet = new ethers.Wallet("0xc1101453fdd090e6cf6f3bc2f56564dd8e7c277e76c711ada47e45721fd9ab51", provider); // Replace with your private key

// Contract addresses
const flashArbitrageAddress = "0x76E66845076A83B9BE2B1A023b7e45eA12691fD2";
const factoryAddress = "0x1F98431c8aD98523631AE4a59f267346ea31F984";


// Initialize contracts
async function initializeContracts() {
    let flashArbitrageContract = new ethers.Contract(flashArbitrageAddress, FlashArbitrageV3.abi, wallet);
    let factoryContract = new ethers.Contract(factoryAddress, UniswapFactory.abi, wallet);
    return { flashArbitrageContract, factoryContract };
}

const GET_POSITIONS = gql`
    query GetPositions($poolId: String!) {
        positions(where: { pool: $poolId }) {
            id
            owner
            liquidity
            token0 {
                id
            }
            token1 {
                id
            }
        }
    }
`;

async function getPoolAddress(tokenA, tokenB, fee) {
    const { factoryContract } = await initializeContracts();
    const poolAddress = await factoryContract.getPool(tokenA, tokenB, fee);
    if (poolAddress === ethers.constants.AddressZero) {
        throw new Error(`Pool not found for pair ${tokenA}-${tokenB}`);
    }
    return poolAddress;
}

async function getPositionWithHighestLiquidity(poolId, expectedToken0, expectedToken1) {
    const variables = { poolId: poolId.toLowerCase() };

    const response = await graphClient.request(GET_POSITIONS, variables);
    const positions = response.positions;

    if (positions.length > 0) {
        let validPositions = positions.filter(
            (position) =>
                position.liquidity > 0 &&
                position.token0.id.toLowerCase() === expectedToken0.toLowerCase() &&
                position.token1.id.toLowerCase() === expectedToken1.toLowerCase()
        );

        if (validPositions.length === 0) {
            console.log(`No positions found with the expected token order (${expectedToken0}, ${expectedToken1}). Trying reversed order...`);
            validPositions = positions.filter(
                (position) =>
                    position.liquidity > 0 &&
                    position.token0.id.toLowerCase() === expectedToken1.toLowerCase() &&
                    position.token1.id.toLowerCase() === expectedToken0.toLowerCase()
            );

            if (validPositions.length > 0) {
                console.log(`Found positions with reversed token order (${expectedToken1}, ${expectedToken0}).`);
            } else {
                console.log(`No positions found with either token order for pool ${poolId}.`);
                return { positionId: ethers.constants.AddressZero, isReversed: false };
            }
        }

        const highestLiquidityPosition = validPositions.sort((a, b) => parseInt(b.liquidity) - parseInt(a.liquidity))[0];
        console.log(`Selected Position ID: ${highestLiquidityPosition.id}, Liquidity: ${highestLiquidityPosition.liquidity}`);
        const isReversed = highestLiquidityPosition.token0.id.toLowerCase() === expectedToken1.toLowerCase();

        return { positionId: highestLiquidityPosition.id, isReversed: isReversed, liquidity: BigNumber.from(highestLiquidityPosition.liquidity)};
    }

    console.log(`No positions with liquidity found for pool ${poolId}`);
    return { positionId: ethers.constants.AddressZero, isReversed: false, liquidity: BigNumber.from(0) };
}


async function calculateOptimalBorrowAmounts(liquidityAB, liquidityBC, liquidityCA) {
    try {
        // Check if liquidity values are valid
        if (!liquidityAB || !liquidityBC || !liquidityCA) {
            throw new Error("Liquidity values must be defined.");
        }

        // Convert liquidity values to BigNumber
        liquidityAB = BigNumber.from(liquidityAB);
        liquidityBC = BigNumber.from(liquidityBC);
        liquidityCA = BigNumber.from(liquidityCA);
        
        // Define constants or thresholds as BigNumber (90%)
        const MAX_BORROW_FRACTION = BigNumber.from("900000000000000000"); // 0.9 in BigNumber (90%)

        // Calculate borrow amounts
        const borrowAmount1 = liquidityAB.mul(MAX_BORROW_FRACTION).div(BigNumber.from("1000000000000000000")); // For path 1 (A -> B -> C)
        const borrowAmount2 = liquidityBC.mul(MAX_BORROW_FRACTION).div(BigNumber.from("1000000000000000000")); // For path 2 (B -> C -> A)
        const borrowAmount3 = liquidityCA.mul(MAX_BORROW_FRACTION).div(BigNumber.from("1000000000000000000")); // For path 3 (C -> A -> B)

        // Pack borrow amounts into an array of BigNumbers
        const borrowAmounts = [borrowAmount1, borrowAmount2, borrowAmount3];

        // Ensure the array is returned in the format of uint256[]
        return borrowAmounts.map(amount => amount.toString()); // Convert BigNumbers to strings for uint256[]

    } catch (error) {
        console.error("Error in calculateOptimalBorrowAmounts:", error.message);
        throw error; // Rethrow the error after logging it
    }
}


async function executeFlashArbitrage() {
    try {
        const { flashArbitrageContract } = await initializeContracts();

        // Define token pairs
        const tokenA = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"; // WMATIC
        const tokenB = "0xb33eaad8d922b1083446dc23f610c2567fb5180f"; // USDT0xb33eaad8d922b1083446dc23f610c2567fb5180f
        const tokenC = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"; // WETH

        // Fetch pool addresses0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270
        const poolIdAB = await getPoolAddress(tokenA, tokenB, 3000);
        const poolIdBC = await getPoolAddress(tokenB, tokenC, 3000);
        const poolIdCA = await getPoolAddress(tokenC, tokenA, 3000);

        // Log pool IDs
        console.log('Pool ID AB:', poolIdAB);
        console.log('Pool ID BC:', poolIdBC);
        console.log('Pool ID CA:', poolIdCA);

        // Fetch position IDs
        const { positionId: positionIdAB, isReversed: isReversedAB, liquidity: liquidityAB } = await getPositionWithHighestLiquidity(poolIdAB, tokenA, tokenB);
        const { positionId: positionIdBC, isReversed: isReversedBC, liquidity: liquidityBC } = await getPositionWithHighestLiquidity(poolIdBC, tokenB, tokenC);
        const { positionId: positionIdCA, isReversed: isReversedCA, liquidity: liquidityCA } = await getPositionWithHighestLiquidity(poolIdCA, tokenC, tokenA);

        // Log position IDs
        console.log('Position IDs for Pool AB:', positionIdAB);
        console.log('Position IDs for Pool BC:', positionIdBC);
        console.log('Position IDs for Pool CA:', positionIdCA);

        if (positionIdAB === ethers.constants.AddressZero || positionIdBC === ethers.constants.AddressZero || positionIdCA === ethers.constants.AddressZero) {
            throw new Error("One or more pools have no associated positions.");
        }

        const path1 = isReversedAB ? [tokenB, tokenA, tokenC] : [tokenA, tokenB, tokenC];
        const path2 = isReversedBC ? [tokenC, tokenB, tokenA] : [tokenB, tokenC, tokenA];
        const path3 = isReversedCA ? [tokenA, tokenC, tokenB] : [tokenC, tokenA, tokenB];
        
        const poolData = {
            poolAddressAB: poolIdAB,
            poolAddressBC: poolIdBC,
            poolAddressCA: poolIdCA,
            positionIdAB: positionIdAB,
            positionIdBC: positionIdBC,
            positionIdCA: positionIdCA,
            borrowAmount1: 0,
            borrowAmount2: 0,
            borrowAmount3: 0,
            profit1: 0,
            profit2: 0,
            profit3: 0,
        };

        const borrowAmounts = await calculateOptimalBorrowAmounts(liquidityAB, liquidityBC, liquidityCA);
       //const data = await flashArbitrageContract.getReservesAndData(poolData.poolAddressCA, poolData.positionIdCA);
        console.log('Path 1:', path1);
        console.log('Path 2:', path2);
        console.log('Path 3:', path3);
/*
        // Step 1: Get gas estimates from Alchemy SDK
        let gasEstimation;
        try {
            gasEstimation = await provider.getGasPrice();
            console.log("FeeData:", gasEstimation);

        } catch (error) {
            console.error("Error fetching fee data:", error);
        }
        
       

        const maxPriorityFeePerGas = ethers.utils.parseUnits("2.5", "gwei");
        const maxFeePerGas = gasEstimation.add(maxPriorityFeePerGas); //|| ethers.utils.parseUnits("30", "gwei");
        

        const transactionData = await flashArbitrageContract.populateTransaction.executeFlashArbitrage(
            path1, path2, path3, borrowAmounts, poolData
        );

        // Step 2: Define transaction parameters and send
        const tx = {
            ...transactionData,
            //maxFeePerGas,
            //maxPriorityFeePerGas,
            gasPrice: ethers.utils.parseUnits("25", "gwei"),
            gasLimit: ethers.BigNumber.from("1000000"),
        };

        let sentTx;
        try {
            sentTx = await wallet.sendTransaction(tx);
            console.log("Flash arbitrage executed successfully with tx:", sentTx.hash);

            // Wait for transaction confirmation
            let receipt = await sentTx.wait();
            console.log("Transaction confirmed in block:", receipt.blockNumber);
        } catch (error) {
            console.error("Error sending tx:", error);
        }*/


        // Execute flash arbitrage with fee and gas overrides
        await flashArbitrageContract.executeFlashArbitrage(
            path1, path2, path3, borrowAmounts, poolData,
            {
                //maxFeePerGas: maxFeePerGas,
                //maxPriorityFeePerGas: maxPriorityFeePerGas,
                gasPrice: ethers.utils.parseUnits("50", "gwei"),
                gasLimit: 17000000
            }
        );
        
        console.log("Flash arbitrage executed successfully.");

        // Optional withdraw call
        // await flashArbitrageContract.withdraw({ gasLimit: 2000000 });
        // console.log("poolData", poolData);

    } catch (error) {
        console.error("Error executing flash arbitrage:", error);
    }
}

// Run the main function
executeFlashArbitrage();
