// SPDX-License-Identifier: MIT
pragma solidity 0.7.6;
pragma abicoder v2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";
import "@uniswap/v3-periphery/contracts/interfaces/IPeripheryImmutableState.sol";
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@uniswap/v3-periphery/contracts/libraries/TransferHelper.sol";
import "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "./Decimal.sol";
import "./SafeMathCopy.sol";


    struct PoolData {
        address poolAddressAB;
        address poolAddressBC;
        address poolAddressCA;
        uint256 positionIdAB;
        uint256 positionIdBC;
        uint256 positionIdCA;
        uint256 borrowAmount1;
        uint256 borrowAmount2;
        uint256 borrowAmount3;
        uint256 profit1;
        uint256 profit2;
        uint256 profit3;
    }
    struct OrderedReserves {
        uint256 a1; // base asset
        uint256 b1;
        uint256 a2;
        uint256 b2;
        uint256 a3;
        uint256 b3;
    }
    struct ArbitrageInfo {
        address baseToken0;
        address quoteToken0;
        address baseToken1;
        address quoteToken1;
        address baseToken2;
        address quoteToken2;
        bool baseSmaller;
        address lowerPool;
        address middlePool; // pool with lower price, denominated in quote asset
        address higherPool; // pool with higher price, denominated in quote asset
    }

    struct CallbackData {
        address debtPool;
        address targetPool;
        address finalPool;
        bool debtTokenSmaller;
        address borrowedToken;
        address intermediateToken;
        address debtToken;
        uint256 debtAmount;
        uint256 debtTokenOutAmount;
    }
  
    
contract FlashArbitrage is Ownable {
    
    using SafeERC20 for IERC20;
    using Decimal for Decimal.D256;
    using SafeMath for uint256;
    using EnumerableSet for EnumerableSet.AddressSet;

    
    address immutable WETH;
    ISwapRouter public immutable swapRouter;
    address immutable nonfungiblePositionManager;

    address permissionedPairAddress = address(1);

    // AVAILABLE BASE TOKENS
    EnumerableSet.AddressSet baseTokens;


    event Withdrawn(address indexed to, uint256 indexed value);
    event BaseTokenAdded(address indexed token);
    event BaseTokenRemoved(address indexed token);
    event FlashArbitrageExecuted(uint256 amountIn, uint256 amountOut);
    

    constructor(address _WETH, address _swapRouter, address _nonfungiblePositionManager) {
        WETH = _WETH;
        swapRouter = ISwapRouter(_swapRouter);
        nonfungiblePositionManager = _nonfungiblePositionManager;
        EnumerableSet.add(baseTokens, _WETH);
    }

    receive() external payable {}
     /// @dev Redirect uniswap callback function
    /// The callback function on different DEX are not same, so use a fallback to redirect to uniswapV2Call
    fallback(bytes calldata _input) external returns (bytes memory){
        (address sender, uint256 amount0, uint256 amount1, bytes memory data) = abi.decode(_input[4:], (address, uint256, uint256, bytes));
        uniswapV3Call(sender, amount0, amount1, data);
    }


    function withdraw() external onlyOwner{
        uint256 balance = address(this).balance;
        if (balance > 0) {
            payable(owner()).transfer(balance);
            emit Withdrawn(owner(), balance);
        }

        for (uint256 i = 0; i < baseTokens.length(); i++) {
            address token = baseTokens.at(i);
            balance = IERC20(token).balanceOf(address(this));
            if (balance > 0) {
                // do not use safe transfer here to prevents revert by any shitty token
                IERC20(token).transfer(owner(), balance);
            }
        }
    }

    function estimateGasFee() internal view returns (uint256) {
        // Example logic to estimate gas fees (can be refined)
        uint256 gasPrice = tx.gasprice;
        uint256 gasUsed = 21000; // Placeholder value, adjust based on complexity
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

    function isBaseTokenSmaller(
        address pool0, 
        address pool1, 
        address pool2
    )
        internal
        view
        returns (
            ArbitrageInfo memory arbInfo
        )
    {
        require(pool0 != pool1 && pool1 != pool2 && pool0 != pool2, 'Same pair address');
        
        // Get tokens from pool0
        (address pool0Token0, address pool0Token1) = (
            IUniswapV3Pool(pool0).token0(), 
            IUniswapV3Pool(pool0).token1()
        );
        
        // Get tokens from pool1
        (address pool1Token0, address pool1Token1) = (
            IUniswapV3Pool(pool1).token0(), 
            IUniswapV3Pool(pool1).token1()
        );
        
        // Get tokens from pool2
        (address pool2Token0, address pool2Token1) = (
            IUniswapV3Pool(pool2).token0(), 
            IUniswapV3Pool(pool2).token1()
        );
        
        // Normalize token orders
        (pool0Token0, pool0Token1) = pool0Token0 < pool0Token1 ? (pool0Token0, pool0Token1) : (pool0Token1, pool0Token0);
        (pool1Token0, pool1Token1) = pool1Token0 < pool1Token1 ? (pool1Token0, pool1Token1) : (pool1Token1, pool1Token0);
        (pool2Token0, pool2Token1) = pool2Token0 < pool2Token1 ? (pool2Token0, pool2Token1) : (pool2Token1, pool2Token0);
        
        // Check if token paths form a chain
        bool chainPath = (
            (pool0Token1 == pool1Token0 && pool1Token1 == pool2Token0)
        );
        require(chainPath, 'Inconsistent token chain across pools');
        
        // Determine base and quote tokens for pool0
        if (baseTokensContains(pool0Token0)) {
            arbInfo.baseSmaller = pool0Token0 < pool0Token1;
            arbInfo.baseToken0 = pool0Token0;
            arbInfo.quoteToken0 = pool0Token1;
        } else {
            arbInfo.baseSmaller = pool0Token1 < pool0Token0;
            arbInfo.baseToken0 = pool0Token1;
            arbInfo.quoteToken0 = pool0Token0;
        }
        
        // Determine base and quote tokens for pool1
        if (baseTokensContains(pool1Token0)) {
            arbInfo.baseSmaller = pool1Token0 < pool1Token1;
            arbInfo.baseToken1 = pool1Token0;
            arbInfo.quoteToken1 = pool1Token1;
        } else {
            arbInfo.baseSmaller = pool1Token1 < pool1Token0;
            arbInfo.baseToken1 = pool1Token1;
            arbInfo.quoteToken1 = pool1Token0;
        }

        // Determine base and quote tokens for pool2
        if (baseTokensContains(pool2Token0)) {
            arbInfo.baseSmaller = pool2Token0 < pool2Token1;
            arbInfo.baseToken2 = pool2Token0;
            arbInfo.quoteToken2 = pool2Token1;
        } else {
            arbInfo.baseSmaller = pool2Token1 < pool2Token0;
            arbInfo.baseToken2 = pool2Token1;
            arbInfo.quoteToken2 = pool2Token0;
        }

        return (arbInfo);
    }

    function getPositionDetails(uint256 positionId) internal view returns (uint128 liquidity, int24 tickLower, int24 tickUpper) {
        (, , , , , tickLower, tickUpper, liquidity, , , , ) = INonfungiblePositionManager(nonfungiblePositionManager).positions(positionId);
    }

    function calculateReserves(uint160 sqrtPriceX96, uint128 liquidity) internal pure returns (uint256 reserveA, uint256 reserveB) {
        uint256 priceX96;
        uint256 priceSquared;
        assembly {
            priceX96 := mul(sqrtPriceX96, sqrtPriceX96)
            priceSquared := mul(priceX96, priceX96)
            reserveA := div(mul(liquidity, priceX96), 0x1000000000000000000000000)
            reserveB := div(mul(liquidity, 0x1000000000000000000000000), priceX96)
        }
    }

    function getReserves(address poolAddress, uint256 positionId) public view returns (uint256 reserveA, uint256 reserveB) {
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(poolAddress).slot0();
        (uint128 liquidity, , ) = getPositionDetails(positionId);
        return calculateReserves(sqrtPriceX96, liquidity);
    }
 


    

    // Function to compare decimals
    function compareDecimal(Decimal.D256 memory d1, Decimal.D256 memory d2) internal pure returns (bool) {
        return d1.value < d2.value;
    }

        function getOrderedReserves(
        address pool0,
        address pool1,
        address pool2,
        bool baseTokenSmaller,
        PoolData memory poolData
    )
        internal
        view
        returns (ArbitrageInfo memory arbInfo, OrderedReserves memory orderedReserves)
    {
        // Break reserve fetching logic into a separate function
        uint256[2][3] memory reserves = fetchReserves(poolData);

        // Break price calculations into another function to reduce stack depth
        Decimal.D256[3] memory prices = calculatePrices(baseTokenSmaller, reserves);

        // Break pool sorting logic into a separate function
        arbInfo = sortPools(prices, pool0, pool1, pool2);

        // Use the pre-fetched reserves and arbInfo to set ordered reserves
        orderedReserves = setOrderedReserves(baseTokenSmaller, arbInfo, reserves, pool0, pool1, pool2);
    }

    function fetchReserves(PoolData memory poolData) internal view returns (uint256[2][3] memory reserves) {
        (reserves[0][0], reserves[0][1]) = getReserves(poolData.poolAddressAB, poolData.positionIdAB);
        (reserves[1][0], reserves[1][1]) = getReserves(poolData.poolAddressBC, poolData.positionIdBC);
        (reserves[2][0], reserves[2][1]) = getReserves(poolData.poolAddressCA, poolData.positionIdCA);
    }

    function calculatePrices(bool baseTokenSmaller, uint256[2][3] memory reserves)
        internal
        pure
        returns (Decimal.D256[3] memory prices)
    {
        for (uint256 i = 0; i < 3; i++) {
            prices[i] = baseTokenSmaller 
                ? Decimal.from((reserves[i][0] * 1e18) / reserves[i][1])
                : Decimal.from((reserves[i][1] * 1e18) / reserves[i][0]);
        }
    }

    function sortPools(
        Decimal.D256[3] memory prices,
        address pool0,
        address pool1,
        address pool2
    ) internal pure returns (ArbitrageInfo memory arbInfo) {
        if (compareDecimal(prices[0], prices[1])) {
            if (compareDecimal(prices[0], prices[2])) {
                arbInfo.lowerPool = pool0;
                if (compareDecimal(prices[1], prices[2])) {
                    arbInfo.middlePool = pool1;
                    arbInfo.higherPool = pool2;
                } else {
                    arbInfo.middlePool = pool2;
                    arbInfo.higherPool = pool1;
                }
            } else {
                arbInfo.lowerPool = pool2;
                arbInfo.middlePool = pool0;
                arbInfo.higherPool = pool1;
            }
        } else {
            if (compareDecimal(prices[1], prices[2])) {
                arbInfo.lowerPool = pool1;
                if (compareDecimal(prices[0], prices[2])) {
                    arbInfo.middlePool = pool0;
                    arbInfo.higherPool = pool2;
                } else {
                    arbInfo.middlePool = pool2;
                    arbInfo.higherPool = pool0;
                }
            } else {
                arbInfo.lowerPool = pool2;
                arbInfo.middlePool = pool1;
                arbInfo.higherPool = pool0;
            }
        }
    }

    function setOrderedReserves(
        bool baseTokenSmaller,
        ArbitrageInfo memory arbInfo,
        uint256[2][3] memory reserves,
        address pool0,
        address pool1,
        address pool2
    ) internal pure returns (OrderedReserves memory orderedReserves) {
        if (baseTokenSmaller) {
            orderedReserves = OrderedReserves({
                a1: arbInfo.lowerPool == pool0 ? reserves[0][0] : (arbInfo.lowerPool == pool1 ? reserves[1][0] : reserves[2][0]),
                b1: arbInfo.lowerPool == pool0 ? reserves[0][1] : (arbInfo.lowerPool == pool1 ? reserves[1][1] : reserves[2][1]),
                a2: arbInfo.middlePool == pool0 ? reserves[0][0] : (arbInfo.middlePool == pool1 ? reserves[1][0] : reserves[2][0]),
                b2: arbInfo.middlePool == pool0 ? reserves[0][1] : (arbInfo.middlePool == pool1 ? reserves[1][1] : reserves[2][1]),
                a3: arbInfo.higherPool == pool0 ? reserves[0][0] : (arbInfo.higherPool == pool1 ? reserves[1][0] : reserves[2][0]),
                b3: arbInfo.higherPool == pool0 ? reserves[0][1] : (arbInfo.higherPool == pool1 ? reserves[1][1] : reserves[2][1])
            });
        } else {
            orderedReserves = OrderedReserves({
                a1: arbInfo.lowerPool == pool0 ? reserves[0][1] : (arbInfo.lowerPool == pool1 ? reserves[1][1] : reserves[2][1]),
                b1: arbInfo.lowerPool == pool0 ? reserves[0][0] : (arbInfo.lowerPool == pool1 ? reserves[1][0] : reserves[2][0]),
                a2: arbInfo.middlePool == pool0 ? reserves[0][1] : (arbInfo.middlePool == pool1 ? reserves[1][1] : reserves[2][1]),
                b2: arbInfo.middlePool == pool0 ? reserves[0][0] : (arbInfo.middlePool == pool1 ? reserves[1][0] : reserves[2][0]),
                a3: arbInfo.higherPool == pool0 ? reserves[0][1] : (arbInfo.higherPool == pool1 ? reserves[1][1] : reserves[2][1]),
                b3: arbInfo.higherPool == pool0 ? reserves[0][0] : (arbInfo.higherPool == pool1 ? reserves[1][0] : reserves[2][0])
            });
        }
    }



    function calcBorrowAmount(OrderedReserves memory reserves) internal pure returns (uint256 amount) {
        // Step 1: Get the minimum of each reserve pair
        uint256 min1 = getMinimum(reserves.a1, reserves.b1);
        uint256 min2 = getMinimum(reserves.a2, reserves.b2);
        uint256 min3 = getMinimum(reserves.a3, reserves.b3);

        // Step 2: Get the minimum of all three minimums
        uint256 min = getMinimum(min1, getMinimum(min2, min3));

        // Step 3: Choose division factor based on the smallest reserve
        uint256 d = getDivisionFactor(min);

        // Step 4: Calculate the quadratic components
        int256 a = calculateA(reserves, d);
        int256 b = calculateB(reserves, d);
        int256 c = calculateC(reserves, d);

        // Step 5: Solve the quadratic equation
        (int256 x1, int256 x2) = calcSolutionForQuadratic(a, b, c);

        // Step 6: Validate and choose the correct solution
        require(isValidSolution(x1, reserves, d) || isValidSolution(x2, reserves, d), 'Invalid input order');
        amount = (isValidSolution(x1, reserves, d)) ? uint256(x1) * d : uint256(x2) * d;
    }

    function getMinimum(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function getDivisionFactor(uint256 min) internal pure returns (uint256 d) {
        if (min > 1e24) d = 1e20;
        else if (min > 1e23) d = 1e19;
        else if (min > 1e22) d = 1e18;
        else if (min > 1e21) d = 1e17;
        else if (min > 1e20) d = 1e16;
        else if (min > 1e19) d = 1e15;
        else if (min > 1e18) d = 1e14;
        else if (min > 1e17) d = 1e13;
        else if (min > 1e16) d = 1e12;
        else if (min > 1e15) d = 1e11;
        else d = 1e10;
    }

    function calculateA(OrderedReserves memory reserves, uint256 d) internal pure returns (int256) {
        return int256(reserves.a1 / d) * int256(reserves.b1 / d) 
            - int256(reserves.a2 / d) * int256(reserves.b2 / d)
            + int256(reserves.a3 / d) * int256(reserves.b3 / d);
    }

    function calculateB(OrderedReserves memory reserves, uint256 d) internal pure returns (int256) {
        return 2 * int256(reserves.b1 / d) * int256(reserves.b2 / d) * int256(reserves.b3 / d)
            * (int256(reserves.a1 / d) + int256(reserves.a2 / d) + int256(reserves.a3 / d));
    }

    function calculateC(OrderedReserves memory reserves, uint256 d) internal pure returns (int256) {
        return int256(reserves.b1 / d) * int256(reserves.b2 / d) * int256(reserves.b3 / d)
            * (int256(reserves.a1 / d) * int256(reserves.b2 / d) * int256(reserves.b3 / d)
            - int256(reserves.a2 / d) * int256(reserves.b1 / d) * int256(reserves.b3 / d)
            + int256(reserves.a3 / d) * int256(reserves.b1 / d) * int256(reserves.b2 / d));
    }

    function isValidSolution(int256 x, OrderedReserves memory reserves, uint256 d) internal pure returns (bool) {
        return x > 0 && x < int256(reserves.b1 / d) && x < int256(reserves.b2 / d) && x < int256(reserves.b3 / d);
    }


    /// @dev find solution of quadratic equation: ax^2 + bx + c = 0, only return the positive solution
    function calcSolutionForQuadratic(
        int256 a,
        int256 b,
        int256 c
    ) internal pure returns (int256 x1, int256 x2) {
        int256 m = b**2 - 4 * a * c;
        // m < 0 leads to complex number
        require(m > 0, 'Complex number');

        int256 sqrtM = int256(sqrt(uint256(m)));
        x1 = (-b + sqrtM) / (2 * a);
        x2 = (-b - sqrtM) / (2 * a);
    }

    /// @dev Newton’s method for caculating square root of n
    function sqrt(uint256 n) internal pure returns (uint256 res) {
        assert(n > 1);

        // The scale factor is a crude way to turn everything into integer calcs.
        // Actually do (n * 10 ^ 4) ^ (1/2)
        uint256 _n = n * 10**6;
        uint256 c = _n;
        res = _n;

        uint256 xi;
        while (true) {
            xi = (res + c / res) / 2;
            // don't need be too precise to save gas
            if (res - xi < 1000) {
                break;
            }
            res = xi;
        }
        res = res / 10**3;
    }
    
    function calculateProfit(address pool0, address pool1, address pool2,  PoolData memory poolData) public view returns (uint256 profit, address baseToken) {
        // Determine whether the base token is smaller and retrieve the base token
        
        (ArbitrageInfo memory arbInfo) = isBaseTokenSmaller(pool0, pool1, pool2);
        bool baseTokenSmaller = arbInfo.baseSmaller;
        baseToken = baseTokenSmaller ? IUniswapV3Pool(pool0).token0() : IUniswapV3Pool(pool0).token1();

        // Get the ordered reserves from the three pools
        (ArbitrageInfo memory arbInfos, OrderedReserves memory orderedReserves) = getOrderedReserves(pool0, pool1, pool2, baseTokenSmaller, poolData);

        // Calculate the borrow amount using the ordered reserves
        uint256 borrowAmount = calcBorrowAmount(orderedReserves);

        // Calculate the amount of debt (quote token to repay) based on the borrow amount
        uint256 debtAmount = getAmountIn(borrowAmount, orderedReserves.a1, orderedReserves.b1);

        // Sell the borrowed quote token on the middle pool to get base token amount
        uint256 baseTokenOutAmount1 = getAmountOut(borrowAmount, orderedReserves.b2, orderedReserves.a2);

        // Sell the base token on the higher pool to maximize profit
        uint256 finalTokenOutAmount = getAmountOut(baseTokenOutAmount1, orderedReserves.a3, orderedReserves.b3);

        // Check if the arbitrage is profitable
        if (finalTokenOutAmount < debtAmount) {
            profit = 0; // No profit, arbitrage not successful
        } else {
            profit = finalTokenOutAmount - debtAmount; // Calculate the net profit
        }
    }

    
    function chooseBestPath(
        address[] memory path1, 
        address[] memory path2, 
        address[] memory path3, 
        PoolData memory poolData
    ) public {
        // Use helper functions to split logic and reduce the number of variables in this function.

        // Get ordered reserves and calculate profit for each path
        poolData.profit1 = processPath(poolData.poolAddressAB, poolData.poolAddressBC, poolData.poolAddressCA, path1, poolData);
        poolData.profit2 = processPath(poolData.poolAddressBC, poolData.poolAddressCA, poolData.poolAddressAB, path2, poolData);
        poolData.profit3 = processPath(poolData.poolAddressCA, poolData.poolAddressAB, poolData.poolAddressBC, path3, poolData);

        // Select the most profitable path
        if (poolData.profit1 >= poolData.profit2 && poolData.profit1 >= poolData.profit3) {
            executeSwap(path1, poolData.borrowAmount1, poolData.profit1);
        } else if (poolData.profit2 >= poolData.profit1 && poolData.profit2 >= poolData.profit3) {
            executeSwap(path2, poolData.borrowAmount2, poolData.profit2);
        } else {
            executeSwap(path3, poolData.borrowAmount3, poolData.profit3);
        }
    }

    function processPath(
        address poolA, 
        address poolB, 
        address poolC, 
        address[] memory path, 
        PoolData memory poolData
    ) internal returns (uint256 profit) {
        // Create ArbitrageInfo and OrderedReserves instances
        ArbitrageInfo memory arbInfo;
        OrderedReserves memory orderedReserves;

        // Get ordered reserves
        (arbInfo, orderedReserves) = getOrderedReserves(poolA, poolB, poolC, arbInfo.baseSmaller, poolData);

        // Calculate borrow amount
        uint256 borrowAmount = calcBorrowAmount(orderedReserves);

        // Save borrow amount in poolData (needed for later execution)
        if (poolA == poolData.poolAddressAB) poolData.borrowAmount1 = borrowAmount;
        else if (poolA == poolData.poolAddressBC) poolData.borrowAmount2 = borrowAmount;
        else poolData.borrowAmount3 = borrowAmount;

        // Estimate gas fee (if needed)
        uint256 gasFee = estimateGasFee(); // Implement gas fee logic

        // Calculate profit for the current path
        (profit, ) = calculateProfit(arbInfo.lowerPool, arbInfo.middlePool, arbInfo.higherPool, poolData);

        return profit;
    }



    function executeSwap(
        address[] memory path,
        uint256 amountIn,
        uint256 expectedProfit
    ) internal {
        // Add slippage protection: Minimum output to ensure profitability
        uint256 minOutput = expectedProfit > 0 ? expectedProfit : 1;

        // First, safely transfer the tokens from the user to the contract
       TransferHelper.safeTransferFrom(path[0], msg.sender, address(this), amountIn);

        // Then approve the swap router to spend the tokens for the swap
        TransferHelper.safeApprove(path[0], address(swapRouter), amountIn);

        // Execute swap using the multi-hop swap function
        ISwapRouter.ExactInputParams memory params = ISwapRouter.ExactInputParams({
            path: abi.encodePacked(path[0], uint24(3000), path[1], uint24(3000), path[2]), // Adjust fees accordingly
            recipient: address(this),
            deadline: block.timestamp + 60,
            amountIn: amountIn,
            amountOutMinimum: minOutput
        });

        // Perform the multi-hop swap
        uint256 amountOut = swapRouter.exactInput(params);

        emit FlashArbitrageExecuted(amountIn, amountOut);
    }

    function executeFlashArbitrage(
        address[] memory path1, 
        address[] memory path2, 
        address[] memory path3,
        PoolData memory poolData
    ) external onlyOwner {
        // Choose the most profitable path for arbitrage
        chooseBestPath(path1, path2, path3, poolData);
    }
 
    function uniswapV3Call(
        address sender,
        uint256 amount0,
        uint256 amount1,
        bytes memory data
    ) public {
        // Access control
        require(msg.sender == permissionedPairAddress, "Non permissioned address call");
        require(sender == address(this), "Not from this contract");

        // Decode the callback data to get the relevant information
        CallbackData memory info = abi.decode(data, (CallbackData));

        // Amount of token borrowed from the first pool
        uint256 borrowedAmount = amount0 > 0 ? amount0 : amount1;

        // Perform a multi-hop swap using Uniswap V3 Router
        IERC20(info.borrowedToken).approve(address(swapRouter), borrowedAmount);

        ISwapRouter.ExactInputParams memory params = ISwapRouter.ExactInputParams({
            path: abi.encodePacked(
                info.borrowedToken, uint24(3000), // 0.3% fee tier
                info.intermediateToken, uint24(3000), // intermediate token
                info.debtToken  // Final token we are swapping to
            ),
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: borrowedAmount,
            amountOutMinimum: 1 // Set to 1 to accept any amount of output
        });

        uint256 outputAmount = swapRouter.exactInput(params);

        // Repay the debt pool with the received amount from the final hop
        require(outputAmount >= info.debtAmount, "Insufficient output to cover debt");
        IERC20(info.debtToken).safeTransfer(info.debtPool, info.debtAmount);
    }
    // copy from UniswapV2Library
    // given an output amount of an asset and pair reserves, returns a required input amount of the other asset
    function getAmountIn(
        uint256 amountOut,
        uint256 reserveIn,
        uint256 reserveOut
    ) internal pure returns (uint256 amountIn) {
        require(amountOut > 0, 'UniswapV2Library: INSUFFICIENT_OUTPUT_AMOUNT');
        require(reserveIn > 0 && reserveOut > 0, 'UniswapV2Library: INSUFFICIENT_LIQUIDITY');
        uint256 numerator = reserveIn.mul(amountOut).mul(1000);
        uint256 denominator = reserveOut.sub(amountOut).mul(997);
        amountIn = (numerator / denominator).add(1);
    }

    // copy from UniswapV2Library
    // given an input amount of an asset and pair reserves, returns the maximum output amount of the other asset
    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) internal pure returns (uint256 amountOut) {
        require(amountIn > 0, 'UniswapV2Library: INSUFFICIENT_INPUT_AMOUNT');
        require(reserveIn > 0 && reserveOut > 0, 'UniswapV2Library: INSUFFICIENT_LIQUIDITY');
        uint256 amountInWithFee = amountIn.mul(997);
        uint256 numerator = amountInWithFee.mul(reserveOut);
        uint256 denominator = reserveIn.mul(1000).add(amountInWithFee);
        amountOut = numerator / denominator;
    }
}
