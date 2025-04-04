const { BigNumber, ethers } = require("ethers");
const FlashArbitrageVn = require("../artifacts/contracts/Fvn.sol/FlashArbitrageVn.json");
const UniswapFactory = require("../artifacts/@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol/IUniswapV3Factory.json");
const { GraphQLClient, gql } = require("graphql-request");

const graphClient = new GraphQLClient("https://gateway.thegraph.com/api/505cbefd36ed83f93bb586fbd80cb308/subgraphs/id/HMcqgvDY6f4MpnRSJqUUsBPHePj8Hq3AxiDBfDUrWs15");

const provider = new ethers.providers.JsonRpcProvider({
    url: "https://polygon-mainnet.g.alchemy.com/v2/DcqRhPPSW0upcwmCtR8oa3Pb2clizqgG",
    timeout: 500000,
});

const wallet = new ethers.Wallet("0xc1101453fdd090e6cf6f3bc2f56564dd8e7c277e76c711ada47e45721fd9ab51", provider);

const flashArbitrageAddress = "0x27C87B628580683F5C3FEf965b7160AC0D5af63e";
const factoryAddress = "0x1F98431c8aD98523631AE4a59f267346ea31F984";

async function initializeContracts() {
    const flashArbitrageContract = new ethers.Contract(flashArbitrageAddress, FlashArbitrageVn.abi, wallet);
    const factoryContract = new ethers.Contract(factoryAddress, UniswapFactory.abi, wallet);
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

        const highestLiquidityPosition = validPositions.sort((a, b) => parseInt(b.liquidity) - parseInt(a.liquidity))[0];
        const isReversed = highestLiquidityPosition.token0.id.toLowerCase() === expectedToken1.toLowerCase();
        return { positionId: highestLiquidityPosition.id, isReversed, liquidity: BigNumber.from(highestLiquidityPosition.liquidity) };
    }

    return { positionId: ethers.constants.AddressZero, isReversed: false, liquidity: BigNumber.from(0) };
}

async function calculateOptimalBorrowAmounts(liquidities) {
    const MAX_BORROW_FRACTION = BigNumber.from("900000000000000000"); // 90%
    return liquidities.map(liquidity =>
        liquidity.mul(MAX_BORROW_FRACTION).div(BigNumber.from("1000000000000000000")).toString()
    );
}

async function executeFlashArbitrage() {
    try {
        const { flashArbitrageContract } = await initializeContracts();

        const tokens = [
            "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WMATIC
            "0xb33eaad8d922b1083446dc23f610c2567fb5180f", // USDT
            "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WETH
            "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"  // USDC
        ];

        const poolData = {
            poolAddresses: [],
            positionIds: [],
            borrowAmounts: [],
            profits: []
        };
        const paths = [];
        const liquidities = [];

        for (let i = 0; i < tokens.length; i++) {
            const tokenA = tokens[i];
            const tokenB = tokens[(i + 1) % tokens.length];
            const poolAddress = await getPoolAddress(tokenA, tokenB, 3000);
            const { positionId, isReversed, liquidity } = await getPositionWithHighestLiquidity(poolAddress, tokenA, tokenB);

            poolData.poolAddresses.push(poolAddress);
            poolData.positionIds.push(positionId);
            poolData.borrowAmounts.push("0");
            poolData.profits.push("0");
            liquidities.push(liquidity);

            const path = Array(tokens.length).fill(null).map((_, j) => tokens[(i + j) % tokens.length]);
            paths.push(isReversed ? path.reverse() : path);
        }

        const borrowAmounts = await calculateOptimalBorrowAmounts(liquidities);
        console.log("Paths:", paths);
        console.log("Borrow Amounts:", borrowAmounts);

        const tx = await flashArbitrageContract.executeFlashArbitrage(
            paths,
            borrowAmounts,
            poolData,
            {
                gasPrice: ethers.utils.parseUnits("50", "gwei"),
                gasLimit: 17000000
            }
        );
        console.log("Flash arbitrage executed successfully. Tx hash:", tx.hash);

        const receipt = await tx.wait();
        console.log("Transaction confirmed in block:", receipt.blockNumber);

    } catch (error) {
        console.error("Error executing flash arbitrage:", error);
    }
}

executeFlashArbitrage();