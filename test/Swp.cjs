const { ethers, BigNumber } = require("ethers");
const FlashArbitrageV3 = require("../artifacts/contracts/Fv3.sol/FlashArbitrageV3.json");
const UniswapFactory = require("../artifacts/@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json");
const { GraphQLClient, gql } = require("graphql-request");
const { parseUnits , formatUnits} = require("ethers/lib/utils");

// Set up GraphQL client for Uniswap V3 subgraph
const graphClient = new GraphQLClient("https://gateway.thegraph.com/api/a3b0cf80798ffdc9fa07f665b44aa809/subgraphs/id/3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm");

// Set up provider and wallet
const provider = new ethers.providers.JsonRpcProvider({
    url: "https://polygon-mainnet.g.alchemy.com/v2/DcqRhPPSW0upcwmCtR8oa3Pb2clizqgG",
    timeout: 500000,
});

const wallet = new ethers.Wallet("0xc1101453fdd090e6cf6f3bc2f56564dd8e7c277e76c711ada47e45721fd9ab51", provider); // Replace with your private key

// Contract addresses
const flashArbitrageAddress = "0x87800e822cB3573B62EB0B7b673F75dA3361acAc";
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

        return { positionId: highestLiquidityPosition.id, isReversed: isReversed };
    }

    console.log(`No positions with liquidity found for pool ${poolId}`);
    return { positionId: ethers.constants.AddressZero, isReversed: false };
}

// Fetch ordered reserves from the contract
// Remove token reversal check from getOrderedReserves and pass correct token order directly
async function getOrderedReserves(tokenIn, tokenOut, poolData) {
    try {
        const { flashArbitrageContract } = await initializeContracts();

        // Fetch reserves using the provided pool addresses and position IDs
        const [reserveA1, reserveB1] = await flashArbitrageContract.getReserves(poolData.poolAddressAB, poolData.positionIdAB);
        const [reserveB2, reserveC2] = await flashArbitrageContract.getReserves(poolData.poolAddressBC, poolData.positionIdBC);
        const [reserveC3, reserveA3] = await flashArbitrageContract.getReserves(poolData.poolAddressCA, poolData.positionIdCA);

        // Since token order is already handled during position selection, we can just return reserves
        return [reserveA1, reserveB2, reserveC3];
    } catch (error) {
        console.error("Error fetching ordered reserves:", error);
        return [0, 0, 0];
    }
}
  
function calculateProfit(reserveA, reserveB, reserveC, gasFee, borrowAmount) {
    // Convert to BigNumber to handle large integers
    reserveA = BigNumber.from(reserveA);
    reserveB = BigNumber.from(reserveB);
    reserveC = BigNumber.from(reserveC);
    gasFee = BigNumber.from(gasFee);
    borrowAmount = BigNumber.from(borrowAmount);
    
    // Step 1: Calculate amount of Token B received after swap from Token A
    const amountInTokenB = borrowAmount.mul(reserveB).div(reserveA.add(borrowAmount));
    
    // Step 2: Calculate amount of Token C received after swap from Token B
    const amountInTokenC = amountInTokenB.mul(reserveC).div(reserveB.add(amountInTokenB));
    
    // Step 3: Calculate amount of Token A received after swap from Token C
    const amountOutTokenA = amountInTokenC.mul(reserveA).div(reserveC.add(amountInTokenC));

    // Step 4: Calculate profit as the difference between the final amount of Token A and the initial borrow amount, minus gas fees
    let profit = BigNumber.from(amountOutTokenA.sub(borrowAmount));
    if (amountOutTokenA.gt(borrowAmount)) {
        profit = amountOutTokenA.sub(borrowAmount).sub(gasFee);
       
    }

    // Ensure non-negative profit
    return profit;
}
// Calculate the optimal borrow amount from reserves
function calculateBorrowAmount(reserveA, reserveB, reserveC, safetyFactor) {
    // Convert reserves to BigNumber if not already
    const bigReserveA = ethers.BigNumber.from(reserveA);
    const bigReserveB = ethers.BigNumber.from(reserveB);
    const bigReserveC = ethers.BigNumber.from(reserveC);
    // Use the smaller of the three reserves and apply a safety factor to determine the borrow amount
    const minReserve = bigReserveA.lt(bigReserveB) 
    ? (bigReserveA.lt(bigReserveC) ? bigReserveA : bigReserveC) 
    : (bigReserveB.lt(bigReserveC) ? bigReserveB : bigReserveC);

  
    // Multiply by safety factor (expressed as a BigNumber with proper precision)
    const borrowAmount = minReserve.mul(ethers.utils.parseUnits(safetyFactor.toString(), 18)).div(ethers.utils.parseUnits("1", 18));
    
    // Check if borrowAmount is zero or undefined to avoid invalid BigNumber conversion
    if (borrowAmount.isZero() || borrowAmount === undefined) {
      throw new Error("Calculated borrow amount is zero or invalid.");
    }
  
    return borrowAmount;
}
function findOptimalSafetyFactor(reserveA, reserveB, reserveC, gasFee) {
    let safetyFactor = 0.001; 
    
    safetyFactor = ethers.utils.parseUnits(safetyFactor.toString(), 18);// Start with a high safety factor
    let profit = BigNumber.from(0);

    while (safetyFactor > 0) {
     try {
            const borrowAmount = calculateBorrowAmount(reserveA, reserveB, reserveC, safetyFactor);
            profit = calculateProfit(reserveA, reserveB, reserveC, gasFee, borrowAmount);
            console.log(`Reserve A1 (raw): ${formatUnits(profit, 18)}`);
            if (profit.gt(0)) {
                break;
            }
        } catch (error) {
            console.error(`Error with safety factor ${safetyFactor}: ${error.message}`);
        }
        safetyFactor -= 0.0001; // Decrease safety factor
    }

    if (safetyFactor <= 0) {
        throw new Error("Unable to find a profitable safety factor.");
    }

    return safetyFactor;
}
/*
function calculateBorrowAmount(reserveA, reserveB, reserveC, gasFee, safetyFactor = 0.01) {
    // Convert to BigNumber to handle large integers
    const bigReserveA = ethers.BigNumber.from(reserveA);
    const bigReserveB = ethers.BigNumber.from(reserveB);
    const bigReserveC = ethers.BigNumber.from(reserveC);
    const bigGasFee = ethers.BigNumber.from(gasFee);

    // Use the smaller of the three reserves and apply a safety factor to determine the initial borrow amount
    const minReserve = bigReserveA.lt(bigReserveB) 
        ? (bigReserveA.lt(bigReserveC) ? bigReserveA : bigReserveC) 
        : (bigReserveB.lt(bigReserveC) ? bigReserveB : bigReserveC);

    let borrowAmount = minReserve.mul(ethers.utils.parseUnits(safetyFactor.toString(), 18)).div(ethers.utils.parseUnits("1", 18));

    // Calculate the profit for the given borrow amount
    let profit = calculateProfit(bigReserveA, bigReserveB, bigReserveC, bigGasFee, borrowAmount);

    // Adjust borrow amount to maximize profit
    while (profit.gt(0)) {
        borrowAmount = borrowAmount.add(ethers.utils.parseUnits("1", 18)); // Increment borrow amount
        profit = calculateProfit(bigReserveA, bigReserveB, bigReserveC, bigGasFee, borrowAmount);
    }

    // Return the last profitable borrow amount
    return borrowAmount.sub(ethers.utils.parseUnits("1", 18));
}

function calculateProfit(reserveA, reserveB, reserveC, gasFee, borrowAmount) {
    reserveA = BigNumber.from(reserveA);
    reserveB = BigNumber.from(reserveB);
    reserveC = BigNumber.from(reserveC);
    gasFee = BigNumber.from(gasFee);
    borrowAmount = BigNumber.from(borrowAmount);
    
    // Step 1: Calculate amount of Token B received after swap from Token A
    const amountInTokenB = borrowAmount.mul(reserveB).div(reserveA.add(borrowAmount));
    
    // Step 2: Calculate amount of Token C received after swap from Token B
    const amountInTokenC = amountInTokenB.mul(reserveC).div(reserveB.add(amountInTokenB));
    
    // Step 3: Calculate amount of Token A received after swap from Token C
    const amountOutTokenA = amountInTokenC.mul(reserveA).div(reserveC.add(amountInTokenC));

    // Step 4: Calculate profit as the difference between the final amount of Token A and the initial borrow amount, minus gas fees
    let profit = amountOutTokenA.sub(borrowAmount).sub(gasFee);

    // Ensure non-negative profit
    if (profit.lt(0)) {
        profit = ethers.BigNumber.from(0);
    }

    return profit;
}
*/
// Choose the best path for arbitrage
async function chooseBestPath(path1, path2, path3, poolData) {
  try {
        const { flashArbitrageContract } = await initializeContracts();
        
        // Retrieve ordered reserves for each path
        const [reserveA1, reserveB1, reserveC1] = await getOrderedReserves(path1[0], path1[1], poolData);
        const [reserveA2, reserveB2, reserveC2] = await getOrderedReserves(path2[0], path2[1], poolData);
        const [reserveA3, reserveB3, reserveC3] = await getOrderedReserves(path3[0], path3[1], poolData);

        console.log(`Reserve A1 (raw): ${formatUnits(reserveA1, 18)}`);
        console.log(`Reserve B1 (raw): ${formatUnits(reserveB1, 18)}`);
        console.log(`Reserve C1 (raw): ${formatUnits(reserveC1, 18)}`);
        console.log(`Reserve A2 (raw): ${formatUnits(reserveA2, 18)}`);
        console.log(`Reserve B2 (raw): ${formatUnits(reserveB2, 18)}`);
        console.log(`Reserve C2 (raw): ${formatUnits(reserveC2, 18)}`);
        console.log(`Reserve A3 (raw): ${formatUnits(reserveA3, 18)}`);
        console.log(`Reserve B3 (raw): ${formatUnits(reserveB3, 18)}`);
        console.log(`Reserve C3 (raw): ${formatUnits(reserveC3, 18)}`);

        const gasFee = await estimateGasFee();
        // Calculate borrow amounts dynamically based on reserves
       
        const optimalSafetyFactor1 = findOptimalSafetyFactor(reserveA1, reserveB1, reserveC1, gasFee);
        const borrowAmount1 = calculateBorrowAmount(reserveA1, reserveB1, reserveC1, optimalSafetyFactor1);
        const optimalSafetyFactor2 = findOptimalSafetyFactor(reserveA2, reserveB2, reserveC2, gasFee);
        const borrowAmount2 = calculateBorrowAmount(reserveA2, reserveB2, reserveC2, optimalSafetyFactor2);
        const optimalSafetyFactor3 = findOptimalSafetyFactor(reserveA3, reserveB3, reserveC3, gasFee);
        const borrowAmount3 = calculateBorrowAmount(reserveA3, reserveB3, reserveC3, optimalSafetyFactor3);

        console.log(`borrow for Path 1: ${formatUnits(borrowAmount1, 18)}`);
        console.log(`borrow for Path 2: ${formatUnits(borrowAmount2, 18)}`);
        console.log(`borrow for Path 3: ${formatUnits(borrowAmount3, 18)}`);
 
       
        // Recalculate profits dynamically considering gas and path fees
         // Implement gas fee estimation logic
        const profit1 = await calculateProfit(reserveA1, reserveB1, reserveC1, gasFee, borrowAmount1);
        const profit2 = await calculateProfit(reserveA2, reserveB2, reserveC2, gasFee, borrowAmount2);
        const profit3 = await calculateProfit(reserveA3, reserveB3, reserveC3, gasFee, borrowAmount3);
            // Log profits for debugging
         // Log profits for debugging
         console.log(`Profit for Path 1: ${formatUnits(profit1, 18)}`);
         console.log(`Profit for Path 2: ${formatUnits(profit2, 18)}`);
         console.log(`Profit for Path 3: ${formatUnits(profit3, 18)}`);
 

        // Choose the most profitable path
        let bestPath, bestProfit, bestBorrowAmount;
        if (profit1 >= profit2 && profit1 >= profit3) {
            bestPath = path1;
            bestProfit = profit1;
            bestBorrowAmount = borrowAmount1;
        } else if (profit2 >= profit1 && profit2 >= profit3) {
            bestPath = path2;
            bestProfit = profit2;
            bestBorrowAmount = borrowAmount2;
        } else {
            bestPath = path3;
            bestProfit = profit3;
            bestBorrowAmount = borrowAmount3;
        }

        // Return the best path and profit
        return { bestPath, bestProfit, bestBorrowAmount};
    } catch (error) {
        console.error("Error choosing best path:", error);
        return { bestPath: null, bestProfit: null, bestBorrowAmount: ethers.constants.Zero };
    }
}
// Fetch profits from contract logic
// Estimate gas fees
async function estimateGasFee() {
    const gasPrice = await provider.getGasPrice();
    const gasUsed = 21000; // Placeholder value, adjust based on complexity
    return gasPrice.mul(gasUsed);
  }
async function executeFlashArbitrage() {
    try {
        const { flashArbitrageContract } = await initializeContracts();

        // Define token pairs
        const tokenA = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"; // WMATIC
        const tokenB = "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"; // USDT0xb33eaad8d922b1083446dc23f610c2567fb5180f
        const tokenC = "0xb33eaad8d922b1083446dc23f610c2567fb5180f"; // WETH

        // Fetch pool addresses
        const poolIdAB = await getPoolAddress(tokenA, tokenB, 3000);
        const poolIdBC = await getPoolAddress(tokenB, tokenC, 3000);
        const poolIdCA = await getPoolAddress(tokenC, tokenA, 3000);

        // Log pool IDs
        console.log('Pool ID AB:', poolIdAB);
        console.log('Pool ID BC:', poolIdBC);
        console.log('Pool ID CA:', poolIdCA);

        // Fetch position IDs
        const { positionId: positionIdAB, isReversed: isReversedAB } = await getPositionWithHighestLiquidity(poolIdAB, tokenA, tokenB);
        const { positionId: positionIdBC, isReversed: isReversedBC } = await getPositionWithHighestLiquidity(poolIdBC, tokenB, tokenC);
        const { positionId: positionIdCA, isReversed: isReversedCA } = await getPositionWithHighestLiquidity(poolIdCA, tokenC, tokenA);

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
            borrowAmount: ethers.utils.parseEther("0"),
            profit1: 0,
            profit2: 0,
            profit3: 0,
        };

        //const path1 = [tokenA, tokenB, tokenC];
        //const path2 = [tokenB, tokenC, tokenA];
        //const path3 = [tokenC, tokenA, tokenB];
        const { bestPath, bestProfit, bestBorrowAmount } = await chooseBestPath(path1, path2, path3, poolData);
        poolData.borrowAmount = bestBorrowAmount; // Update the poolData with the best borrow amount

        console.log("Best Path:", bestPath);
        //console.log(`Best Profit: ${formatUnits(bestProfit.toString(), 10)}`);
        //console.log(`Borrow Amount: ${formatUnits(bestBorrowAmount.toString(), 18)}`);

        if (bestPath) {
            // Update poolData with best profit values
            //const gasLimit = await flashArbitrageContract.estimateGas.executeFlashArbitrage(path1, path2, path3, poolData);
            poolData.profit1 = (bestPath === path1) ? bestProfit : poolData.profit1;
            poolData.profit2 = (bestPath === path2) ? bestProfit : poolData.profit2;
            poolData.profit3 = (bestPath === path3) ? bestProfit : poolData.profit3;
            // Log all pool data before executing flash arbitrage
            console.log("Prepared Pool Data:", poolData);
            
            // Execute swap with the chosen path
            await flashArbitrageContract.executeFlashArbitrage(path1, path2, path3, poolData, { gasLimit: 200000 });
            console.log("Flash arbitrage executed successfully.");
        } else {
        console.log("No profitable path found.");
        }
    } catch (error) {
        console.error("Error executing flash arbitrage:", error);
    }
}

// Run the main function
executeFlashArbitrage();
