
const { BigNumber, ethers } = require("ethers");
const { AlphaRouter } = require("@uniswap/smart-order-router");
const axios = require("axios");
const FlashArbitrageVn = require("../artifacts/contracts/Fvn.sol/FlashArbitrageVn.json");
const UniswapFactory = require("../artifacts/@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json");
const { GraphQLClient, gql } = require("graphql-request");
const AggregatorV3InterfaceABI = require("@chainlink/contracts/abi/v0.8/AggregatorV3Interface.json");

const graphClient = new GraphQLClient("https://gateway.thegraph.com/api/505cbefd36ed83f93bb586fbd80cb308/subgraphs/id/HMcqgvDY6f4MpnRSJqUUsBPHePj8Hq3AxiDBfDUrWs15");

const provider = new ethers.providers.JsonRpcProvider({
    url: "https://polygon-mainnet.g.alchemy.com/v2/DcqRhPPSW0upcwmCtR8oa3Pb2clizqgG",
    timeout: 500000,
});

const wallet = new ethers.Wallet("", provider);

const flashArbitrageAddress = "0x1C0e1960f3dBF98d123A02768eC128B466157978"; // Replace after deployment
const factoryAddress = "0x1F98431c8aD98523631AE4a59f267346ea31F984";

const chainlinkFeeds = {
    "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6": "0xc907E116054Ad103354f2D350FD2514433D57F6f", // WBTC/USD
    "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270": "0xaB594600376Ec9fD91F8e885dAdF0Ce036810De0", // WMATIC/USD
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174": "0x0FCAa9c899EC5A91eBc3D5Dd869De833b06fB046", // USDC/USD
    "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619": "0xF9680D99D6C9589e2a93a78A04A279e509205945", // WETH/USD
};

const coingeckoIds = {
    "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6": "wrapped-bitcoin",
    "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270": "matic-network",
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174": "usd-coin",
    "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619": "weth",
};

async function initializeContracts() {
    console.log("Initializing contracts...");
    const flashArbitrageContract = new ethers.Contract(flashArbitrageAddress, FlashArbitrageVn.abi, wallet);
    const factoryContract = new ethers.Contract(factoryAddress, UniswapFactory.abi, wallet);
    console.log("Contracts initialized: FlashArbitrageVn at", flashArbitrageAddress, "Factory at", factoryAddress);
    return { flashArbitrageContract, factoryContract };
}

const GET_POSITIONS = gql`
    query GetPositions($poolId: String!) {
        positions(where: { pool: $poolId }) {
            id
            owner
            liquidity
            token0 { id }
            token1 { id }
        }
    }
`;

async function getPoolAddress(tokenA, tokenB) {
    const { factoryContract } = await initializeContracts();
    const feeTiers = [500, 3000, 10000];
    let bestPoolAddress = null;
    let highestLiquidity = BigNumber.from(0);

    for (const fee of feeTiers) {
        console.log(`Fetching pool address for pair ${tokenA}-${tokenB} with fee ${fee}`);
        const poolAddress = await factoryContract.getPool(tokenA, tokenB, fee);
        if (poolAddress === ethers.constants.AddressZero) {
            console.warn(`No pool found for pair ${tokenA}-${tokenB} with fee ${fee}`);
            continue;
        }

        const { liquidity } = await getPositionWithHighestProfit(poolAddress, tokenA, tokenB);
        if (liquidity.gt(highestLiquidity)) {
            highestLiquidity = liquidity;
            bestPoolAddress = poolAddress;
        }
        console.log(`Pool found: ${poolAddress} for pair ${tokenA}-${tokenB} with fee ${fee}, liquidity=${liquidity}`);
    }

    if (!bestPoolAddress) {
        console.warn(`No valid pool found for pair ${tokenA}-${tokenB} across fee tiers`);
        return null;
    }
    console.log(`Selected pool: ${bestPoolAddress} for pair ${tokenA}-${tokenB} with highest liquidity=${highestLiquidity}`);
    return bestPoolAddress;
}

async function getPoolTokens(poolAddress) {
    if (!poolAddress) return { token0: null, token1: null };
    const poolContract = new ethers.Contract(poolAddress, [
        "function token0() view returns (address)",
        "function token1() view returns (address)"
    ], provider);
    const token0 = await poolContract.token0();
    const token1 = await poolContract.token1();
    return { token0, token1 };
}

async function getPositionWithHighestProfit(poolId, expectedToken0, expectedToken1) {
    if (!poolId) return { positionId: 0, isReversed: false, liquidity: BigNumber.from(0) };
    console.log(`Fetching positions for pool ${poolId} with tokens ${expectedToken0}-${expectedToken1}`);
    const variables = { poolId: poolId.toLowerCase() };
    try {
        const response = await graphClient.request(GET_POSITIONS, variables);
        const positions = response.positions || [];

        if (positions.length === 0) {
            console.warn(`No positions found for pool ${poolId}`);
            return { positionId: 0, isReversed: false, liquidity: BigNumber.from(0) };
        }

        let validPositions = positions.filter(
            position =>
                position.liquidity > 0 &&
                position.token0.id.toLowerCase() === expectedToken0.toLowerCase() &&
                position.token1.id.toLowerCase() === expectedToken1.toLowerCase()
        );

        if (validPositions.length === 0) {
            validPositions = positions.filter(
                position =>
                    position.liquidity > 0 &&
                    position.token0.id.toLowerCase() === expectedToken1.toLowerCase() &&
                    position.token1.id.toLowerCase() === expectedToken0.toLowerCase()
            );
        }

        if (validPositions.length === 0) {
            console.warn(`No valid positions with liquidity for pool ${poolId}`);
            return { positionId: 0, isReversed: false, liquidity: BigNumber.from(0) };
        }

        let bestPosition = null;
        let highestProfit = BigNumber.from(0);
        let isReversed = false;
        let bestLiquidity = BigNumber.from(0);

        for (const position of validPositions) {
            const positionId = parseInt(position.id);
            const liquidity = BigNumber.from(position.liquidity);
            const isPositionReversed = position.token0.id.toLowerCase() === expectedToken1.toLowerCase();
            const path = isPositionReversed ? [expectedToken1, expectedToken0] : [expectedToken0, expectedToken1];
            const amountIn = liquidity.div(10); // Test with 10% of liquidity
            const amountOut = await getAmountOutWithQuoterV2MultiHop(amountIn, path);
            const profit = amountOut.sub(amountIn); // Simple profit estimate

            if (profit.gt(highestProfit)) {
                highestProfit = profit;
                bestPosition = position;
                isReversed = isPositionReversed;
                bestLiquidity = liquidity;
            }
        }

        if (!bestPosition) {
            console.warn(`No profitable position found for pool ${poolId}`);
            return { positionId: 0, isReversed: false, liquidity: BigNumber.from(0) };
        }

        console.log(`Highest profit position for pool ${poolId}: ID=${bestPosition.id}, Profit=${ethers.utils.formatEther(highestProfit)}, Reversed=${isReversed}`);
        return {
            positionId: parseInt(bestPosition.id),
            isReversed,
            liquidity: bestLiquidity
        };
    } catch (error) {
        console.error(`Error fetching positions for pool ${poolId}:`, error);
        return { positionId: 0, isReversed: false, liquidity: BigNumber.from(0) };
    }
}

async function getAmountOutWithQuoterV2MultiHop(amountIn, path) {
    const { flashArbitrageContract } = await initializeContracts();
    try {
        const amountOut = await flashArbitrageContract.callStatic.getAmountOutWithQuoterV2MultiHop(amountIn.toString(), path);
        return BigNumber.from(amountOut);
    } catch (error) {
        console.error(`Quoter error for path ${path.join(" -> ")}:`, error);
        return BigNumber.from(0);
    }
}

async function calculateOptimalBorrowAmounts(liquidities) {
    const MAX_BORROW_FRACTION = BigNumber.from("500000000000000000"); // 50%
    return liquidities.map(liquidity =>
        liquidity.mul(MAX_BORROW_FRACTION).div(BigNumber.from("1000000000000000000")).toString()
    );
}

async function getDynamicGasFees() {
    try {
        const feeData = await provider.getFeeData();
        const minPriorityFee = ethers.utils.parseUnits("25", "gwei");
        const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas.gt(minPriorityFee)
            ? feeData.maxPriorityFeePerGas
            : minPriorityFee;
        const baseFee = feeData.lastBaseFeePerGas || ethers.utils.parseUnits("30", "gwei");
        const maxFeePerGas = baseFee.mul(2).add(maxPriorityFeePerGas);
        console.log(`Gas fees: maxFeePerGas=${ethers.utils.formatUnits(maxFeePerGas, "gwei")} gwei, maxPriorityFeePerGas=${ethers.utils.formatUnits(maxPriorityFeePerGas, "gwei")} gwei`);
        return { maxFeePerGas, maxPriorityFeePerGas };
    } catch (error) {
        console.error("Error fetching gas fees, using fallback:", error);
        return {
            maxFeePerGas: ethers.utils.parseUnits("60", "gwei"),
            maxPriorityFeePerGas: ethers.utils.parseUnits("25", "gwei")
        };
    }
}

async function getTokenPriceFromCoinGecko(tokenAddress, retries = 3) {
    const coingeckoId = coingeckoIds[tokenAddress];
    if (!coingeckoId) {
        console.error(`No CoinGecko ID configured for token ${tokenAddress}`);
        return null;
    }
    console.log(`Fetching CoinGecko price for token ${tokenAddress} (ID: ${coingeckoId})`);
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt - 1)));
            const response = await axios.get(
                `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`
            );
            const price = response.data[coingeckoId]?.usd;
            if (!price || price <= 0) {
                console.error(`Invalid CoinGecko price for ${tokenAddress}: price=${price}`);
                return null;
            }
            const priceBN = ethers.utils.parseUnits(price.toFixed(8), 8);
            console.log(`CoinGecko price for ${tokenAddress}: ${price} USD`);
            return priceBN;
        } catch (error) {
            console.error(`CoinGecko fetch attempt ${attempt} failed for ${tokenAddress}:`, error.message);
            if (attempt === retries) {
                console.error(`All ${retries} CoinGecko retries failed for ${tokenAddress}`);
                return null;
            }
        }
    }
}

async function getTokenPriceFromChainlink(tokenAddress) {
    const feedAddress = chainlinkFeeds[tokenAddress];
    if (!feedAddress) {
        console.error(`No Chainlink feed configured for token ${tokenAddress}`);
        return null;
    }
    console.log(`Fetching Chainlink price for token ${tokenAddress} from feed ${feedAddress}`);
    const chainlinkContract = new ethers.Contract(feedAddress, AggregatorV3InterfaceABI, provider);
    try {
        const { roundId, answer, startedAt, updatedAt, answeredInRound } = await chainlinkContract.latestRoundData();
        console.log(`Raw Chainlink response for ${tokenAddress}: roundId=${roundId}, answer=${answer}, startedAt=${startedAt}, updatedAt=${updatedAt}, answeredInRound=${answeredInRound}`);
        
        if (!answer || answer.lte(0)) {
            console.error(`Invalid Chainlink price for ${tokenAddress}: answer=${answer}`);
            throw new Error(`Invalid Chainlink price`);
        }
        if (Date.now() / 1000 - updatedAt > 3600) {
            console.error(`Stale Chainlink price for ${tokenAddress}: updatedAt=${new Date(updatedAt * 1000).toISOString()}`);
            throw new Error(`Stale Chainlink price`);
        }

        const price = BigNumber.from(answer);
        console.log(`Price for token ${tokenAddress}: ${ethers.utils.formatUnits(price, 8)} USD, Timestamp: ${new Date(updatedAt * 1000).toISOString()}`);
        return price;
    } catch (error) {
        console.warn(`Chainlink price fetch failed for ${tokenAddress} from feed ${feedAddress}:`, error.message);
        console.log(`Falling back to CoinGecko for ${tokenAddress}`);
        return await getTokenPriceFromCoinGecko(tokenAddress);
    }
}

async function constructPaths(tokens) {
    console.log("Constructing arbitrage paths for tokens:", tokens);
    const paths = [];

    for (let len = 3; len <= Math.min(6, tokens.length); len++) {
        const generateCombinations = (arr, size, startToken, current = [], depth = 0) => {
            if (depth === size - 1) {
                if (arr[0] === startToken) {
                    const path = [...current, startToken];
                    console.log(`Generated path: ${path.join(" -> ")}`);
                    paths.push(path);
                }
                return;
            }

            for (let i = 0; i < arr.length; i++) {
                const nextToken = arr[i];
                if (depth === 0) {
                    generateCombinations(arr.slice(1), size, nextToken, [nextToken], 1);
                } else if (nextToken !== current[current.length - 1]) {
                    const remaining = arr.slice(0, i).concat(arr.slice(i + 1));
                    generateCombinations(remaining, size, startToken, [...current, nextToken], depth + 1);
                }
            }
        };

        generateCombinations(tokens, len, null);
    }

    console.log(`Generated ${paths.length} cyclic paths`);
    if (paths.length === 0) {
        console.warn("No cyclic paths generated. Possible issues: insufficient tokens, invalid token addresses, or logic error.");
    }
    return paths;
}

async function evaluatePathProfit(path, poolData, borrowAmounts, gasFees) {
    let amountIn = BigNumber.from(borrowAmounts[0]);
    let amountOut = amountIn;
    const gasCost = gasFees.maxFeePerGas.mul(3000000);

    console.log(`Evaluating profit for path: ${path.join(" -> ")}`);

    for (let i = 0; i < path.length - 1; i++) {
        const tokenIn = path[i];
        const tokenOut = path[i + 1];
        const poolAddress = poolData.poolAddresses[i];
        const { token0, token1 } = await getPoolTokens(poolAddress);
        const isZeroForOne = tokenIn.toLowerCase() === token0.toLowerCase();

        const price = await getTokenPriceFromChainlink(tokenOut);
        if (!price || price.lte(0)) {
            console.error(`Invalid price for ${tokenOut} in path ${path.join(" -> ")}: price=${price}`);
            console.warn(`Skipping path ${path.join(" -> ")} due to invalid price`);
            return null;
        }

        const priceBN = BigNumber.from(price);
        try {
            const amountOutTemp = isZeroForOne
                ? amountIn.mul(priceBN).div(BigNumber.from(10).pow(18))
                : amountIn.mul(BigNumber.from(10).pow(18)).div(priceBN);
            amountOut = amountOutTemp.mul(997).div(1000);
            amountIn = amountOut;
            console.log(`Swap ${tokenIn} -> ${tokenOut} in pool ${poolAddress}: Amount In=${ethers.utils.formatEther(amountIn)}, Amount Out=${ethers.utils.formatEther(amountOut)}`);
        } catch (error) {
            console.error(`Swap calculation failed for ${tokenIn} -> ${tokenOut} in path ${path.join(" -> ")}:`, error.message);
            console.warn(`Skipping path ${path.join(" -> ")} due to calculation error`);
            return null;
        }
    }

    const profit = amountOut.sub(borrowAmounts[0]).sub(gasCost);
    console.log(`Calculated profit for path ${path.join(" -> ")}: ${ethers.utils.formatEther(profit)} (Gas cost: ${ethers.utils.formatEther(gasCost)})`);
    return profit.gt(0) ? profit : BigNumber.from(0);
}

async function executeFlashArbitrage() {
    try {
        const { flashArbitrageContract } = await initializeContracts();

        const tokens = [
            "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", // WBTC
            "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WMATIC
            "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC
            "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WETH
        ];

        console.log("Starting arbitrage execution with tokens:", tokens);
        if (tokens.length < 2) {
            console.error("Insufficient tokens for cyclic paths. At least 2 tokens required.");
            return;
        }

        const allPaths = await constructPaths(tokens);
        if (allPaths.length === 0) {
            console.log("No cyclic paths generated. Check token list or path construction logic.");
            return;
        }

        let bestPath = null;
        let bestProfit = BigNumber.from(0);
        let bestPoolData = null;
        let bestBorrowAmounts = null;

        for (const path of allPaths) {
            console.log(`Processing path: ${path.join(" -> ")}`);
            const poolData = {
                poolAddresses: [],
                positionIds: [],
                borrowAmounts: [],
                profits: []
            };
            const liquidities = [];

            for (let i = 0; i < path.length - 1; i++) {
                const tokenA = path[i];
                const tokenB = path[i + 1];
                const poolAddress = await getPoolAddress(tokenA, tokenB);
                if (!poolAddress) {
                    console.warn(`Skipping path ${path.join(" -> ")} due to missing pool for ${tokenA}-${tokenB}`);
                    break;
                }

                const { positionId, liquidity } = await getPositionWithHighestProfit(poolAddress, tokenA, tokenB);
                if (liquidity.eq(0)) {
                    console.warn(`Skipping path ${path.join(" -> ")} due to zero liquidity for pool ${poolAddress}`);
                    break;
                }

                poolData.poolAddresses.push(poolAddress);
                poolData.positionIds.push(positionId);
                poolData.borrowAmounts.push("0");
                poolData.profits.push("0");
                liquidities.push(liquidity);
            }

            if (poolData.poolAddresses.length !== path.length - 1) {
                console.log(`Path ${path.join(" -> ")} incomplete: Only ${poolData.poolAddresses.length} of ${path.length - 1} pools found`);
                continue;
            }

            const borrowAmounts = await calculateOptimalBorrowAmounts(liquidities);
            poolData.borrowAmounts = borrowAmounts;

            const gasFees = await getDynamicGasFees();
            const profit = await evaluatePathProfit(path, poolData, borrowAmounts, gasFees);

            if (profit === null) {
                console.log(`Path ${path.join(" -> ")} skipped due to invalid price data or calculation error`);
                continue;
            }

            console.log(`Path ${path.join(" -> ")} profit: ${ethers.utils.formatEther(profit)}`);
            if (profit.gt(bestProfit)) {
                bestProfit = profit;
                bestPath = path;
                bestPoolData = poolData;
                bestBorrowAmounts = borrowAmounts;
                console.log(`New best path found: ${path.join(" -> ")} with profit ${ethers.utils.formatEther(bestProfit)}`);
            }
        }

        if (!bestPath || bestProfit.eq(0)) {
            console.log("No profitable path found. Evaluated paths:", allPaths.length);
            return;
        }

        console.log("Best Path:", bestPath);
        console.log("Expected Profit:", ethers.utils.formatEther(bestProfit));
        console.log("Pool Data:", bestPoolData);
        console.log("Borrow Amounts:", bestBorrowAmounts);

        const { maxFeePerGas, maxPriorityFeePerGas } = await getDynamicGasFees();
        console.log("Executing flash arbitrage with gas fees:", {
            maxFeePerGas: ethers.utils.formatUnits(maxFeePerGas, "gwei"),
            maxPriorityFeePerGas: ethers.utils.formatUnits(maxPriorityFeePerGas, "gwei")
        });
        const tx = await flashArbitrageContract.executeFlashArbitrage(
            bestPath,
            bestBorrowAmounts,
            bestPoolData,
            {
                maxFeePerGas,
                maxPriorityFeePerGas,
                gasLimit: ethers.BigNumber.from("21000000")
            }
        );
        console.log("Flash arbitrage executed successfully. Tx hash:", tx.hash);

        const receipt = await tx.wait();
        console.log("Transaction confirmed in block:", receipt.blockNumber);
        console.log("Gas used:", receipt.gasUsed.toString());

        receipt.logs.forEach((log, index) => {
            try {
                const parsedLog = flashArbitrageContract.interface.parseLog(log);
                console.log(`Log ${index}:`, parsedLog);
            } catch (e) {
                console.log(`Log ${index} (unparsed):`, log);
            }
        });
    } catch (error) {
        console.error("Error executing flash arbitrage:", error);
    }
}

executeFlashArbitrage();
