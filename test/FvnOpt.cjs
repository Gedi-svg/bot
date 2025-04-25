const { BigNumber, ethers } = require("ethers");
const { GraphQLClient, gql } = require("graphql-request");
const { AlphaRouter, SwapType } = require("@uniswap/smart-order-router");
const { Token, CurrencyAmount, TradeType, Percent } = require("@uniswap/sdk-core");
const FlashArbitrageVn = require("../artifacts/contracts/FvnOpt.sol/FlashArbitrageVn0.json");
const UniswapFactory = require("../artifacts/@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json");
const AggregatorV3InterfaceABI = require("@chainlink/contracts/abi/v0.8/AggregatorV3Interface.json");

const graphClient = new GraphQLClient("https://gateway.thegraph.com/api/505cbefd36ed83f93bb586fbd80cb308/subgraphs/id/HMcqgvDY6f4MpnRSJqUUsBPHePj8Hq3AxiDBfDUrWs15");

const provider = new ethers.providers.JsonRpcProvider({
    url: "https://polygon-mainnet.g.alchemy.com/v2/DcqRhPPSW0upcwmCtR8oa3Pb2clizqgG",
    timeout: 500000,
});
const wallet = new ethers.Wallet("", provider);

const flashArbitrageAddress = "0x0074e4a57DC1D4C5E63f952Ef6d715F41A4C1A90";
const factoryAddress = "0x1F98431c8aD98523631AE4a59f267346ea31F984";


const chainlinkFeeds = {
    "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6": "0xc907E116054Ad103354f2D350FD2514433D57F6f", // WBTC/USD
    "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270": "0xaB594600376Ec9fD91F8e885dAdF0Ce036810De0", // WMATIC/USD
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174": "0x0FCAa9c899EC5A91eBc3D5Dd869De833b06fB046", // USDC/USD
    "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619": "0xF9680D99D6C9589e2a93a78A04A279e509205945", // WETH/USD
    "0x7fc66500c84a76Ad7e9c93437bFc5Ac33E2DDaE9": "0x547a514d5e3769680Ce22B2361c10Ea13619e8a9", // AAVE/USD
    "0x6B175474E89094C44Da98b954EedeAC495271d0F": "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9", // DAI/USD
    "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39": "0x72484B12719E23115761D5DA1646945632979b7C", // LINK/USD
    "0xc2132D05D31c914a87C6611C10748AEb04B58e8F": "0x231d0Aa83b287373B92F4858F659B34bA1d48C48", // USDT/USD
    "0xf3b0073E3a7F747C7A38B36B805247B222C302A3": "0x553303d460EE0afB37EdFf9bE42922D8FF63220e", // UNI/USD
    "0x0b3F868E0BE5597D5e4B3E49B165975D1F5D71d7": "0x49B0c6950398d60FDaD0DF7F058b0627A623571B"  // SUSHI/USD
};

const tokenDetails = {
    "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6": { decimals: 8, symbol: "WBTC" },
    "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270": { decimals: 18, symbol: "WMATIC" },
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174": { decimals: 6, symbol: "USDC" },
    "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619": { decimals: 18, symbol: "WETH" },
    "0x7fc66500c84a76Ad7e9c93437bFc5Ac33E2DDaE9": { decimals: 18, symbol: "AAVE" },
    "0x6B175474E89094C44Da98b954EedeAC495271d0F": { decimals: 18, symbol: "DAI" },
    "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39": { decimals: 18, symbol: "LINK" },
    "0xc2132D05D31c914a87C6611C10748AEb04B58e8F": { decimals: 6, symbol: "USDT" },
    "0xf3b0073E3a7F747C7A38B36B805247B222C302A3": { decimals: 18, symbol: "UNI" },
    "0x0b3F868E0BE5597D5e4B3E49B165975D1F5D71d7": { decimals: 18, symbol: "SUSHI" }
};

const MAX_PATH_LENGTH = 10; // Configurable maximum path length
const MIN_PRICE_DIFF = 0.005; // Minimum price difference for edge inclusion

// Utility function for timestamped logging
function logWithTimestamp(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    switch (level.toLowerCase()) {
        case 'error':
            console.error(formattedMessage, data);
            break;
        case 'warn':
            console.warn(formattedMessage, data);
            break;
        default:
            console.log(formattedMessage, data);
    }
}

async function initializeContracts() {
    logWithTimestamp('info', 'Initializing contracts...');
    const flashArbitrageContract = new ethers.Contract(flashArbitrageAddress, FlashArbitrageVn.abi, wallet);
    const factoryContract = new ethers.Contract(factoryAddress, UniswapFactory.abi, wallet);
    const router = new AlphaRouter({ chainId: 137, provider, swapType: SwapType.SWAP_ROUTER_02 });
    logWithTimestamp('info', 'Contracts initialized', { flashArbitrage: flashArbitrageAddress, factory: factoryAddress });
    return { flashArbitrageContract, factoryContract, router };
}

const GET_POSITIONS = gql`
    query GetPositions($poolId: String!) {
        positions(where: { pool: $poolId, liquidity_gt: "1000" }) {
            id
            liquidity
            token0 { id }
            token1 { id }
            tickLower
            tickUpper
        }
    }
`;

async function getPoolInfo(poolAddress) {
    logWithTimestamp('info', 'Fetching pool info', { poolAddress });
    const poolContract = new ethers.Contract(poolAddress, [
        "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
        "function tickSpacing() view returns (int24)"
    ], provider);
    try {
        const [slot0, tickSpacing] = await Promise.all([poolContract.slot0(), poolContract.tickSpacing()]);
        logWithTimestamp('info', 'Pool info fetched', { poolAddress, currentTick: slot0.tick, tickSpacing });
        return { currentTick: slot0.tick, tickSpacing };
    } catch (error) {
        logWithTimestamp('error', 'Failed to fetch pool info', { poolAddress, error: error.message });
        throw error;
    }
}

async function getInitializedTicks(poolAddress, tickSpacing, currentTick) {
    logWithTimestamp('info', 'Fetching initialized ticks', { poolAddress, tickSpacing, currentTick });
    const poolContract = new ethers.Contract(poolAddress, [
        "function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthGlobal0X128, uint256 feeGrowthGlobal1X128, uint128 tickCumulative, uint160 secondsPerLiquidityCumulativeX128, uint32 secondsOutside, bool initialized)"
    ], provider);
    
    const tickRange = 1000;
    const ticks = [];
    for (let tick = Math.floor((currentTick - tickRange) / tickSpacing) * tickSpacing; 
         tick <= Math.ceil((currentTick + tickRange) / tickSpacing) * tickSpacing; 
         tick += tickSpacing) {
        try {
            const { initialized, liquidityGross } = await poolContract.ticks(tick);
            if (initialized && liquidityGross > 0) {
                ticks.push(tick);
                logWithTimestamp('info', 'Found initialized tick', { poolAddress, tick, liquidityGross });
            }
        } catch (error) {
            logWithTimestamp('warn', 'Failed to fetch tick', { poolAddress, tick, error: error.message });
        }
    }
    logWithTimestamp('info', 'Initialized ticks fetched', { poolAddress, tickCount: ticks.length });
    return ticks.sort((a, b) => a - b);
}

async function calculatePriceDifference(poolAddress, token0, token1, tickLower, tickUpper) {
    logWithTimestamp('info', 'Calculating price difference', { poolAddress, token0, token1, tickLower, tickUpper });
    try {
        const sqrtPriceLower = Math.sqrt(1.0001 ** tickLower) * 2**96;
        const sqrtPriceUpper = Math.sqrt(1.0001 ** tickUpper) * 2**96;
        const priceLower = token0 < token1 ? 1 / (sqrtPriceLower ** 2 / 2**192) : sqrtPriceLower ** 2 / 2**192;
        const priceUpper = token0 < token1 ? 1 / (sqrtPriceUpper ** 2 / 2**192) : sqrtPriceUpper ** 2 / 2**192;
        const priceDiff = Math.abs(priceUpper - priceLower) / Math.min(priceLower, priceUpper);
        logWithTimestamp('info', 'Price difference calculated', { poolAddress, priceDiff, priceLower, priceUpper });
        return priceDiff;
    } catch (error) {
        logWithTimestamp('error', 'Failed to calculate price difference', { poolAddress, error: error.message });
        throw error;
    }
}

async function getPoolAddress(tokenA, tokenB, factoryContract) {
    logWithTimestamp('info', 'Fetching pool address', { tokenA, tokenB });
    const feeTiers = [500, 3000, 10000];
    let bestPoolAddress = null;
    let highestLiquidity = BigNumber.from(0);
    let selectedFee = 0;

    for (const fee of feeTiers) {
        try {
            const poolAddress = await factoryContract.getPool(tokenA, tokenB, fee);
            if (poolAddress === ethers.constants.AddressZero) {
                logWithTimestamp('warn', 'No pool found for fee tier', { tokenA, tokenB, fee });
                continue;
            }

            const { liquidity } = await getOptimalPosition(poolAddress, tokenA, tokenB);
            logWithTimestamp('info', 'Pool liquidity checked', { poolAddress, fee, liquidity: liquidity.toString() });
            if (liquidity.gt(highestLiquidity)) {
                highestLiquidity = liquidity;
                bestPoolAddress = poolAddress;
                selectedFee = fee;
            }
        } catch (error) {
            logWithTimestamp('warn', 'Failed to fetch pool for fee tier', { tokenA, tokenB, fee, error: error.message });
        }
    }

    if (!bestPoolAddress) {
        logWithTimestamp('warn', 'No valid pool found', { tokenA, tokenB });
        return { poolAddress: null, fee: 0 };
    }
    logWithTimestamp('info', 'Best pool selected', { tokenA, tokenB, poolAddress: bestPoolAddress, fee: selectedFee, liquidity: highestLiquidity.toString() });
    return { poolAddress: bestPoolAddress, fee: selectedFee };
}

async function getOptimalPosition(poolId, expectedToken0, expectedToken1)  {
    logWithTimestamp('info', 'Fetching optimal position', { poolId, expectedToken0, expectedToken1 });
    const variables = { poolId: poolId.toLowerCase() };
    try {
        const response = await graphClient.request(GET_POSITIONS, variables);
        const positions = response.positions || [];
        if (positions.length === 0) {
            logWithTimestamp('warn', 'No positions found', { poolId });
            return { positionId: 0, isReversed: false, liquidity: BigNumber.from(0), tickDifference: 0 };
        }

        const { currentTick, tickSpacing } = await getPoolInfo(poolId);
        const initializedTicks = await getInitializedTicks(poolId, tickSpacing, currentTick);
        if (initializedTicks.length < 2) {
            logWithTimestamp('warn', 'Insufficient initialized ticks', { poolId, tickCount: initializedTicks.length });
            return { positionId: 0, isReversed: false, liquidity: BigNumber.from(0), tickDifference: 0 };
        }

        const validPositions = positions.filter(pos => {
            const tickLower = parseInt(pos.tickLower);
            const tickUpper = parseInt(pos.tickUpper);
            const isValid = BigNumber.from(pos.liquidity).gt(0) &&
                           initializedTicks.includes(tickLower) &&
                           initializedTicks.includes(tickUpper) &&
                           currentTick >= tickLower &&
                           currentTick <= tickUpper &&
                           pos.token0.id.toLowerCase() === expectedToken0.toLowerCase() &&
                           pos.token1.id.toLowerCase() === expectedToken1.toLowerCase();
            if (isValid) {
                logWithTimestamp('info', 'Valid position found', { poolId, positionId: pos.id, liquidity: pos.liquidity, tickLower, tickUpper });
            }
            return isValid;
        });

        if (validPositions.length === 0) {
            logWithTimestamp('warn', 'No valid positions found', { poolId });
            return { positionId: 0, isReversed: false, liquidity: BigNumber.from(0), tickDifference: 0 };
        }

        const optimalPosition = validPositions.reduce((prev, curr) => {
            const prevDiff = parseInt(prev.tickUpper) - parseInt(prev.tickLower);
            const currDiff = parseInt(curr.tickUpper) - parseInt(curr.tickLower);
            return currDiff < prevDiff ? curr : prev;
        });

        const isReversed = optimalPosition.token0.id.toLowerCase() === expectedToken1.toLowerCase();
        const tickDifference = parseInt(optimalPosition.tickUpper) - parseInt(optimalPosition.tickLower);
        logWithTimestamp('info', 'Optimal position selected', { 
            poolId, 
            positionId: optimalPosition.id, 
            liquidity: optimalPosition.liquidity, 
            tickDifference, 
            isReversed 
        });
        return { 
            positionId: parseInt(optimalPosition.id), 
            isReversed, 
            liquidity: BigNumber.from(optimalPosition.liquidity), 
            tickDifference 
        };
    } catch (error) {
        logWithTimestamp('error', 'Failed to fetch positions', { poolId, error: error.message });
        return { positionId: 0, isReversed: false, liquidity: BigNumber.from(0), tickDifference: 0 };
    }
}

async function calculateOptimalBorrowAmounts(liquidities, tokenInAddress) {
    logWithTimestamp('info', 'Calculating optimal borrow amounts', { tokenInAddress, liquidityCount: liquidities.length });
    const MAX_BORROW_FRACTION = BigNumber.from("900000000000000000"); // 90%
    const tokenDecimals = tokenDetails[tokenInAddress]?.decimals || 18;
    const minBorrow = ethers.utils.parseUnits("5", tokenDecimals);
    const borrowAmounts = liquidities.map(liquidity => {
        const amount =  BigNumber.from(liquidity)
            .mul(MAX_BORROW_FRACTION)
            .div(BigNumber.from("1000000000000000000"))
            .div(BigNumber.from(10).pow(18 - tokenDecimals))
            .div(10)
            .add(minBorrow)
            .toString();
        logWithTimestamp('info', 'Borrow amount calculated', { tokenInAddress, liquidity, amount });
        return amount;
    });
    logWithTimestamp('info', 'Borrow amounts calculated', { tokenInAddress, borrowAmounts });
    return borrowAmounts;
}

async function getDynamicGasFees() {
    logWithTimestamp('info', 'Fetching dynamic gas fees');
    try {
        const feeData = await provider.getFeeData();
        const minPriorityFee = ethers.utils.parseUnits("25", "gwei");
        const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas?.gt(minPriorityFee) ? feeData.maxPriorityFeePerGas : minPriorityFee;
        const baseFee = feeData.lastBaseFeePerGas || ethers.utils.parseUnits("30", "gwei");
        const maxFeePerGas = baseFee.mul(2).add(maxPriorityFeePerGas);
        logWithTimestamp('info', 'Gas fees fetched', { 
            maxFeePerGas: ethers.utils.formatUnits(maxFeePerGas, "gwei"), 
            maxPriorityFeePerGas: ethers.utils.formatUnits(maxPriorityFeePerGas, "gwei") 
        });
        return { maxFeePerGas, maxPriorityFeePerGas };
    } catch (error) {
        logWithTimestamp('error', 'Failed to fetch gas fees, using fallback', { error: error.message });
        const fallbackFees = {
            maxFeePerGas: ethers.utils.parseUnits("60", "gwei"),
            maxPriorityFeePerGas: ethers.utils.parseUnits("25", "gwei")
        };
        logWithTimestamp('info', 'Using fallback gas fees', fallbackFees);
        return fallbackFees;
    }
}

async function getTokenPriceFromChainlink(tokenAddress) {
    const feedAddress = chainlinkFeeds[tokenAddress];
    if (!feedAddress) {
        logWithTimestamp('warn', 'No Chainlink feed configured', { tokenAddress });
        return null;
    }
    logWithTimestamp('info', 'Fetching Chainlink price', { tokenAddress, feedAddress });
    const chainlinkContract = new ethers.Contract(feedAddress, AggregatorV3InterfaceABI, provider);
    try {
        const { answer, updatedAt } = await chainlinkContract.latestRoundData();
        if (answer.lte(0)) {
            logWithTimestamp('error', 'Invalid Chainlink price', { tokenAddress, answer: answer.toString() });
            return null;
        }
        if (Date.now() / 1000 - updatedAt > 3600) {
            logWithTimestamp('error', 'Stale Chainlink price', { tokenAddress, updatedAt: new Date(updatedAt * 1000).toISOString() });
            return null;
        }
        logWithTimestamp('info', 'Chainlink price fetched', { 
            tokenAddress, 
            price: ethers.utils.formatUnits(answer, 8), 
            updatedAt: new Date(updatedAt * 1000).toISOString() 
        });
        return BigNumber.from(answer);
    } catch (error) {
        logWithTimestamp('error', 'Chainlink price fetch failed', { tokenAddress, feedAddress, error: error.message });
        return null;
    }
}

async function constructPaths(tokens, factoryContract) {
    logWithTimestamp('info', `Constructing paths for ${tokens.length} tokens with max length ${MAX_PATH_LENGTH}`);
    const graph = [];
    const MIN_PRICE_DIFF_RELAXED = 0.002; // Reduced from 0.005 to include more edges

    // Build graph with edges based on price differences
    for (let i = 0; i < tokens.length; i++) {
        for (let j = i + 1; j < tokens.length; j++) {
            const tokenA = tokens[i];
            const tokenB = tokens[j];
            logWithTimestamp('info', 'Processing token pair', { tokenA, tokenB });
            const { poolAddress } = await getPoolAddress(tokenA, tokenB, factoryContract);
            if (!poolAddress) {
                logWithTimestamp('warn', 'No pool found for pair', { tokenA, tokenB });
                continue;
            }

            const { currentTick, tickSpacing } = await getPoolInfo(poolAddress);
            const initializedTicks = await getInitializedTicks(poolAddress, tickSpacing, currentTick);
            if (initializedTicks.length < 2) {
                logWithTimestamp('warn', 'Insufficient initialized ticks for pair', { tokenA, tokenB, tickCount: initializedTicks.length });
                continue;
            }

            const priceDiff = await calculatePriceDifference(
                poolAddress,
                tokenA < tokenB ? tokenA : tokenB,
                tokenA < tokenB ? tokenB : tokenA,
                initializedTicks[0],
                initializedTicks[initializedTicks.length - 1]
            );

            if (priceDiff > MIN_PRICE_DIFF_RELAXED) {
                const weight = -Math.log(1 + priceDiff);
                graph.push([tokenA, tokenB, weight], [tokenB, tokenA, weight]);
                logWithTimestamp('info', 'Edge added to graph', { 
                    from: tokenA, 
                    to: tokenB, 
                    priceDiff, 
                    weight, 
                    poolAddress 
                });
            } else {
                logWithTimestamp('info', 'Edge skipped due to low price difference', { tokenA, tokenB, priceDiff });
            }
        }
    }
    logWithTimestamp('info', 'Graph constructed', { edgeCount: graph.length, tokens: tokens.length });

    // Bellman-Ford for negative cycle detection
    function bellmanFord(tokens, startToken) {
        logWithTimestamp('info', 'Running Bellman-Ford', { startToken });
        const distances = {};
        const predecessors = {};
        const paths = [];

        tokens.forEach(token => {
            distances[token] = Infinity;
            predecessors[token] = null;
        });
        distances[startToken] = 0;

        // Relax edges for |V| iterations (to ensure negative cycles are reachable)
        for (let i = 0; i < tokens.length; i++) {
            logWithTimestamp('info', `Relaxation iteration ${i + 1}`, { startToken });
            let updated = false;
            for (const [from, to, weight] of graph) {
                if (distances[from] !== Infinity && distances[from] + weight < distances[to]) {
                    distances[to] = distances[from] + weight;
                    predecessors[to] = from;
                    updated = true;
                    logWithTimestamp('info', 'Distance updated', { 
                        from, 
                        to, 
                        newDistance: distances[to].toFixed(6), 
                        weight: weight.toFixed(6) 
                    });
                }
            }
            if (!updated) {
                logWithTimestamp('info', 'No updates in iteration, breaking', { iteration: i + 1 });
                break;
            }
        }

        // Second pass to detect negative cycles
        logWithTimestamp('info', 'Checking for negative cycles', { startToken });
        const negativeCycleEdges = [];
        for (const [from, to, weight] of graph) {
            if (distances[from] !== Infinity && distances[from] + weight < distances[to]) {
                logWithTimestamp('info', 'Negative cycle edge found', { from, to, weight: weight.toFixed(6) });
                negativeCycleEdges.push([from, to]);
            }
        }

        // Trace cycles from negative cycle edges
        for (const [from, to] of negativeCycleEdges) {
            logWithTimestamp('info', 'Tracing cycle from edge', { from, to });
            let curr = to;
            const path = [];
            const visited = new Set();
            let steps = 0;

            // Build path until a cycle is found or limit is reached
            while (!visited.has(curr) && steps < tokens.length * 2) {
                visited.add(curr);
                path.push(curr);
                curr = predecessors[curr];
                if (!curr) {
                    logWithTimestamp('warn', 'No predecessor found, breaking cycle trace', { curr: path[path.length - 1] });
                    break;
                }
                steps++;
                logWithTimestamp('info', 'Tracing cycle', { curr, step: steps });
            }

            if (curr && visited.has(curr)) {
                const cycleStartIdx = path.indexOf(curr);
                const cycle = path.slice(cycleStartIdx).reverse();
                // Ensure cycle is valid: at least 3 tokens, within max length, and cyclic
                const uniqueTokens = new Set(cycle);
                if (cycle.length >= 3 && 
                    cycle.length <= MAX_PATH_LENGTH && 
                    cycle[0] === cycle[cycle.length - 1] && 
                    uniqueTokens.size === cycle.length - 1) {
                    paths.push(cycle);
                    logWithTimestamp('info', 'Valid cycle found', { 
                        cycle: cycle.join(' -> '), 
                        length: cycle.length, 
                        uniqueTokens: uniqueTokens.size 
                    });
                } else {
                    logWithTimestamp('warn', 'Invalid cycle', { 
                        cycle: cycle.join(' -> '), 
                        length: cycle.length, 
                        isCyclic: cycle[0] === cycle[cycle.length - 1], 
                        uniqueTokens: uniqueTokens.size 
                    });
                }
            } else {
                logWithTimestamp('warn', 'No cycle found in trace', { path: path.join(' -> ') });
            }
        }

        logWithTimestamp('info', 'Bellman-Ford completed', { startToken, pathCount: paths.length });
        return paths;
    }

    // Generate paths for each starting token
    const paths = [];
    const seenPaths = new Set();
    for (const token of tokens) {
        logWithTimestamp('info', 'Generating paths for starting token', { token });
        const tokenPaths = bellmanFord(tokens, token);
        for (const path of tokenPaths) {
            const pathStr = JSON.stringify(path);
            if (!seenPaths.has(pathStr)) {
                seenPaths.add(pathStr);
                paths.push(path);
                logWithTimestamp('info', 'Unique path added', { path: path.join(' -> ') });
            } else {
                logWithTimestamp('info', 'Duplicate path skipped', { path: path.join(' -> ') });
            }
        }
    }

    logWithTimestamp('info', 'Path construction completed', { totalPaths: paths.length });
    return paths;
}

async function evaluatePathProfit(path, poolData, borrowAmounts, gasFees, router, factoryContract) {
    logWithTimestamp('info', 'Evaluating path profit', { path: path.join(' -> ') });
    const gasCost = gasFees.maxFeePerGas.mul(3000000 + (path.length - 2) * 500000);
    let amountIn = BigNumber.from(borrowAmounts[0]);
    const tokenInDecimals = tokenDetails[path[0]]?.decimals || 18;
    logWithTimestamp('info', 'Initial setup', { 
        amountIn: ethers.utils.formatUnits(amountIn, tokenInDecimals), 
        gasCost: ethers.utils.formatEther(gasCost), 
        tokenSymbol: tokenDetails[path[0]]?.symbol 
    });

    try {
        let amountOut = amountIn;
        for (let i = 0; i < path.length - 1; i++) {
            const tokenInAddress = path[i];
            const tokenOutAddress = path[i + 1];
            const tokenIn = new Token(137, tokenInAddress, tokenDetails[tokenInAddress].decimals, tokenDetails[tokenInAddress].symbol);
            const tokenOut = new Token(137, tokenOutAddress, tokenDetails[tokenOutAddress].decimals, tokenDetails[tokenOutAddress].symbol);
            logWithTimestamp('info', 'Processing swap', { 
                from: tokenInAddress, 
                to: tokenOutAddress, 
                amountIn: ethers.utils.formatUnits(amountIn, tokenIn.decimals) 
            });

            const { poolAddress } = await getPoolAddress(tokenInAddress, tokenOutAddress, factoryContract);
            if (!poolAddress) {
                logWithTimestamp('warn', 'No pool found for swap', { tokenInAddress, tokenOutAddress });
                return null;
            }

            const amountInCurrency = CurrencyAmount.fromRawAmount(tokenIn, amountIn.toString());
            let route = null;
            try {
                route = await router.route(
                    amountInCurrency,
                    tokenOut,
                    TradeType.EXACT_INPUT,
                    {
                        type: SwapType.SWAP_ROUTER_02,
                        recipient: flashArbitrageAddress,
                        slippageTolerance: new Percent(1, 100),
                        deadline: Math.floor(Date.now() / 1000) + 60
                    }
                );
                logWithTimestamp('info', 'Route fetched', { 
                    tokenInAddress, 
                    tokenOutAddress, 
                    quote: route?.quote?.toExact() 
                });
            } catch (err) {
                logWithTimestamp('warn', 'Routing failed', { tokenInAddress, tokenOutAddress, error: err.message });
                return null;
            }

            if (!route?.quote) {
                logWithTimestamp('warn', 'No route or quote found', { tokenInAddress, tokenOutAddress });
                return null;
            }
            amountOut = ethers.utils.parseUnits(route.quote.toExact(), tokenOut.decimals)
                .mul(997).div(1000).mul(99).div(100);
            logWithTimestamp('info', 'Swap calculated', { 
                tokenInAddress, 
                tokenOutAddress, 
                amountOut: ethers.utils.formatUnits(amountOut, tokenOut.decimals) 
            });
            amountIn = amountOut;
        }

        const profit = amountOut.sub(borrowAmounts[0]).sub(gasCost);
        const minProfitThreshold = ethers.utils.parseUnits("0.01", tokenInDecimals);
        if (profit.lte(minProfitThreshold)) {
            logWithTimestamp('info', 'Path skipped due to low profit', { 
                path: path.join(' -> '), 
                profit: ethers.utils.formatUnits(profit, tokenInDecimals), 
                threshold: ethers.utils.formatUnits(minProfitThreshold, tokenInDecimals) 
            });
            return null;
        }

        logWithTimestamp('info', 'Profit calculated', { 
            path: path.join(' -> '), 
            profit: ethers.utils.formatUnits(profit, tokenInDecimals), 
            tokenSymbol: tokenDetails[path[0]]?.symbol 
        });
        return { profit, decimals: tokenInDecimals };
    } catch (error) {
        logWithTimestamp('error', 'Profit calculation failed', { path: path.join(' -> '), error: error.message });
        return null;
    }
}

async function calculateDebtAmount(path, expectedProfit, router, factoryContract, decimals) {
    logWithTimestamp('info', 'Calculating debt amount', { path: path.join(' -> '), expectedProfit: expectedProfit.toString() });
    try {
        let amountOut = BigNumber.from(expectedProfit.toString());
        for (let i = path.length - 2; i >= 0; i--) {
            const tokenInAddress = path[i];
            const tokenOutAddress = path[i + 1];
            const tokenIn = new Token(137, tokenInAddress, tokenDetails[tokenInAddress].decimals, tokenDetails[tokenInAddress].symbol);
            const tokenOut = new Token(137, tokenOutAddress, tokenDetails[tokenOutAddress].decimals, tokenDetails[tokenOutAddress].symbol);
            logWithTimestamp('info', 'Processing reverse swap', { 
                from: tokenOutAddress, 
                to: tokenInAddress, 
                amountOut: ethers.utils.formatUnits(amountOut, tokenOut.decimals) 
            });

            const { poolAddress } = await getPoolAddress(tokenInAddress, tokenOutAddress, factoryContract);
            if (!poolAddress) {
                logWithTimestamp('warn', 'No pool found for reverse swap', { tokenInAddress, tokenOutAddress });
                return BigNumber.from(0);
            }

            const amountOutCurrency = CurrencyAmount.fromRawAmount(tokenOut, amountOut.toString());
            let route = null;
            try {
                route = await router.route(
                    amountOutCurrency,
                    tokenIn,
                    TradeType.EXACT_OUTPUT,
                    {
                        type: SwapType.SWAP_ROUTER_02,
                        recipient: flashArbitrageAddress,
                        slippageTolerance: new Percent(1, 100),
                        deadline: Math.floor(Date.now() / 1000) + 60
                    }
                );
                logWithTimestamp('info', 'Reverse route fetched', { 
                    tokenInAddress, 
                    tokenOutAddress, 
                    quote: route?.quote?.toExact() 
                });
            } catch (err) {
                logWithTimestamp('warn', 'Reverse routing failed', { tokenInAddress, tokenOutAddress, error: err.message });
                return BigNumber.from(0);
            }

            if (!route?.quote) {
                logWithTimestamp('warn', 'No route or quote found for reverse swap', { tokenInAddress, tokenOutAddress });
                return BigNumber.from(0);
            }
            amountOut = ethers.utils.parseUnits(route.quote.toExact(), tokenIn.decimals)
                .mul(1000).div(997).mul(101).div(100);
            logWithTimestamp('info', 'Reverse swap calculated', { 
                tokenInAddress, 
                tokenOutAddress, 
                amountIn: ethers.utils.formatUnits(amountOut, tokenIn.decimals) 
            });
        }

        const debtAmount = amountOut.mul(101).div(100);
        const minDebtThreshold = ethers.utils.parseUnits("0.01", decimals);
        if (debtAmount.lte(minDebtThreshold)) {
            logWithTimestamp('info', 'Path skipped due to low debt amount', { 
                path: path.join(' -> '), 
                debtAmount: ethers.utils.formatUnits(debtAmount, decimals), 
                threshold: ethers.utils.formatUnits(minDebtThreshold, decimals) 
            });
            return BigNumber.from(0);
        }

        logWithTimestamp('info', 'Debt amount calculated', { 
            path: path.join(' -> '), 
            debtAmount: ethers.utils.formatUnits(debtAmount, decimals), 
            tokenSymbol: tokenDetails[path[0]]?.symbol 
        });
        return debtAmount;
    } catch (error) {
        logWithTimestamp('error', 'Debt amount calculation failed', { path: path.join(' -> '), error: error.message });
        return BigNumber.from(0);
    }
}

async function executeFlashArbitrage() {
    logWithTimestamp('info', 'Starting flash arbitrage execution');
    try {
        const { flashArbitrageContract, factoryContract, router } = await initializeContracts();
        const tokens = Object.keys(tokenDetails);
        logWithTimestamp('info', 'Tokens loaded', { tokenCount: tokens.length, tokens });

        const allPaths = await constructPaths(tokens, factoryContract);
        if (allPaths.length === 0) {
            logWithTimestamp('warn', 'No profitable cyclic paths found');
            return;
        }
        logWithTimestamp('info', 'Paths generated', { pathCount: allPaths.length });

        let bestPath = null;
        let bestProfit = BigNumber.from(0);
        let bestPoolData = null;
        let bestBorrowAmounts = null;
        let bestDebtAmount = BigNumber.from(0);
        let bestProfitDecimals = 18;

        for (const path of allPaths) {
            if (path.length > MAX_PATH_LENGTH) {
                logWithTimestamp('warn', 'Path skipped due to excessive length', { path: path.join(' -> '), length: path.length });
                continue;
            }
            logWithTimestamp('info', 'Processing path', { path: path.join(' -> ') });

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
                logWithTimestamp('info', 'Fetching pool for path segment', { tokenA, tokenB });
                const { poolAddress } = await getPoolAddress(tokenA, tokenB, factoryContract);
                if (!poolAddress) {
                    logWithTimestamp('warn', 'Skipping path due to missing pool', { tokenA, tokenB });
                    break;
                }

                const { positionId, liquidity, tickDifference } = await getOptimalPosition(poolAddress, tokenA, tokenB);
                if (liquidity.eq(0)) {
                    logWithTimestamp('warn', 'Skipping path due to zero liquidity', { poolAddress });
                    break;
                }

                const MIN_LIQUIDITY_THRESHOLD = ethers.utils.parseUnits("0.005", tokenDetails[tokenA].decimals);
                if (liquidity.lt(MIN_LIQUIDITY_THRESHOLD)) {
                    logWithTimestamp('warn', 'Skipping path due to low liquidity', { 
                        poolAddress, 
                        liquidity: liquidity.toString(), 
                        threshold: MIN_LIQUIDITY_THRESHOLD.toString() 
                    });
                    break;
                }

                poolData.poolAddresses.push(poolAddress);
                poolData.positionIds.push(positionId);
                poolData.borrowAmounts.push("0");
                poolData.profits.push("0");
                liquidities.push(liquidity);
                logWithTimestamp('info', 'Pool data added', { 
                    poolAddress, 
                    positionId, 
                    liquidity: liquidity.toString(), 
                    tickDifference 
                });
            }

            if (poolData.poolAddresses.length !== path.length - 1) {
                logWithTimestamp('warn', 'Incomplete path', { 
                    path: path.join(' -> '), 
                    poolCount: poolData.poolAddresses.length, 
                    expected: path.length - 1 
                });
                continue;
            }

            const borrowAmounts = await calculateOptimalBorrowAmounts(liquidities, path[0]);
            poolData.borrowAmounts = borrowAmounts;
            logWithTimestamp('info', 'Borrow amounts set', { path: path.join(' -> '), borrowAmounts });

            const gasFees = await getDynamicGasFees();
            const profitResult = await evaluatePathProfit(path, poolData, borrowAmounts, gasFees, router, factoryContract);
            if (!profitResult) {
                logWithTimestamp('warn', 'Path skipped due to invalid profit', { path: path.join(' -> ') });
                continue;
            }

            const debtAmount = await calculateDebtAmount(path, profitResult.profit, router, factoryContract, profitResult.decimals);
            if (debtAmount.eq(0)) {
                logWithTimestamp('warn', 'Path skipped due to invalid debt amount', { path: path.join(' -> ') });
                continue;
            }

            poolData.profits = new Array(poolData.poolAddresses.length).fill(profitResult.profit.toString());
            logWithTimestamp('info', 'Profits set', { path: path.join(' -> '), profit: profitResult.profit.toString() });

            if (profitResult.profit.gt(bestProfit)) {
                bestProfit = profitResult.profit;
                bestPath = path;
                bestPoolData = poolData;
                bestBorrowAmounts = borrowAmounts;
                bestDebtAmount = debtAmount;
                bestProfitDecimals = profitResult.decimals;
                logWithTimestamp('info', 'New best path found', { 
                    path: path.join(' -> '), 
                    profit: ethers.utils.formatUnits(bestProfit, bestProfitDecimals), 
                    debtAmount: ethers.utils.formatUnits(bestDebtAmount, bestProfitDecimals) 
                });
            }
        }

        if (!bestPath || bestProfit.eq(0)) {
            logWithTimestamp('warn', 'No profitable path found', { evaluatedPaths: allPaths.length });
            return;
        }

        logWithTimestamp('info', 'Best path selected', { 
            path: bestPath.join(' -> '), 
            profit: ethers.utils.formatUnits(bestProfit, bestProfitDecimals), 
            debtAmount: ethers.utils.formatUnits(bestDebtAmount, bestProfitDecimals), 
            poolData: bestPoolData, 
            borrowAmounts: bestBorrowAmounts 
        });

        const { maxFeePerGas, maxPriorityFeePerGas } = await getDynamicGasFees();
        logWithTimestamp('info', 'Preparing transaction', { 
            maxFeePerGas: ethers.utils.formatUnits(maxFeePerGas, "gwei"), 
            maxPriorityFeePerGas: ethers.utils.formatUnits(maxPriorityFeePerGas, "gwei") 
        });
        const tx = await flashArbitrageContract.executeFlashArbitrage(
            bestPath,
            bestBorrowAmounts,
            bestPoolData,
            bestDebtAmount,
            {
                maxFeePerGas,
                maxPriorityFeePerGas,
                gasLimit: ethers.BigNumber.from("21000000")
            }
        );
        logWithTimestamp('info', 'Flash arbitrage transaction sent', { txHash: tx.hash });

        const receipt = await tx.wait();
        logWithTimestamp('info', 'Transaction confirmed', { 
            blockNumber: receipt.blockNumber, 
            gasUsed: receipt.gasUsed.toString() 
        });

        receipt.logs.forEach((log, index) => {
            try {
                const parsedLog = flashArbitrageContract.interface.parseLog(log);
                logWithTimestamp('info', `Transaction log ${index}`, { event: parsedLog.name, args: parsedLog.args });
            } catch (e) {
                logWithTimestamp('info', `Transaction log ${index} (unparsed)`, { log });
            }
        });
    } catch (error) {
        logWithTimestamp('error', 'Flash arbitrage execution failed', { error: error.message });
    }
}

executeFlashArbitrage();
