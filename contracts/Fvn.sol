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
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@uniswap/v3-periphery/contracts/libraries/TransferHelper.sol";
import "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3FlashCallback.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-periphery/contracts/interfaces/IQuoterV2.sol";
import "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

interface IWETH {
    function deposit() external payable;
    function transfer(address to, uint value) external returns (bool);
    function withdraw(uint) external;
}

contract FlashArbitrageVn is Ownable, IUniswapV3FlashCallback, PeripheryImmutableState, PeripheryPayments, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;
    using LowGasSafeMath for uint256;
    using LowGasSafeMath for int256;

    address immutable WETH;
    ISwapRouter public immutable swapRouter;
    address immutable nonfungiblePositionManager;
    IQuoterV2 public quoterContract;
    address permissionedPairAddress = address(1);
    mapping(address => address) public tokenToPriceFeed; // Token to Chainlink price feed

    EnumerableSet.AddressSet baseTokens;

    event Withdrawn(address indexed to, uint256 indexed value);
    event BaseTokenAdded(address indexed token);
    event BaseTokenRemoved(address indexed token);
    event FlashArbitrageExecuted(uint256 amountIn, uint256 amountOut);
    event Debug(string message, address addr, uint256 value);
    event PriceFeedSet(address indexed token, address indexed feed);

    struct PoolData {
        address[] poolAddresses;
        uint256[] positionIds;
        uint256[] borrowAmounts;
        uint256[] profits;
    }

    struct OrderedReserves {
        uint256[] reservesA;
        uint256[] reservesB;
        int24[] tickLowers;
        int24[] tickUppers;
        uint128[] liquidities;
    }

    struct ArbitrageInfo {
        address[] baseTokens;
        address[] quoteTokens;
        address[] sortedPools;
        bool[] baseSmaller;
    }

    struct FlashCallbackData {
        uint256[] amounts;
        address payer;
        PoolAddress.PoolKey poolKey;
        uint24[] poolFees;
        address[] path;
        address flashPool;
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

    constructor(
        address _WETH,
        address _factory,
        address _swapRouter,
        address _nonfungiblePositionManager,
        address _quoter
    ) PeripheryImmutableState(_factory, _WETH) {
        WETH = _WETH;
        swapRouter = ISwapRouter(_swapRouter);
        nonfungiblePositionManager = _nonfungiblePositionManager;
        quoterContract = IQuoterV2(_quoter);
        EnumerableSet.add(baseTokens, _WETH);
    }

    function setPriceFeed(address token, address feed) external onlyOwner {
        require(feed != address(0), "Invalid feed address");
        tokenToPriceFeed[token] = feed;
        emit PriceFeedSet(token, feed);
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
                IERC20(token).safeTransfer(owner(), balance);
            }
        }
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

    function isBaseTokenSmaller(PoolData memory poolData) internal returns (ArbitrageInfo memory arbInfo) {
        require(poolData.poolAddresses.length > 1, "At least 2 pools required");
        arbInfo.baseTokens = new address[](poolData.poolAddresses.length);
        arbInfo.quoteTokens = new address[](poolData.poolAddresses.length);
        arbInfo.sortedPools = new address[](poolData.poolAddresses.length);
        arbInfo.baseSmaller = new bool[](poolData.poolAddresses.length);

        for (uint256 i = 0; i < poolData.poolAddresses.length; i++) {
            address token0 = IUniswapV3Pool(poolData.poolAddresses[i]).token0();
            address token1 = IUniswapV3Pool(poolData.poolAddresses[i]).token1();
            if (baseTokensContains(token0)) {
                arbInfo.baseSmaller[i] = token0 < token1;
                arbInfo.baseTokens[i] = token0;
                arbInfo.quoteTokens[i] = token1;
            } else {
                arbInfo.baseSmaller[i] = token1 < token0;
                arbInfo.baseTokens[i] = token1;
                arbInfo.quoteTokens[i] = token0;
            }
            arbInfo.sortedPools[i] = poolData.poolAddresses[i];
            emit Debug("Pool Tokens Set", poolData.poolAddresses[i], i);
        }
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

    function executeArbitrage(
        address[] memory path,
        uint256[] memory borrowAmounts,
        PoolData memory poolData
    ) internal {
        require(borrowAmounts.length == poolData.poolAddresses.length, "Borrow amounts must match pools");
        require(path.length == poolData.poolAddresses.length + 1, "Path length must match pools + 1");

        ArbitrageInfo memory arbInfo = isBaseTokenSmaller(poolData);
        if (!validateTokenPath(path, arbInfo)) {
            emit Debug("Invalid path", path[0], 0);
            revert("Invalid arbitrage path");
        }

        address cycleToken = path[0];
       // require(IERC20(cycleToken).balanceOf(address(this)) >= borrowAmounts[0], "Insufficient balance");

        executeSwap(path, borrowAmounts[0], poolData.profits[0], arbInfo);
    }

    function validateTokenPath(address[] memory path, ArbitrageInfo memory arbInfo) internal returns (bool) {
        if (path.length != arbInfo.sortedPools.length + 1) {
            emit Debug("Length Mismatch", address(0), path.length);
            return false;
        }
        if (path[0] != path[path.length - 1]) {
            emit Debug("Not a Cycle", path[0], 0);
            return false;
        }

        for (uint256 i = 0; i < arbInfo.sortedPools.length; i++) {
            address token0 = IUniswapV3Pool(arbInfo.sortedPools[i]).token0();
            address token1 = IUniswapV3Pool(arbInfo.sortedPools[i]).token1();
            bool validHop = (path[i] == token0 || path[i] == token1) && 
                            (path[i + 1] == token0 || path[i + 1] == token1);
            if (!validHop) {
                emit Debug("Invalid Hop", arbInfo.sortedPools[i], i);
                return false;
            }
            emit Debug("Valid Hop", arbInfo.sortedPools[i], i);
        }
        return true;
    }

    function validatePrice(address cycleToken, uint256 debtAmount) internal view returns (uint256) {
        address feed = tokenToPriceFeed[cycleToken];
        if (feed != address(0)) {
            (, int256 price, , uint256 updatedAt, ) = AggregatorV3Interface(feed).latestRoundData();
            require(price > 0, "Invalid Chainlink price");
            require(block.timestamp - updatedAt <= 3600, "Stale Chainlink price");
            uint256 expectedAmount = uint256(price) * debtAmount / 1e8; // Adjust for 8 decimals
            require(debtAmount <= expectedAmount * 105 / 100, "Price deviation too high");
            return expectedAmount;
        }
        return debtAmount;
    }

    function prepareFlashLoan(
        address[] memory path,
        address flashPool,
        uint256 debtAmount
    ) internal view returns (FlashCallbackData memory, address[] memory swapPath) {
        IUniswapV3Pool pool = IUniswapV3Pool(flashPool);
        address token0 = pool.token0();
        address token1 = pool.token1();
        uint24 fee = pool.fee(); // Dynamically fetch fee
        bool borrowToken0 = path[0] == token0;
        address cycleToken = borrowToken0 ? token0 : token1;


        swapPath = constructSwapPath(path, flashPool, cycleToken);
        require(swapPath.length >= 2, "Swap path too short");
        require(swapPath[0] == swapPath[swapPath.length - 1], "Swap path must form a cycle");
        require(swapPath[0] == cycleToken, "Swap path must start with cycle token");

        // Ensure canonical token order for poolKey
        PoolAddress.PoolKey memory poolKey = PoolAddress.PoolKey({
            token0: token0 < token1 ? token0 : token1,
            token1: token0 < token1 ? token1 : token0,
            fee: fee
        });

        require(PoolAddress.computeAddress(factory, poolKey) == flashPool, "Pool address mismatch");

        uint256[] memory amounts = new uint256[](swapPath.length);
        amounts[0] = debtAmount;
        uint24[] memory poolFees = new uint24[](swapPath.length - 1);
        for (uint256 i = 0; i < poolFees.length; i++) {
            poolFees[i] = 3000;
        }

        FlashCallbackData memory callbackData = FlashCallbackData({
            amounts: amounts,
            payer: msg.sender,
            poolKey: poolKey,
            poolFees: poolFees,
            path: swapPath,
            flashPool: flashPool
        });

        return (callbackData, swapPath);
    }

    function initiateFlashLoan(
        address flashPool,
        bool borrowToken0,
        uint256 debtAmount,
        FlashCallbackData memory callbackData
    ) internal {
        permissionedPairAddress = callbackData.flashPool;
        IUniswapV3Pool(flashPool).flash(
            address(this),
            borrowToken0 ? debtAmount : 0,
            borrowToken0 ? 0 : debtAmount,
            abi.encode(callbackData)
        );
    }

    function executeSwap(
        address[] memory path,
        uint256 amountIn,
        uint256 expectedProfit,
        ArbitrageInfo memory arbInfo
    ) internal {
        uint256 minOutput = expectedProfit > 0 ? expectedProfit : 1;
        address flashPool = arbInfo.sortedPools[0];

        uint256 debtAmount = getAmountInWithQuoterV2MultiHop(minOutput, path);
        debtAmount = debtAmount * 101 / 100; // 1% slippage buffer

        validatePrice(path[0], debtAmount);

        (FlashCallbackData memory callbackData, address[] memory swapPath) = prepareFlashLoan(path, flashPool, debtAmount);

        bool borrowToken0 = path[0] == IUniswapV3Pool(flashPool).token0();
        initiateFlashLoan(flashPool, borrowToken0, debtAmount, callbackData);

        emit FlashArbitrageExecuted(amountIn, minOutput);
    }

    function constructSwapPath(
        address[] memory path,
        address flashPool,
        address cycleToken
    ) internal view returns (address[] memory swapPath) {
        swapPath = new address[](path.length);
        uint256 swapPathIndex = 0;
        swapPath[swapPathIndex] = cycleToken;
        swapPathIndex++;

        for (uint256 i = 0; i < path.length - 1; i++) {
            address pool = PoolAddress.computeAddress(
                factory,
                PoolAddress.getPoolKey(path[i], path[i + 1], 3000)
            );
            if (pool != flashPool) {
                address nextToken = path[i + 1];
                if (swapPath[swapPathIndex - 1] != nextToken && nextToken != cycleToken) {
                    swapPath[swapPathIndex] = nextToken;
                    swapPathIndex++;
                }
            }
        }

        if (swapPath[swapPathIndex - 1] != cycleToken) {
            swapPath[swapPathIndex] = cycleToken;
            swapPathIndex++;
        }

        address[] memory resizedSwapPath = new address[](swapPathIndex);
        for (uint256 i = 0; i < swapPathIndex; i++) {
            resizedSwapPath[i] = swapPath[i];
        }
        return resizedSwapPath;
    }

    function getSqrtPriceLimitX96(address pool, address tokenIn, address tokenOut) internal view returns (uint160) {
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
        bool zeroForOne = tokenIn < tokenOut;
        uint160 slippageFactor = 95; // 5% slippage
        if (zeroForOne) {
            return uint160(FullMath.mulDiv(sqrtPriceX96, slippageFactor, 100));
        } else {
            return uint160(FullMath.mulDiv(sqrtPriceX96, 100, slippageFactor));
        }
    }

    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external override nonReentrant {
        FlashCallbackData memory decoded = abi.decode(data, (FlashCallbackData));
        CallbackValidation.verifyCallback(factory, decoded.poolKey);

        address token0 = decoded.poolKey.token0;
        address token1 = decoded.poolKey.token1;
        uint256 amount0Owed = fee0 > 0 ? decoded.amounts[0].add(fee0) : 0;
        uint256 amount1Owed = fee1 > 0 ? decoded.amounts[0].add(fee1) : 0;
        address borrowedToken = amount0Owed > 0 ? token0 : token1;
        uint256 amountOwed = amount0Owed > 0 ? amount0Owed : amount1Owed;

        address[] memory path = decoded.path;
        uint256 outputAmount = decoded.amounts[0];

        for (uint256 i = 0; i < path.length - 1; i++) {
            address inputToken = path[i];
            address outputToken = path[i + 1];
            PoolAddress.PoolKey memory poolKey = PoolAddress.getPoolKey(inputToken, outputToken, decoded.poolFees[i]);
            address pool = PoolAddress.computeAddress(factory, poolKey);
            uint160 sqrtPriceLimitX96 = getSqrtPriceLimitX96(pool, inputToken, outputToken);

            require(IERC20(inputToken).balanceOf(address(this)) >= outputAmount, "Insufficient input token balance");
            outputAmount = singleSwap(inputToken, outputToken, outputAmount, sqrtPriceLimitX96);
            emit Debug("Swap Executed", pool, outputAmount);
        }

        uint256 borrowedTokenBalance = IERC20(borrowedToken).balanceOf(address(this));
        require(borrowedTokenBalance >= amountOwed, "Insufficient funds to repay loan");

        repayWithApproval(borrowedToken, amountOwed);

        uint256 profit = borrowedTokenBalance > amountOwed ? borrowedTokenBalance - amountOwed : 0;
        if (profit > 0) {
            distributeProfit(borrowedToken, decoded.payer, profit);
        }

        permissionedPairAddress = address(1);
        emit FlashArbitrageExecuted(decoded.amounts[0], outputAmount);
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
        require(IERC20(token).balanceOf(address(this)) >= profit, "Insufficient profit balance");
        uint256 allowance = IERC20(token).allowance(address(this), payer);
        if (allowance < profit) {
            TransferHelper.safeApprove(token, payer, profit);
        }
        pay(token, address(this), payer, profit);
    }

    function singleSwap(address inputToken, address outputToken, uint256 amountIn, uint160 sqrtPriceLimitX96) internal returns (uint256) {
        uint256 allowance = IERC20(inputToken).allowance(address(this), address(swapRouter));
        if (allowance < amountIn) {
            TransferHelper.safeApprove(inputToken, address(swapRouter), amountIn);
        }

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: inputToken,
            tokenOut: outputToken,
            fee: 3000,
            recipient: address(this),
            deadline: block.timestamp + 60,
            amountIn: amountIn,
            amountOutMinimum: 1,
            sqrtPriceLimitX96: sqrtPriceLimitX96
        });

        return swapRouter.exactInputSingle(params);
    }

    function encodeMultiHopPath(address[] memory path) internal pure returns (bytes memory encodedPath) {
        require(path.length >= 2, "Path must have at least 2 tokens");
        encodedPath = abi.encodePacked(path[0]);
        for (uint256 i = 1; i < path.length; i++) {
            encodedPath = abi.encodePacked(encodedPath, uint24(3000), path[i]);
        }
    }

    function executeFlashArbitrage(
        address[] calldata path,
        uint256[] calldata borrowAmounts,
        PoolData calldata poolData
    ) external onlyOwner {
        executeArbitrage(path, borrowAmounts, poolData);
    }

    function getAmountInWithQuoterV2MultiHop(
        uint256 amountOut,
        address[] memory path
    ) public returns (uint256 amountIn) {
        bytes memory encodedPath = encodeMultiHopPath(path);
        uint160[] memory sqrtPriceX96AfterList;
        uint32[] memory initializedTicksCrossedList;
        uint256 gasEstimate;
        (amountIn, sqrtPriceX96AfterList, initializedTicksCrossedList, gasEstimate) = quoterContract.quoteExactOutput(encodedPath, amountOut);
    }

    function getAmountOutWithQuoterV2MultiHop(
        uint256 amountIn,
        address[] memory path
    ) public returns (uint256 amountOut) {
        bytes memory encodedPath = encodeMultiHopPath(path);
        uint160[] memory sqrtPriceX96After;
        uint32[] memory initializedTicksCrossed;
        uint256 gasEstimate;
        (amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate) = quoterContract.quoteExactInput(encodedPath, amountIn);
    }
}