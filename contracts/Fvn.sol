// SPDX-License-Identifier: MIT
pragma solidity 0.7.6;
pragma abicoder v2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import '@uniswap/v3-core/contracts/libraries/LowGasSafeMath.sol';
import '@uniswap/v3-periphery/contracts/base/PeripheryPayments.sol';
import '@uniswap/v3-periphery/contracts/base/PeripheryImmutableState.sol';
import '@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol';
import '@uniswap/v3-periphery/contracts/libraries/CallbackValidation.sol';
import "@uniswap/v3-periphery/contracts/interfaces/IPeripheryImmutableState.sol";
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@uniswap/v3-periphery/contracts/libraries/TransferHelper.sol";
import "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3FlashCallback.sol";
import "@uniswap/v3-periphery/contracts/interfaces/IQuoterV2.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import "./Decimal.sol";
import "./SafeMathCopy.sol";

interface IWETH {
    function deposit() external payable;
    function transfer(address to, uint value) external returns (bool);
    function withdraw(uint) external;
}

struct PoolData {
    address[] poolAddresses; // Array of pool addresses for n tokens
    uint256[] positionIds;   // Array of position IDs for n pools
    uint256[] borrowAmounts; // Array of borrow amounts for n pools
    uint256[] profits;       // Array of profits for n pools
}

struct OrderedReserves {
    uint256[] reservesA;     // Reserves for token A in each pool
    uint256[] reservesB;     // Reserves for token B in each pool
    int24[] tickLowers;      // Lower ticks for each pool
    int24[] tickUppers;      // Upper ticks for each pool
    uint128[] liquidities;   // Liquidity for each pool
}

struct ArbitrageInfo {
    address[] baseTokens;    // Base tokens for each pool
    address[] quoteTokens;   // Quote tokens for each pool
    bool[] baseSmaller;      // Whether base token is smaller for each pool
    address[] sortedPools;   // Pools sorted by price
}

struct FlashCallbackData {
    uint256 amount0;
    uint256 amount1;
    address payer;
    PoolAddress.PoolKey poolKey;
    uint24 poolFee2;
    uint24 poolFee3;
    address[] path;
    address Flpool;
}

struct ReserveData {
    uint256 reserveA;
    uint256 reserveB;
    uint160 sqrtPriceX96;
    int24 tickLower;
    int24 tickUpper;
    uint128 liquidity;
}

struct ReserveDataBundle {
    uint256[2][] reserves;
    uint160[] sqrtPriceX96;
    int24[] tickLower;
    int24[] tickUpper;
    uint128[] liquidity;
    address[] poolAddresses;
}

contract FlashArbitrageVn is Ownable, IUniswapV3FlashCallback, PeripheryImmutableState, PeripheryPayments, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Decimal for Decimal.D256;
    using EnumerableSet for EnumerableSet.AddressSet;
    using LowGasSafeMath for uint256;
    using LowGasSafeMath for int256;

    address immutable WETH;
    ISwapRouter public immutable swapRouter;
    address immutable nonfungiblePositionManager;
    IQuoterV2 public quoterContract;
    address permissionedPairAddress = address(1);

    EnumerableSet.AddressSet baseTokens;

    event Withdrawn(address indexed to, uint256 indexed value);
    event BaseTokenAdded(address indexed token);
    event BaseTokenRemoved(address indexed token);
    event FlashArbitrageExecuted(uint256 amountIn, uint256 amountOut);

    constructor(address _WETH, address _factory, address _swapRouter, address _nonfungiblePositionManager, address _quoter)
    PeripheryImmutableState(_factory, _WETH) {
        WETH = _WETH;
        swapRouter = ISwapRouter(_swapRouter);
        nonfungiblePositionManager = _nonfungiblePositionManager;
        quoterContract = IQuoterV2(_quoter);
        EnumerableSet.add(baseTokens, _WETH);
    }

    receive() external payable override {}

    fallback(bytes calldata _input) external returns (bytes memory) {
        (uint256 fee0, uint256 fee1, bytes memory data) = abi.decode(_input[3:], (uint256, uint256, bytes));
        IUniswapV3FlashCallback(msg.sender).uniswapV3FlashCallback(fee0, fee1, data);
    }

    function withdraw() external onlyOwner {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            payable(owner()).transfer(balance);
            emit Withdrawn(owner(), balance);
        }

        for (uint256 i = 0; i < baseTokens.length(); i++) {
            address token = baseTokens.at(i);
            balance = IERC20(token).balanceOf(address(this));
            if (balance > 0) {
                IERC20(token).transfer(owner(), balance);
            }
        }
    }

    function estimateGasFee() internal view returns (uint256) {
        uint256 gasPrice = tx.gasprice;
        uint256 gasUsed = 21000; // Placeholder value
        return gasPrice * gasUsed;
    }

    function addBaseToken(address token) external onlyOwner {
        EnumerableSet.add(baseTokens, token);
        emit BaseTokenAdded(token);
    }

    function removeBaseToken(address token) external onlyOwner {
        EnumerableSet.remove(baseTokens, token);
        emit BaseTokenRemoved(token);
    }

    function getBaseTokens() external view returns (address[] memory tokens) {
        uint256 length = EnumerableSet.length(baseTokens);
        tokens = new address[](length);
        for (uint256 i = 0; i < length; i++) {
            tokens[i] = EnumerableSet.at(baseTokens, i);
        }
    }

    function baseTokensContains(address token) public view returns (bool) {
        return baseTokens.contains(token);
    }

    function isBaseTokenSmaller(PoolData memory poolData) internal view returns (ArbitrageInfo memory arbInfo) {
        require(poolData.poolAddresses.length > 1, "At least 2 pools required");
        arbInfo.baseTokens = new address[](poolData.poolAddresses.length);
        arbInfo.quoteTokens = new address[](poolData.poolAddresses.length);
        arbInfo.baseSmaller = new bool[](poolData.poolAddresses.length);
        arbInfo.sortedPools = new address[](poolData.poolAddresses.length);

        for (uint256 i = 0; i < poolData.poolAddresses.length; i++) {
            for (uint256 j = i + 1; j < poolData.poolAddresses.length; j++) {
                require(poolData.poolAddresses[i] != poolData.poolAddresses[j], "Duplicate pool address");
            }
        }

        for (uint256 i = 0; i < poolData.poolAddresses.length; i++) {
            address pool = poolData.poolAddresses[i];
            (address token0, address token1) = (IUniswapV3Pool(pool).token0(), IUniswapV3Pool(pool).token1());
            if (baseTokensContains(token0)) {
                arbInfo.baseSmaller[i] = token0 < token1;
                arbInfo.baseTokens[i] = token0;
                arbInfo.quoteTokens[i] = token1;
            } else {
                arbInfo.baseSmaller[i] = token1 < token0;
                arbInfo.baseTokens[i] = token1;
                arbInfo.quoteTokens[i] = token0;
            }
        }
        return arbInfo;
    }

    function getPositionDetails(uint256 positionId) internal view returns (uint128 liquidity, int24 tickLower, int24 tickUpper) {
        (, , , , , tickLower, tickUpper, liquidity, , , , ) = INonfungiblePositionManager(nonfungiblePositionManager).positions(positionId);
    }

    function calculateReserves(uint160 sqrtPriceX96, uint128 liquidity) internal pure returns (uint256 reserveA, uint256 reserveB) {
        uint256 priceX96 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
        reserveA = FullMath.mulDiv(liquidity, priceX96, 0x1000000000000000000000000);
        reserveB = FullMath.mulDiv(liquidity, 0x1000000000000000000000000, priceX96);
        return (reserveA, reserveB);
    }

    function getReservesAndData(address poolAddress, uint256 positionId) public view returns (ReserveData memory) {
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(poolAddress).slot0();
        (uint128 liquidity, int24 tickLower, int24 tickUpper) = getPositionDetails(positionId);
        (uint256 reserveA, uint256 reserveB) = calculateReserves(sqrtPriceX96, liquidity);
        return ReserveData({
            reserveA: reserveA,
            reserveB: reserveB,
            sqrtPriceX96: sqrtPriceX96,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidity: liquidity
        });
    }

    function compareDecimal(Decimal.D256 memory d1, Decimal.D256 memory d2) internal pure returns (bool) {
        return d1.value < d2.value;
    }

    function getOrderedReserves(
        bool[] memory baseTokenSmaller,
        PoolData memory poolData,
        address[] memory path
    ) internal view returns (ArbitrageInfo memory arbInfo, OrderedReserves memory orderedReserves, Decimal.D256[] memory prices) {
        ReserveDataBundle memory reserveBundle = getReserveBundle(poolData);
        prices = calculatePrices(baseTokenSmaller, reserveBundle.sqrtPriceX96);
        arbInfo = sortPools(prices, poolData);

        orderedReserves.reservesA = new uint256[](poolData.poolAddresses.length);
        orderedReserves.reservesB = new uint256[](poolData.poolAddresses.length);
        orderedReserves.tickLowers = new int24[](poolData.poolAddresses.length);
        orderedReserves.tickUppers = new int24[](poolData.poolAddresses.length);
        orderedReserves.liquidities = new uint128[](poolData.poolAddresses.length);

        for (uint256 i = 0; i < poolData.poolAddresses.length; i++) {
            address pool = arbInfo.sortedPools[i];
            uint256 index = findPoolIndex(pool, poolData.poolAddresses);
            bool isBase = (path[i] == arbInfo.baseTokens[index]);
            orderedReserves.reservesA[i] = pool == reserveBundle.poolAddresses[index] ? reserveBundle.reserves[index][isBase ? 0 : 1] : 0;
            orderedReserves.reservesB[i] = pool == reserveBundle.poolAddresses[index] ? reserveBundle.reserves[index][isBase ? 1 : 0] : 0;
            orderedReserves.tickLowers[i] = reserveBundle.tickLower[index];
            orderedReserves.tickUppers[i] = reserveBundle.tickUpper[index];
            orderedReserves.liquidities[i] = reserveBundle.liquidity[index];
        }
    }

    function calculatePrices(
        bool[] memory baseTokenSmaller,
        uint160[] memory sqrtPrices
    ) internal pure returns (Decimal.D256[] memory prices) {
        prices = new Decimal.D256[](sqrtPrices.length);
        for (uint256 i = 0; i < sqrtPrices.length; i++) {
            uint256 priceX96Squared = FullMath.mulDiv(sqrtPrices[i], sqrtPrices[i], 1);
            require(priceX96Squared > 1e10, "Price too small");
            if (baseTokenSmaller[i]) {
                prices[i] = Decimal.from(FullMath.mulDiv(priceX96Squared, 1, 1 << 192));
            } else {
                require(priceX96Squared != 0, "Price calculation underflow");
                prices[i] = Decimal.from(FullMath.mulDiv(1 << 192, 1, priceX96Squared));
            }
        }
    }

    function getReserveBundle(PoolData memory poolData) internal view returns (ReserveDataBundle memory reserveBundle) {
        reserveBundle.reserves = new uint256[2][](poolData.poolAddresses.length);
        reserveBundle.sqrtPriceX96 = new uint160[](poolData.poolAddresses.length);
        reserveBundle.tickLower = new int24[](poolData.poolAddresses.length);
        reserveBundle.tickUpper = new int24[](poolData.poolAddresses.length);
        reserveBundle.liquidity = new uint128[](poolData.poolAddresses.length);
        reserveBundle.poolAddresses = new address[](poolData.poolAddresses.length);

        for (uint256 i = 0; i < poolData.poolAddresses.length; i++) {
            ReserveData memory data = getReservesAndData(poolData.poolAddresses[i], poolData.positionIds[i]);
            reserveBundle.reserves[i] = [data.reserveA, data.reserveB];
            reserveBundle.sqrtPriceX96[i] = data.sqrtPriceX96;
            reserveBundle.tickLower[i] = data.tickLower;
            reserveBundle.tickUpper[i] = data.tickUpper;
            reserveBundle.liquidity[i] = data.liquidity;
            reserveBundle.poolAddresses[i] = poolData.poolAddresses[i];
        }
    }

    function sortPools(
        Decimal.D256[] memory prices,
        PoolData memory poolData
    ) internal pure returns (ArbitrageInfo memory arbInfo) {
        arbInfo.sortedPools = new address[](poolData.poolAddresses.length);
        uint256[] memory indices = new uint256[](prices.length);
        for (uint256 i = 0; i < prices.length; i++) indices[i] = i;

        for (uint256 i = 0; i < prices.length - 1; i++) {
            for (uint256 j = 0; j < prices.length - i - 1; j++) {
                if (compareDecimal(prices[indices[j]], prices[indices[j + 1]])) {
                    (indices[j], indices[j + 1]) = (indices[j + 1], indices[j]);
                }
            }
        }

        for (uint256 i = 0; i < indices.length; i++) {
            arbInfo.sortedPools[i] = poolData.poolAddresses[indices[i]];
        }
    }

    function findPoolIndex(address pool, address[] memory poolAddresses) internal pure returns (uint256) {
        for (uint256 i = 0; i < poolAddresses.length; i++) {
            if (poolAddresses[i] == pool) return i;
        }
        revert("Pool not found");
    }

    function chooseBestPath(
        address[][] memory paths,
        uint256[] memory borrowAmounts,
        PoolData memory poolData
    ) public {
        require(paths.length == borrowAmounts.length && paths.length == poolData.poolAddresses.length, "Length mismatch");
        ArbitrageInfo memory arbInfo;

        for (uint256 i = 0; i < paths.length; i++) {
            arbInfo = processPath(paths[i], borrowAmounts[i], poolData);
            if (validateTokenPath(paths[i], arbInfo)) {
                executeSwap(paths[i], borrowAmounts[i], poolData.profits[i], arbInfo);
                return;
            }
        }
        revert("No valid path found");
    }

    function processPath(
        address[] memory path,
        uint256 borrowAmount,
        PoolData memory poolData
    ) internal returns (ArbitrageInfo memory arbInfo) {
        arbInfo = isBaseTokenSmaller(poolData);
        OrderedReserves memory orderedReserves;
        Decimal.D256[] memory prices;
        (, orderedReserves, prices) = getOrderedReserves(arbInfo.baseSmaller, poolData, path);

        for (uint256 i = 0; i < poolData.poolAddresses.length; i++) {
            if (arbInfo.sortedPools[i] == poolData.poolAddresses[i]) {
                poolData.borrowAmounts[i] = borrowAmount;
                break;
            }
        }
        return arbInfo;
    }

    function validateTokenPath(address[] memory path, ArbitrageInfo memory arbInfo) internal view returns (bool) {
        for (uint256 i = 0; i < arbInfo.sortedPools.length; i++) {
            address token0 = IUniswapV3Pool(arbInfo.sortedPools[i]).token0();
            address token1 = IUniswapV3Pool(arbInfo.sortedPools[i]).token1();
            if (!(path[i] == token0 || path[i] == token1)) return false;
        }
        return true;
    }

    function executeSwap(
        address[] memory path,
        uint256 amountIn,
        uint256 expectedProfit,
        ArbitrageInfo memory arbInfo
    ) internal {
        uint256 minOutput = expectedProfit > 0 ? expectedProfit : 1;
        PoolAddress.PoolKey memory poolKey = PoolAddress.PoolKey({
            token0: IUniswapV3Pool(arbInfo.sortedPools[0]).token0(),
            token1: IUniswapV3Pool(arbInfo.sortedPools[0]).token1(),
            fee: uint24(3000)
        });

        uint256 debtAmount = getAmountInWithQuoterV2MultiHop(amountIn, path);
        FlashCallbackData memory callbackData = FlashCallbackData({
            amount0: arbInfo.baseSmaller[0] ? 0 : debtAmount,
            amount1: arbInfo.baseSmaller[0] ? debtAmount : 0,
            payer: msg.sender,
            poolKey: poolKey,
            poolFee2: uint24(3000),
            poolFee3: uint24(3000),
            path: path,
            Flpool: arbInfo.sortedPools[0]
        });

        permissionedPairAddress = callbackData.Flpool;
        IUniswapV3Pool(callbackData.Flpool).flash(
            address(this),
            callbackData.amount0,
            callbackData.amount1,
            abi.encode(callbackData)
        );
    }

   function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external override nonReentrant {
        FlashCallbackData memory decoded = abi.decode(data, (FlashCallbackData));
        CallbackValidation.verifyCallback(factory, decoded.poolKey);

        address token0 = decoded.poolKey.token0; // Borrowed token if amount0 > 0
        address token1 = decoded.poolKey.token1; // Borrowed token if amount1 > 0
        uint256 amount0Owed = LowGasSafeMath.add(decoded.amount0, fee0);
        uint256 amount1Owed = LowGasSafeMath.add(decoded.amount1, fee1);

        // Determine which token was borrowed
        address borrowedToken = decoded.amount0 > 0 ? token0 : token1;
        uint256 amountOwed = decoded.amount0 > 0 ? amount0Owed : amount1Owed;

        uint256 amountIn = decoded.amount0 == 0 ? decoded.amount1 : decoded.amount0;
        address[] memory path = decoded.path;
        uint256 outputAmount = amountIn;

        // Execute the arbitrage path
        for (uint256 i = 0; i < path.length - 1; i++) {
            outputAmount = singleSwap(path[i], path[i + 1], outputAmount);
        }

        // After the arbitrage, we have outputAmount of the last token in the path
        address finalToken = path[path.length - 1];
        uint256 finalBalance = IERC20(finalToken).balanceOf(address(this));

        // If the final token is not the borrowed token, swap back to the borrowed token
        if (finalToken != borrowedToken) {
            uint256 amountToSwapBack = finalBalance;
            if (amountToSwapBack > 0) {
                outputAmount = BSwap(finalToken, borrowedToken, amountToSwapBack);
            }
        }

        // Check balance of the borrowed token after swapping back
        uint256 borrowedTokenBalance = IERC20(borrowedToken).balanceOf(address(this));
        require(borrowedTokenBalance >= amountOwed, "Insufficient balance to repay borrowed token");

        // Repay the flash loan
        repayWithApproval(borrowedToken, amountOwed);

        // Calculate profit in the borrowed token
        uint256 profit = borrowedTokenBalance > amountOwed ? borrowedTokenBalance - amountOwed : 0;

        // Distribute profit to the payer if any
        if (profit > 0) {
            distributeProfit(borrowedToken, decoded.payer, profit);
        }

        // Reset permissionedPairAddress
        permissionedPairAddress = address(1);
        emit FlashArbitrageExecuted(amountIn, outputAmount);
    }

    function repayWithApproval(address token, uint256 amountOwed) private {
        if (amountOwed > 0) {
            uint256 allowance = IERC20(token).allowance(address(this), msg.sender);
            if (allowance < amountOwed) {
                TransferHelper.safeApprove(token, msg.sender, amountOwed);
            }
            pay(token, address(this), msg.sender, amountOwed);
        }
    }

    function distributeProfit(address token, address payer, uint256 profit) private {
        uint256 allowance = IERC20(token).allowance(address(this), payer);
        if (allowance < profit) {
            TransferHelper.safeApprove(token, payer, profit);
        }
        pay(token, address(this), payer, profit);
    }

    function BSwap(address inputToken, address outputToken, uint256 amountIn) internal returns (uint256 amountOut) {
        uint256 allowance = IERC20(inputToken).allowance(address(this), address(swapRouter));
        if (allowance < amountIn) {
            TransferHelper.safeApprove(inputToken, address(swapRouter), amountIn);
        }

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: inputToken,
            tokenOut: outputToken,
            fee: uint24(3000),
            recipient: address(this),
            deadline: block.timestamp + 60,
            amountIn: amountIn,
            amountOutMinimum: 1,
            sqrtPriceLimitX96: 0
        });

        amountOut = IERC20(outputToken).balanceOf(address(this));
    }

    function singleSwap(address inputToken, address outputToken, uint256 amountIn) internal returns (uint256) {
        uint256 allowance = IERC20(inputToken).allowance(address(this), address(swapRouter));
        if (allowance < amountIn) {
            TransferHelper.safeApprove(inputToken, address(swapRouter), amountIn);
        }

        ISwapRouter.ExactInputParams memory params = ISwapRouter.ExactInputParams({
            path: abi.encodePacked(inputToken, uint24(3000), outputToken),
            recipient: address(this),
            deadline: block.timestamp + 60,
            amountIn: amountIn,
            amountOutMinimum: 1
        });

        return swapRouter.exactInput(params);
    }

    function encodeMultiHopPath(address[] memory path) internal pure returns (bytes memory encodedPath) {
        require(path.length >= 2, "Path must have at least 2 tokens");
        encodedPath = abi.encodePacked(path[0]);
        for (uint256 i = 1; i < path.length; i++) {
            encodedPath = abi.encodePacked(encodedPath, uint24(3000), path[i]);
        }
    }

    function executeFlashArbitrage(
        address[][] memory paths,
        uint256[] memory borrowAmounts,
        PoolData memory poolData
    ) external onlyOwner {
        chooseBestPath(paths, borrowAmounts, poolData);
    }

    function getAmountInWithQuoterV2MultiHop(
        uint256 amountOut,
        address[] memory path
    ) internal returns (uint256 amountIn) {
        bytes memory encodedPath = encodeMultiHopPath(path);
        uint160[] memory sqrtPriceX96AfterList;
        uint32[] memory initializedTicksCrossedList;
        uint256 gasEstimate;
        (amountIn, sqrtPriceX96AfterList, initializedTicksCrossedList, gasEstimate) = quoterContract.quoteExactOutput(encodedPath, amountOut);
    }

    function getAmountOutWithQuoterV2MultiHop(
        uint256 amountIn,
        address[] memory path
    ) internal returns (uint256 amountOut) {
        bytes memory encodedPath = encodeMultiHopPath(path);
        uint160[] memory sqrtPriceX96After;
        uint32[] memory initializedTicksCrossed;
        uint256 gasEstimate;
        (amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate) = quoterContract.quoteExactInput(encodedPath, amountIn);
    }
}