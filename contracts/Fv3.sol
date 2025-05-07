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
        uint256 a1;  // Reserve for token A of the lower pool
        uint256 b1;  // Reserve for token B of the lower pool
        int24 tickLower1; // Tick lower for the lower pool
        int24 tickUpper1; // Tick upper for the lower pool
        uint128 liquidity1; // Liquidity for the lower pool
        
        uint256 a2;  // Reserve for token A of the middle pool
        uint256 b2;  // Reserve for token B of the middle pool
        int24 tickLower2; // Tick lower for the middle pool
        int24 tickUpper2; // Tick upper for the middle pool
        uint128 liquidity2; // Liquidity for the middle pool
        
        uint256 a3;  // Reserve for token A of the higher pool
        uint256 b3;  // Reserve for token B of the higher pool
        int24 tickLower3; // Tick lower for the higher pool
        int24 tickUpper3; // Tick upper for the higher pool
        uint128 liquidity3; // Liquidity for the higher pool
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

    // fee2 and fee3 are the two other fees associated with the two other pools of token0 and token1
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
        uint256[2][3] reserves;
        uint160[3] sqrtPriceX96;
        int24[3] tickLower;
        int24[3] tickUpper;
        uint128[3] liquidity;
        address[3] poolAddresses; // Adding pool addresses back
    }

    
contract FlashArbitrageV3 is Ownable, IUniswapV3FlashCallback, PeripheryImmutableState, PeripheryPayments, ReentrancyGuard {
    
    using SafeERC20 for IERC20;
    using Decimal for Decimal.D256;
    //using SafeMath for uint256;
    using EnumerableSet for EnumerableSet.AddressSet;
    using LowGasSafeMath for uint256;
    using LowGasSafeMath for int256;

   
    address immutable WETH;
    ISwapRouter public immutable swapRouter;
    address immutable nonfungiblePositionManager;
    IQuoterV2 public quoterContract;
    address permissionedPairAddress = address(1);
    
    // AVAILABLE BASE TOKENS
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

    receive() external payable override{}

     /// @dev Redirect uniswap callback function
    /// The callback function on different DEX are not same, so use a fallback to redirect to uniswapV2Call
    fallback(bytes calldata _input) external returns (bytes memory) {
        // Adjust to use _input[2:] to include everything from the 3rd byte onwards
        (uint256 fee0, uint256 fee1, bytes memory data) = abi.decode(_input[3:], (uint256, uint256, bytes));
        IUniswapV3FlashCallback(msg.sender).uniswapV3FlashCallback(
             fee0,
             fee1,
             data
        );
        // Call the uniswapV3Call with sender and data
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

    function isBaseTokenSmaller(PoolData memory poolData)
        internal
        view
        returns (ArbitrageInfo memory arbInfo)
    {
        // Ensure all pool addresses are unique
        require(
            poolData.poolAddressAB != poolData.poolAddressBC && 
            poolData.poolAddressBC != poolData.poolAddressCA && 
            poolData.poolAddressAB != poolData.poolAddressCA, 
            'Same pair address'
        );

        // Get token pairs directly from pool contracts
        // Pool AB
        (address pool0Token0, address pool0Token1) = (
            IUniswapV3Pool(poolData.poolAddressAB).token0(),
            IUniswapV3Pool(poolData.poolAddressAB).token1()
        );
        
        // Pool BC
        (address pool1Token0, address pool1Token1) = (
            IUniswapV3Pool(poolData.poolAddressBC).token0(),
            IUniswapV3Pool(poolData.poolAddressBC).token1()
        );

        // Pool CA
        (address pool2Token0, address pool2Token1) = (
            IUniswapV3Pool(poolData.poolAddressCA).token0(),
            IUniswapV3Pool(poolData.poolAddressCA).token1()
        );

        // Determine base and quote tokens for pool AB
        if (baseTokensContains(pool0Token0)) {
            arbInfo.baseSmaller = pool0Token0 < pool0Token1;
            arbInfo.baseToken0 = pool0Token0;
            arbInfo.quoteToken0 = pool0Token1;
        } else {
            arbInfo.baseSmaller = pool0Token1 < pool0Token0;
            arbInfo.baseToken0 = pool0Token1;
            arbInfo.quoteToken0 = pool0Token0;
        }

        // Determine base and quote tokens for pool BC
        if (baseTokensContains(pool1Token0)) {
            arbInfo.baseSmaller = pool1Token0 < pool1Token1;
            arbInfo.baseToken1 = pool1Token0;
            arbInfo.quoteToken1 = pool1Token1;
        } else {
            arbInfo.baseSmaller = pool1Token1 < pool1Token0;
            arbInfo.baseToken1 = pool1Token1;
            arbInfo.quoteToken1 = pool1Token0;
        }

        // Determine base and quote tokens for pool CA
        if (baseTokensContains(pool2Token0)) {
            arbInfo.baseSmaller = pool2Token0 < pool2Token1;
            arbInfo.baseToken2 = pool2Token0;
            arbInfo.quoteToken2 = pool2Token1;
        } else {
            arbInfo.baseSmaller = pool2Token1 < pool2Token0;
            arbInfo.baseToken2 = pool2Token1;
            arbInfo.quoteToken2 = pool2Token0;
        }

        return arbInfo;
    }



    function getPositionDetails(uint256 positionId) internal view returns (uint128 liquidity, int24 tickLower, int24 tickUpper) {
        (, , , , , tickLower, tickUpper, liquidity, , , , ) = INonfungiblePositionManager(nonfungiblePositionManager).positions(positionId);
    }

    function calculateReserves(uint160 sqrtPriceX96, uint128 liquidity) internal pure returns (uint256 reserveA, uint256 reserveB) {
        uint256 priceX96 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96); // Square the price to get the actual price (Q64.96 format)
        
        // Solidity's mulDiv can handle large multiplication/division operations safely
        reserveA = FullMath.mulDiv(liquidity, priceX96, 0x1000000000000000000000000); // Divide by 2^96 to get reserveA
        reserveB = FullMath.mulDiv(liquidity, 0x1000000000000000000000000, priceX96); // Use priceX96 in denominator for reserveB
        
        return (reserveA, reserveB);
    }


    function getReservesAndData(address poolAddress, uint256 positionId)
        public
        view
        returns (ReserveData memory)
    {
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(poolAddress).slot0(); // Get the current sqrt price
        (uint128 liquidity, int24 tickLower, int24 tickUpper) = getPositionDetails(positionId); // Get position details
        (uint256 reserveA, uint256 reserveB) = calculateReserves(sqrtPriceX96, liquidity); // Calculate reserves based on sqrt price and liquidity

        // Return a ReserveData struct
        return ReserveData({
            reserveA: reserveA,
            reserveB: reserveB,
            sqrtPriceX96: sqrtPriceX96,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidity: liquidity
        });
    }


    // Function to compare decimals
    function compareDecimal(Decimal.D256 memory d1, Decimal.D256 memory d2) internal pure returns (bool) {
        return d1.value < d2.value;
    }


    function getOrderedReserves(
        bool baseTokenSmaller,
        PoolData memory poolData,
        address[] memory path
    )
        internal
        view
        returns (ArbitrageInfo memory arbInfo, OrderedReserves memory orderedReserves, Decimal.D256[3] memory prices)
    {
        // Fetch and bundle reserves and data from the three pools
        ReserveDataBundle memory reserveBundle = getReserveBundle(poolData);
        
        // Calculate prices based on sqrtPriceX96
        prices = calculatePrices(baseTokenSmaller, reserveBundle.sqrtPriceX96);

        // Sort pools based on price
        arbInfo = sortPools(prices, poolData);

        // Set ordered reserves based on sorted pools
        orderedReserves = setOrderedReserves(
            baseTokenSmaller,
            arbInfo,
            reserveBundle,
            path
        );
    }

    
    function calculatePrices(
        bool baseTokenSmaller,
        uint160[3] memory sqrtPrices
    ) internal pure returns (Decimal.D256[3] memory prices) {
        for (uint256 i = 0; i < 3; i++) {
            // Convert sqrtPriceX96 to actual price with 96-bit precision
            uint256 priceX96Squared = FullMath.mulDiv(sqrtPrices[i], sqrtPrices[i], 1); // Safely calculate the square of sqrtPriceX96
            
            // Ensure the priceX96Squared value doesn't cause an underflow
            require(priceX96Squared > 1e10, "Price too small"); // Adjust threshold to avoid underflow issues

            // If the base token is smaller, we use the price directly. Otherwise, we invert it.
            if (baseTokenSmaller) {
                prices[i] = Decimal.from(FullMath.mulDiv(priceX96Squared, 1, 1 << 192)); // Price of token1 in terms of token0
            } else {
                // Invert the price to get token0 in terms of token1
                require(priceX96Squared != 0, "Price calculation underflow");
                prices[i] = Decimal.from(FullMath.mulDiv(1 << 192, 1, priceX96Squared)); // Inverted price for token0 in terms of token1
            }
        }
    }


    // Helper function to fetch reserves and other related data into a struct
    function getReserveBundle(PoolData memory poolData) internal view returns (ReserveDataBundle memory reserveBundle) {
        ReserveData memory reserveData0 = getReservesAndData(poolData.poolAddressAB, poolData.positionIdAB);
        ReserveData memory reserveData1 = getReservesAndData(poolData.poolAddressBC, poolData.positionIdBC);
        ReserveData memory reserveData2 = getReservesAndData(poolData.poolAddressCA, poolData.positionIdCA);

        reserveBundle = ReserveDataBundle({
            reserves: [
                [reserveData0.reserveA, reserveData0.reserveB],
                [reserveData1.reserveA, reserveData1.reserveB],
                [reserveData2.reserveA, reserveData2.reserveB]
            ],
            sqrtPriceX96: [reserveData0.sqrtPriceX96, reserveData1.sqrtPriceX96, reserveData2.sqrtPriceX96],
            tickLower: [reserveData0.tickLower, reserveData1.tickLower, reserveData2.tickLower],
            tickUpper: [reserveData0.tickUpper, reserveData1.tickUpper, reserveData2.tickUpper],
            liquidity: [reserveData0.liquidity, reserveData1.liquidity, reserveData2.liquidity],
            poolAddresses: [poolData.poolAddressAB, poolData.poolAddressBC, poolData.poolAddressCA] // Reintroducing the pool addresses here
        });
    }


    function sortPools(
        Decimal.D256[3] memory prices,
        PoolData memory poolData
    ) internal pure returns (ArbitrageInfo memory arbInfo) {
        if (compareDecimal(prices[0], prices[1])) {
            if (compareDecimal(prices[0], prices[2])) {
                arbInfo.lowerPool = poolData.poolAddressAB;
                if (compareDecimal(prices[1], prices[2])) {
                    arbInfo.middlePool = poolData.poolAddressBC;
                    arbInfo.higherPool = poolData.poolAddressCA;
                } else {
                    arbInfo.middlePool = poolData.poolAddressCA;
                    arbInfo.higherPool = poolData.poolAddressBC;
                }
            } else {
                arbInfo.lowerPool = poolData.poolAddressCA;
                arbInfo.middlePool = poolData.poolAddressAB;
                arbInfo.higherPool = poolData.poolAddressBC;
            }
        } else {
            if (compareDecimal(prices[1], prices[2])) {
                arbInfo.lowerPool = poolData.poolAddressBC;
                if (compareDecimal(prices[0], prices[2])) {
                    arbInfo.middlePool = poolData.poolAddressAB;
                    arbInfo.higherPool = poolData.poolAddressCA;
                } else {
                    arbInfo.middlePool = poolData.poolAddressCA;
                    arbInfo.higherPool = poolData.poolAddressAB;
                }
            } else {
                arbInfo.lowerPool = poolData.poolAddressCA;
                arbInfo.middlePool = poolData.poolAddressBC;
                arbInfo.higherPool = poolData.poolAddressAB;
            }
        }
    }


   
    function setOrderedReserves( 
        bool baseTokenSmaller,
        ArbitrageInfo memory arbInfo,
        ReserveDataBundle memory reserveBundle,
        address[] memory path  // The path representing the token order
    ) internal pure returns (OrderedReserves memory orderedReserves) {
        
        // Lower, middle, and higher pools correspond to sorted pools from arbInfo
        address lowerPool = arbInfo.lowerPool;
        address middlePool = arbInfo.middlePool;
        address higherPool = arbInfo.higherPool;

        // Determine if the base and quote tokens match the path
        // Determine if the base and quote tokens match the path
        bool isBaseLower = (path[0] == arbInfo.baseToken0 || path[0] == arbInfo.baseToken1 || path[0] == arbInfo.baseToken2);
        bool isBaseMiddle = (path[1] == arbInfo.baseToken0 || path[1] == arbInfo.baseToken1 || path[1] == arbInfo.baseToken2);
        bool isBaseHigher = (path[2] == arbInfo.baseToken0 || path[2] == arbInfo.baseToken1 || path[2] == arbInfo.baseToken2);
        // Log paths and baseToken matches
        

        // Use the arbInfo struct to reference the correct pools
        if (baseTokenSmaller) {
            orderedReserves = OrderedReserves({
                // Lower Pool
                a1: lowerPool == reserveBundle.poolAddresses[0] ? reserveBundle.reserves[0][isBaseLower ? 0 : 1] : (lowerPool == reserveBundle.poolAddresses[1] ? reserveBundle.reserves[1][isBaseLower ? 0 : 1] : reserveBundle.reserves[2][isBaseLower ? 0 : 1]),
                b1: lowerPool == reserveBundle.poolAddresses[0] ? reserveBundle.reserves[0][isBaseLower ? 1 : 0] : (lowerPool == reserveBundle.poolAddresses[1] ? reserveBundle.reserves[1][isBaseLower ? 1 : 0] : reserveBundle.reserves[2][isBaseLower ? 1 : 0]),
                tickLower1: lowerPool == reserveBundle.poolAddresses[0] ? reserveBundle.tickLower[0] : (lowerPool == reserveBundle.poolAddresses[1] ? reserveBundle.tickLower[1] : reserveBundle.tickLower[2]),
                tickUpper1: lowerPool == reserveBundle.poolAddresses[0] ? reserveBundle.tickUpper[0] : (lowerPool == reserveBundle.poolAddresses[1] ? reserveBundle.tickUpper[1] : reserveBundle.tickUpper[2]),
                liquidity1: lowerPool == reserveBundle.poolAddresses[0] ? reserveBundle.liquidity[0] : (lowerPool == reserveBundle.poolAddresses[1] ? reserveBundle.liquidity[1] : reserveBundle.liquidity[2]),

                // Middle Pool
                a2: middlePool == reserveBundle.poolAddresses[0] ? reserveBundle.reserves[0][isBaseMiddle ? 0 : 1] : (middlePool == reserveBundle.poolAddresses[1] ? reserveBundle.reserves[1][isBaseMiddle ? 0 : 1] : reserveBundle.reserves[2][isBaseMiddle ? 0 : 1]),
                b2: middlePool == reserveBundle.poolAddresses[0] ? reserveBundle.reserves[0][isBaseMiddle ? 1 : 0] : (middlePool == reserveBundle.poolAddresses[1] ? reserveBundle.reserves[1][isBaseMiddle ? 1 : 0] : reserveBundle.reserves[2][isBaseMiddle ? 1 : 0]),
                tickLower2: middlePool == reserveBundle.poolAddresses[0] ? reserveBundle.tickLower[0] : (middlePool == reserveBundle.poolAddresses[1] ? reserveBundle.tickLower[1] : reserveBundle.tickLower[2]),
                tickUpper2: middlePool == reserveBundle.poolAddresses[0] ? reserveBundle.tickUpper[0] : (middlePool == reserveBundle.poolAddresses[1] ? reserveBundle.tickUpper[1] : reserveBundle.tickUpper[2]),
                liquidity2: middlePool == reserveBundle.poolAddresses[0] ? reserveBundle.liquidity[0] : (middlePool == reserveBundle.poolAddresses[1] ? reserveBundle.liquidity[1] : reserveBundle.liquidity[2]),

                // Higher Pool
                a3: higherPool == reserveBundle.poolAddresses[0] ? reserveBundle.reserves[0][isBaseHigher ? 0 : 1] : (higherPool == reserveBundle.poolAddresses[1] ? reserveBundle.reserves[1][isBaseHigher ? 0 : 1] : reserveBundle.reserves[2][isBaseHigher ? 0 : 1]),
                b3: higherPool == reserveBundle.poolAddresses[0] ? reserveBundle.reserves[0][isBaseHigher ? 1 : 0] : (higherPool == reserveBundle.poolAddresses[1] ? reserveBundle.reserves[1][isBaseHigher ? 1 : 0] : reserveBundle.reserves[2][isBaseHigher ? 1 : 0]),
                tickLower3: higherPool == reserveBundle.poolAddresses[0] ? reserveBundle.tickLower[0] : (higherPool == reserveBundle.poolAddresses[1] ? reserveBundle.tickLower[1] : reserveBundle.tickLower[2]),
                tickUpper3: higherPool == reserveBundle.poolAddresses[0] ? reserveBundle.tickUpper[0] : (higherPool == reserveBundle.poolAddresses[1] ? reserveBundle.tickUpper[1] : reserveBundle.tickUpper[2]),
                liquidity3: higherPool == reserveBundle.poolAddresses[0] ? reserveBundle.liquidity[0] : (higherPool == reserveBundle.poolAddresses[1] ? reserveBundle.liquidity[1] : reserveBundle.liquidity[2])
            });
        } else {
            orderedReserves = OrderedReserves({
                // Lower Pool
                a1: lowerPool == reserveBundle.poolAddresses[0] ? reserveBundle.reserves[0][isBaseLower ? 1 : 0] : (lowerPool == reserveBundle.poolAddresses[1] ? reserveBundle.reserves[1][isBaseLower ? 1 : 0] : reserveBundle.reserves[2][isBaseLower ? 1 : 0]),
                b1: lowerPool == reserveBundle.poolAddresses[0] ? reserveBundle.reserves[0][isBaseLower ? 0 : 1] : (lowerPool == reserveBundle.poolAddresses[1] ? reserveBundle.reserves[1][isBaseLower ? 0 : 1] : reserveBundle.reserves[2][isBaseLower ? 0 : 1]),
                tickLower1: lowerPool == reserveBundle.poolAddresses[0] ? reserveBundle.tickLower[0] : (lowerPool == reserveBundle.poolAddresses[1] ? reserveBundle.tickLower[1] : reserveBundle.tickLower[2]),
                tickUpper1: lowerPool == reserveBundle.poolAddresses[0] ? reserveBundle.tickUpper[0] : (lowerPool == reserveBundle.poolAddresses[1] ? reserveBundle.tickUpper[1] : reserveBundle.tickUpper[2]),
                liquidity1: lowerPool == reserveBundle.poolAddresses[0] ? reserveBundle.liquidity[0] : (lowerPool == reserveBundle.poolAddresses[1] ? reserveBundle.liquidity[1] : reserveBundle.liquidity[2]),

                // Middle Pool
                a2: middlePool == reserveBundle.poolAddresses[0] ? reserveBundle.reserves[0][isBaseMiddle ? 1 : 0] : (middlePool == reserveBundle.poolAddresses[1] ? reserveBundle.reserves[1][isBaseMiddle ? 1 : 0] : reserveBundle.reserves[2][isBaseMiddle ? 1 : 0]),
                b2: middlePool == reserveBundle.poolAddresses[0] ? reserveBundle.reserves[0][isBaseMiddle ? 0 : 1] : (middlePool == reserveBundle.poolAddresses[1] ? reserveBundle.reserves[1][isBaseMiddle ? 0 : 1] : reserveBundle.reserves[2][isBaseMiddle ? 0 : 1]),
                tickLower2: middlePool == reserveBundle.poolAddresses[0] ? reserveBundle.tickLower[0] : (middlePool == reserveBundle.poolAddresses[1] ? reserveBundle.tickLower[1] : reserveBundle.tickLower[2]),
                tickUpper2: middlePool == reserveBundle.poolAddresses[0] ? reserveBundle.tickUpper[0] : (middlePool == reserveBundle.poolAddresses[1] ? reserveBundle.tickUpper[1] : reserveBundle.tickUpper[2]),
                liquidity2: middlePool == reserveBundle.poolAddresses[0] ? reserveBundle.liquidity[0] : (middlePool == reserveBundle.poolAddresses[1] ? reserveBundle.liquidity[1] : reserveBundle.liquidity[2]),

                // Higher Pool
                a3: higherPool == reserveBundle.poolAddresses[0] ? reserveBundle.reserves[0][isBaseHigher ? 1 : 0] : (higherPool == reserveBundle.poolAddresses[1] ? reserveBundle.reserves[1][isBaseHigher ? 1 : 0] : reserveBundle.reserves[2][isBaseHigher ? 1 : 0]),
                b3: higherPool == reserveBundle.poolAddresses[0] ? reserveBundle.reserves[0][isBaseHigher ? 0 : 1] : (higherPool == reserveBundle.poolAddresses[1] ? reserveBundle.reserves[1][isBaseHigher ? 0 : 1] : reserveBundle.reserves[2][isBaseHigher ? 0 : 1]),
                tickLower3: higherPool == reserveBundle.poolAddresses[0] ? reserveBundle.tickLower[0] : (higherPool == reserveBundle.poolAddresses[1] ? reserveBundle.tickLower[1] : reserveBundle.tickLower[2]),
                tickUpper3: higherPool == reserveBundle.poolAddresses[0] ? reserveBundle.tickUpper[0] : (higherPool == reserveBundle.poolAddresses[1] ? reserveBundle.tickUpper[1] : reserveBundle.tickUpper[2]),
                liquidity3: higherPool == reserveBundle.poolAddresses[0] ? reserveBundle.liquidity[0] : (higherPool == reserveBundle.poolAddresses[1] ? reserveBundle.liquidity[1] : reserveBundle.liquidity[2])
            });
        }
        // Log ordered reserve values
        
    }
    
    function chooseBestPath(
        address[] memory path1, 
        address[] memory path2, 
        address[] memory path3,
        uint256[] memory borrowAmount, 
        PoolData memory poolData
    ) public {
        ArbitrageInfo memory arbInfo;

        // Process and validate each path
        address[][3] memory paths;
        paths[0] = path1;
        paths[1] = path2;
        paths[2] = path3;

        for (uint256 i = 0; i < paths.length; i++) {
            (arbInfo) = processPath(paths[i], borrowAmount[i], poolData);
            if (validateTokenPath(paths[i], arbInfo)) {
                executeSwap(paths[i], borrowAmount[i], poolData.profit1, arbInfo); // Assuming profit is the same structure as borrowAmount
                return; // Exit after executing the first valid path
            }
        }

        // If no paths are valid, revert the transaction
        revert("No valid path found");
    }


    function processPath( 
        address[] memory path,
        uint256 borrowAmount, 
        PoolData memory poolData 
    ) internal returns (ArbitrageInfo memory arbInfo) {
        // Create ArbitrageInfo and OrderedReserves instances
        OrderedReserves memory orderedReserves;
        Decimal.D256[3] memory prices;
        ReserveDataBundle memory reserveBundle; 

        // Determine whether the base token is smaller and retrieve the base token
        (arbInfo) = isBaseTokenSmaller(poolData);
        bool baseTokenSmaller = arbInfo.baseSmaller;
        address baseToken = baseTokenSmaller ? arbInfo.baseToken0 : arbInfo.quoteToken0;

        // Get the ordered reserves and prices from the three pools
        (arbInfo, orderedReserves, prices) = getOrderedReserves(baseTokenSmaller, poolData, path);

        // Allocate borrow amount based on the pool ordering in ArbitrageInfo
        if (arbInfo.lowerPool == poolData.poolAddressAB) {
            poolData.borrowAmount1 = borrowAmount;
        } else if (arbInfo.lowerPool == poolData.poolAddressBC) {
            poolData.borrowAmount2 = borrowAmount;
        } else if (arbInfo.lowerPool == poolData.poolAddressCA) {
            poolData.borrowAmount3 = borrowAmount;
        }

        return arbInfo; // Return both profit and the updated arbInfo
    }


    function validateTokenPath(address[] memory path, ArbitrageInfo memory arbInfo) internal view returns (bool) {
        // Validate token0 and token1 positions for each pool in the arbitrage
        address token0LowerPool = IUniswapV3Pool(arbInfo.lowerPool).token0();
        address token1LowerPool = IUniswapV3Pool(arbInfo.lowerPool).token1();
        
        address token0MiddlePool = IUniswapV3Pool(arbInfo.middlePool).token0();
        address token1MiddlePool = IUniswapV3Pool(arbInfo.middlePool).token1();
        
        address token0HigherPool = IUniswapV3Pool(arbInfo.higherPool).token0();
        address token1HigherPool = IUniswapV3Pool(arbInfo.higherPool).token1();
        
        // Ensure the token path matches the pool's token order (token0 and token1)
        bool isValidPath = (
            // Check lower pool token order
            (path[0] == token0LowerPool || path[0] == token1LowerPool) &&
            // Check middle pool token order
            (path[1] == token0MiddlePool || path[1] == token1MiddlePool) &&
            // Check higher pool token order
            (path[2] == token0HigherPool || path[2] == token1HigherPool)
        );

        return isValidPath;
    }


    function executeSwap(
        address[] memory path, 
        uint256 amountIn, 
        uint256 expectedProfit,
        ArbitrageInfo memory arbInfo
    ) internal {
        
        ReserveDataBundle memory reserveBundle;

        // Set minimum output to ensure profitability (including slippage protection)
        uint256 minOutput = expectedProfit > 0 ? expectedProfit : 1;

        // Assuming reserveBundle has been filled with sqrtPriceX96 values before
        uint160[3] memory sqrtPriceLimits = reserveBundle.sqrtPriceX96;
        
        // Get the debt amount needed for the first swap (borrow amount) using multi-hop and QuoterV2
        uint256 debtAmount  = getAmountInWithQuoterV2MultiHop(amountIn, path);
        PoolAddress.PoolKey memory poolKey = PoolAddress.PoolKey({token0: IUniswapV3Pool(arbInfo.lowerPool).token0(),  token1: IUniswapV3Pool(arbInfo.lowerPool).token1(), fee: uint24(3000)});
       
        //IUniswapV3Pool pool = IUniswapV3Pool(PoolAddress.computeAddress(factory, poolKey));
       require(PoolAddress.computeAddress(factory, poolKey) == arbInfo.lowerPool, "wrong computation");
        //require(arbInfo.lowerPool == poolAdd, "not the same address")
        // Prepare FlashCallbackData for the swap
        FlashCallbackData memory callbackData = FlashCallbackData({
            amount0: arbInfo.baseSmaller ? 0 : debtAmount,  // amount of token0 to borrow
            amount1: arbInfo.baseSmaller ? debtAmount : 0,  // amount of token1 to borrow
            payer: msg.sender,
            poolKey: poolKey,
            poolFee2: uint24(3000),  // Pool fee for the second hop
            poolFee3: uint24(3000),  // Pool fee for the third hop
            path: path,
            Flpool: arbInfo.lowerPool  // Pass the path for multi-hop
        });

        // Set the permissioned pair to the lower pool for callback origin authentication
        permissionedPairAddress = callbackData.Flpool;

        // Perform the flash loan in the lower pool
        IUniswapV3Pool(callbackData.Flpool).flash(
            address(this),                // Recipient of the loan
            callbackData.amount0,         // Amount of token0 to borrow (0 if borrowing token1)
            callbackData.amount1,         // Amount of token1 to borrow (0 if borrowing token0)
            abi.encode(callbackData)      // Pass encoded callback data for Uniswap V3 callback
        );

        

        emit FlashArbitrageExecuted(amountIn, minOutput); // Emit event after initiating swap
    }



    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata data
    ) external override nonReentrant {
        FlashCallbackData memory decoded = abi.decode(data, (FlashCallbackData));

        // Ensure the callback is from the correct pool
        CallbackValidation.verifyCallback(factory, decoded.poolKey);

        address token0 = decoded.poolKey.token0; // Borrowed token (e.g., WMATIC)
        address token1 = decoded.poolKey.token1; // Token1 (e.g., ETH)
        uint256 amount0Owed = LowGasSafeMath.add(decoded.amount0, fee0); // Total owed for token0 (WMATIC)
        uint256 amount1Owed = LowGasSafeMath.add(decoded.amount1, fee1); // Total owed for token1 (ETH), including fee

        uint256 amountIn = decoded.amount0 == 0 ? decoded.amount1 : decoded.amount0;
        address[] memory path = decoded.path;

        uint256 outputAmount = amountIn;
        address currentToken = path[0];

        // Iterate over the swap path
        for (uint256 i = 0; i < path.length - 1; i++) {
            address inputToken = path[i];
            address outputToken = path[i + 1];

            // Perform the swap
            outputAmount = singleSwap(inputToken, outputToken, outputAmount);
            currentToken = outputToken;

            // Check if we reached the last token in the path, which is token1
            if (currentToken == token1) {
                uint256 balanceToken1 = IERC20(token1).balanceOf(address(this));

                // If balance of token1 exceeds amount1Owed, calculate the exact excess
                if (balanceToken1 > amount1Owed) {
                    uint256 excessToken1 = balanceToken1 - amount1Owed;
                    // Swap the excess amount of token1 back to token0
                    outputAmount = BSwap(token1, token0, excessToken1);
                }
                break; // Exit loop since amount1Owed is secured, and excess swapped back to token0
            }
        }

        // Ensure sufficient balance to repay borrowed tokens
        require(IERC20(token0).balanceOf(address(this)) >= amount0Owed, "Insufficient balance to repay token0 debt");
        require(IERC20(token1).balanceOf(address(this)) >= amount1Owed, "Insufficient balance to repay token1 debt");

        // Repay debt for token0 (WMATIC)
        repayWithApproval(token0, amount0Owed);

        // Repay debt for token1 (ETH), including fee
        repayWithApproval(token1, amount1Owed);

        // Calculate profits after repayment
        uint256 finalBalance0 = IERC20(token0).balanceOf(address(this));
        uint256 finalBalance1 = IERC20(token1).balanceOf(address(this));
        uint256 profit0 = finalBalance0 > amount0Owed ? finalBalance0 - amount0Owed : 0;
        uint256 profit1 = finalBalance1 > amount1Owed ? finalBalance1 - amount1Owed : 0;

        // Profit Distribution with Approvals
        if (profit0 > 0) {
            distributeProfit(token0, decoded.payer, profit0);
        }
        if (profit1 > 0) {
            distributeProfit(token1, decoded.payer, profit1);
        }

        permissionedPairAddress = address(1);
        emit FlashArbitrageExecuted(decoded.amount0, outputAmount);
    }

    // Helper function to handle allowance and repayment
    function repayWithApproval(address token, uint256 amountOwed) private {
        if (amountOwed > 0) {
            uint256 allowance = IERC20(token).allowance(address(this), msg.sender);
            if (allowance < amountOwed) {
                TransferHelper.safeApprove(token, msg.sender, amountOwed);
            }
            pay(token, address(this), msg.sender, amountOwed);
        }
    }
    // Helper function to handle profit distribution
    function distributeProfit(address token, address payer, uint256 profit) private {
        uint256 allowance = IERC20(token).allowance(address(this), payer);
        if (allowance < profit) {
            TransferHelper.safeApprove(token, payer, profit);
        }
        pay(token, address(this), payer, profit);
    }

    function BSwap(address inputToken, address outputToken, uint256 amountIn) internal returns (uint256 amountOut) {
        // Ensure approval is in place before performing the swap
        // You must approve the UniswapV3 router to spend the input token on behalf of the contract
        // Check allowance for token1 and approve if necessary
        uint256 Allowance = IERC20(inputToken).allowance(address(this), address(swapRouter));
        if (Allowance < amountIn) {
            TransferHelper.safeApprove(inputToken, address(swapRouter), amountIn);
        }
        // Perform the swap on Uniswap V3 using the provided parameters
        
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
        

        // Return the amount of output token received
        amountOut = IERC20(outputToken).balanceOf(address(this));
    }


    function singleSwap(address inputToken, address outputToken, uint256 amountIn) internal returns (uint256) {
       
        // Check allowance for token1 and approve if necessary
        uint256 Allowance = IERC20(inputToken).allowance(address(this), address(swapRouter));
        if (Allowance < amountIn) {
            TransferHelper.safeApprove(inputToken, address(swapRouter), amountIn);
        }

        // Prepare parameters for the swap directly using the token addresses
        ISwapRouter.ExactInputParams memory params = ISwapRouter.ExactInputParams({
            path: abi.encodePacked(inputToken, uint24(3000), outputToken), // Directly encoding the path with the input and output tokens
            recipient: address(this),
            deadline: block.timestamp + 60, // 1-minute deadline
            amountIn: amountIn,
            amountOutMinimum: 1 // Slippage protection
        });

        // Executes the swap and returns the output amount
        return swapRouter.exactInput(params);
    }


    // Helper function to encode multi-hop path for swaps
    function encodeMultiHopPath(address[] memory path) internal pure returns (bytes memory encodedPath) {
        require(path.length >= 2, "Path must have at least 2 tokens");
        encodedPath = abi.encodePacked(path[0]);

        for (uint256 i = 1; i < path.length; i++) {
            encodedPath = abi.encodePacked(encodedPath, uint24(3000), path[i]); // Assuming 0.3% fee for all hops
        }
    }

    function executeFlashArbitrage(
        address[] memory path1, 
        address[] memory path2, 
        address[] memory path3,
        uint256[] memory borrowAmount,
        PoolData memory poolData
    ) external onlyOwner {
        // Choose the most profitable path for arbitrage
        chooseBestPath(path1, path2, path3, borrowAmount, poolData);
    }
 
    
    // Helper function to use QuoterV2 for multi-hop getAmountIn calculation
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

    // Helper function to use QuoterV2 for multi-hop getAmountOut calculation
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
