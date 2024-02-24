// SPDX-License-Identifier: Unlicense
pragma solidity ^0.7.0;
pragma abicoder v2;

import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts/token/ERC20/SafeERC20.sol';
import '@openzeppelin/contracts/access/Ownable.sol';
import '@openzeppelin/contracts/utils/EnumerableSet.sol';
import "hardhat/console.sol";

import './interfaces/IUniswapV2Pair.sol';
import './interfaces/IWETH.sol';
import './libraries/Decimal.sol';

struct Reserves {
    uint256 reserve0;
    uint256 reserve1;
}

struct OrderedReserves {
    uint256 a1; // base asset
    uint256 b1;
    uint256 a2;
    uint256 b2;
    uint256 a3; // additional base asset
    uint256 b3;
}

struct ArbitrageInfo {
    address baseToken;
    address quoteToken;
    bool baseTokenSmaller;
    address lowerPool; // pool with lower price, denominated in quote asset
    address higherPool; // pool with higher price, denominated in quote asset
}

struct CallbackData {
    address debtPool;
    address targetPool;
    bool debtTokenSmaller;
    address borrowedToken;
    address debtToken;
    uint256 debtAmount;
    uint256 debtTokenOutAmount;
}

contract FlashBot is Ownable {
    using Decimal for Decimal.D256;
    using SafeMath for uint256;
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    // ACCESS CONTROL
    // Only the `permissionedPairAddress` may call the `uniswapV2Call` function
    address permissionedPairAddress = address(1);

    // WETH on ETH or WBNB on BSC
    address immutable WETH;

    // AVAILABLE BASE TOKENS
    EnumerableSet.AddressSet baseTokens;
    event Log(string message, address sender, uint256 amount0, uint256 amount1, bytes path);
    event Withdrawn(address indexed to, uint256 indexed value);
    event BaseTokenAdded(address indexed token);
    event BaseTokenRemoved(address indexed token);

    constructor(address _WETH) {
        WETH = _WETH;
        baseTokens.add(_WETH);
    }

    receive() external payable {}

    /// @dev Redirect uniswap callback function
    /// The callback function on different DEX are not same, so use a fallback to redirect to uniswapV2Call
    fallback() external {
        revert("Fallback function not supported");
    }

    function withdraw() external {
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

    function addBaseToken(address token) external onlyOwner {
        baseTokens.add(token);
        emit BaseTokenAdded(token);
    }

    function encodeAddresses(address[] memory addresses) internal pure returns (bytes memory) {
        bytes memory data;
        for (uint256 i = 0; i < addresses.length; i++) {
            data = abi.encodePacked(data, addresses[i]);
        }
        return data;
    }


    function removeBaseToken(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            // do not use safe transfer to prevents revert by any shitty token
            IERC20(token).transfer(owner(), balance);
        }
        baseTokens.remove(token);
        emit BaseTokenRemoved(token);
    }

    function getBaseTokens() external view returns (address[] memory tokens) {
        uint256 length = baseTokens.length();
        tokens = new address[](length);
        for (uint256 i = 0; i < length; i++) {
            tokens[i] = baseTokens.at(i);
        }
    }

    function baseTokensContains(address token) public view returns (bool) {
        return baseTokens.contains(token);
    }

    function isbaseTokenSmaller(address pool0, address pool1, address pool2)
        internal
        view
        returns (
            bool baseSmaller,
            address baseToken,
            address quoteToken
        )
    {
        require(pool0 != pool1 && pool1 != pool2 && pool0 != pool2, 'Same pair address');
        (address pool0Token0, address pool0Token1) = (IUniswapV2Pair(pool0).token0(), IUniswapV2Pair(pool0).token1());
        (address pool1Token0, address pool1Token1) = (IUniswapV2Pair(pool1).token0(), IUniswapV2Pair(pool1).token1());
        (address pool2Token0, address pool2Token1) = (IUniswapV2Pair(pool2).token0(), IUniswapV2Pair(pool2).token1());
        require(pool0Token0 < pool0Token1 && pool1Token0 < pool1Token1 && pool2Token0 < pool2Token1, 'Non standard uniswap AMM pair');
        require(
            (pool0Token0 == pool1Token0 && pool0Token1 == pool1Token1) ||
            (pool0Token0 == pool1Token1 && pool0Token1 == pool1Token0),
            'Require same token pair'
        );
        require(
            (pool0Token0 == pool2Token0 && pool0Token1 == pool2Token1) ||
            (pool0Token0 == pool2Token1 && pool0Token1 == pool2Token0),
            'Require same token pair'
        );
        require(baseTokensContains(pool0Token0) || baseTokensContains(pool0Token1), 'No base token in pair');

        (baseSmaller, baseToken, quoteToken) = baseTokensContains(pool0Token0)
            ? (true, pool0Token0, pool0Token1)
            : (false, pool0Token1, pool0Token0);
    }

    /// @dev Compare price denominated in quote token between three pools
    /// We borrow base token by using flash swap from lower price pool and sell them to higher price pool
    function getOrderedReserves(
        address pool0,
        address pool1,
        address pool2,
        bool baseTokenSmaller
    )
        internal
        view
        returns (
            address lowerPool,
            address higherPool,
            OrderedReserves memory orderedReserves
        )
    {
        Reserves memory reserves0 = getReserves(pool0);
        Reserves memory reserves1 = getReserves(pool1);
        Reserves memory reserves2 = getReserves(pool2);

        Decimal.D256 memory price0 = calculatePrice(reserves0, baseTokenSmaller);
        Decimal.D256 memory price1 = calculatePrice(reserves1, baseTokenSmaller);
        Decimal.D256 memory price2 = calculatePrice(reserves2, baseTokenSmaller);

        Decimal.D256 memory minPrice;
        Decimal.D256 memory maxPrice;
        address minPricePool;
        address maxPricePool;

        
        if (price1.lessThan(minPrice)) {
            minPrice = price1;
            minPricePool = pool1;
        } else if (price1.greaterThan(maxPrice)) {
            maxPrice = price1;
            maxPricePool = pool1;
        }
        if (price2.lessThan(minPrice)) {
            minPrice = price2;
            minPricePool = pool2;
        } else if (price2.greaterThan(maxPrice)) {
            maxPrice = price2;
            maxPricePool = pool2;
        }

        lowerPool = minPricePool;
        higherPool = maxPricePool;

        (orderedReserves.a1, orderedReserves.b1) = getReserveValues(reserves0, baseTokenSmaller);
        (orderedReserves.a2, orderedReserves.b2) = getReserveValues(reserves1, baseTokenSmaller);
        (orderedReserves.a3, orderedReserves.b3) = getReserveValues(reserves2, baseTokenSmaller);

        console.log('Borrow from pool:', lowerPool);
        console.log('Sell to pool:', higherPool);

        return (lowerPool, higherPool, orderedReserves);
    }

    function updateMinMaxPrice(
        Decimal.D256 memory price,
        address pool,
        Decimal.D256 memory currentMinPrice,
        Decimal.D256 memory currentMaxPrice,
        address currentMinPricePool,
        address currentMaxPricePool
     ) internal pure returns (
        Decimal.D256 memory newMinPrice,
        Decimal.D256 memory newMaxPrice,
        address newMinPricePool,
        address newMaxPricePool
     ) {
        newMinPrice = currentMinPrice;
        newMaxPrice = currentMaxPrice;
        newMinPricePool = currentMinPricePool;
        newMaxPricePool = currentMaxPricePool;

        if (price.lessThan(currentMinPrice)) {
            newMinPrice = price;
            newMinPricePool = pool;
        } else if (price.greaterThan(currentMaxPrice)) {
            newMaxPrice = price;
            newMaxPricePool = pool;
        }

        return (newMinPrice, newMaxPrice, newMinPricePool, newMaxPricePool);
    }




    function getReserveValues(Reserves memory reserves, bool baseTokenSmaller) internal pure returns (uint256, uint256) {
        return baseTokenSmaller ? (reserves.reserve0, reserves.reserve1) : (reserves.reserve1, reserves.reserve0);
    }


    function uniswapV2Call(
        address sender,
        uint256 amount0,
        uint256 amount1,
        bytes memory data
    ) public {
        // access control
        require(msg.sender == permissionedPairAddress, 'Non permissioned address call');
        require(sender == address(this), 'Not flash swapped');

        address[] memory path = new address[](2);
        uint256[] memory amounts = new uint256[](2);

        (path[0], path[1]) = abi.decode(data, (address, address));
        IUniswapV2Pair pair = IUniswapV2Pair(msg.sender);
        address token0 = pair.token0();
        (uint256 reserve0, uint256 reserve1, ) = pair.getReserves();
        (uint256 amountIn, uint256 amountOut) = token0 == path[0] ? (amount0, amount1) : (amount1, amount0);

        bytes memory encodedPath = encodeAddresses(path);
        emit Log("UniswapV2Call", sender, amount0, amount1, encodedPath);


        require(amounts[0] == 0 && amounts[1] > 0, 'Not borrow');
        CallbackData memory cd = abi.decode(data, (CallbackData));
        if (cd.debtTokenOutAmount > 0) {
            require(amounts[1] == cd.debtTokenOutAmount, 'Invalid debt token amount');
            // do something useful
        }
    }

    function getReserves(address pair) internal view returns (Reserves memory) {
        (uint256 reserve0, uint256 reserve1, ) = IUniswapV2Pair(pair).getReserves();
        return Reserves(reserve0, reserve1);
    }

    function calculatePrice(Reserves memory reserves, bool baseTokenSmaller) internal pure returns (Decimal.D256 memory) {
        if (reserves.reserve0 == 0 || reserves.reserve1 == 0) {
            return Decimal.zero();
        }
        return baseTokenSmaller ? Decimal.ratio(reserves.reserve1, reserves.reserve0) : Decimal.ratio(reserves.reserve0, reserves.reserve1);
    }

    /// @notice Calculate how much profit we can by arbitraging between three pools
    function getProfit(address pool0, address pool1, address pool2) external view returns (uint256 profit, address baseToken) {
        (bool baseTokenSmaller, , ) = isbaseTokenSmaller(pool0, pool1, pool2);
        baseToken = baseTokenSmaller ? IUniswapV2Pair(pool0).token0() : IUniswapV2Pair(pool0).token1();

        (, , OrderedReserves memory orderedReserves) = getOrderedReserves(pool0, pool1, pool2, baseTokenSmaller);

        uint256 borrowAmount = calcBorrowAmount(orderedReserves);
        // borrow quote token on lower price pool,
        uint256 debtAmount = getAmountIn(borrowAmount, orderedReserves.a1, orderedReserves.b1);
        // sell borrowed quote token on higher price pool
        uint256 baseTokenOutAmount = getAmountOut(borrowAmount, orderedReserves.b2, orderedReserves.a2);
        if (baseTokenOutAmount < debtAmount) {
            profit = 0;
        } else {
            profit = baseTokenOutAmount - debtAmount;
        }
    }

    /// @dev calculate the maximum base asset amount to borrow in order to get maximum profit during arbitrage
    function calcBorrowAmount(OrderedReserves memory orderedReserves) internal pure returns (uint256 borrowAmount) {
        // use a part of the minimum balance of the three pairs to make sure we have enough liquidity for arbitrage
        // e.g. if we have 10000 base asset in one pool and 2000 in another, and we know the price ratio is 5:1, we can borrow at most 2000/6 = 333 from the second pool
        // but we have to reserve a part of it as the fee (otherwise the second swap cannot success), so the real amount to borrow is 333 * (1 - fee)
        // finally we use the maximum amount as the real amount to borrow
        uint256 minBalance0 = orderedReserves.a1 < orderedReserves.a2 ? orderedReserves.a1 : orderedReserves.a2;
        uint256 minBalance1 = orderedReserves.a1 < orderedReserves.a3 ? orderedReserves.a1 : orderedReserves.a3;
        uint256 minBalance2 = orderedReserves.a2 < orderedReserves.a3 ? orderedReserves.a2 : orderedReserves.a3;
        uint256 balanceAmount = minBalance0 < minBalance1 ? minBalance0 : minBalance1;
        balanceAmount = balanceAmount < minBalance2 ? balanceAmount : minBalance2;

        Decimal.D256 memory price01 = Decimal.from(orderedReserves.b1).div(orderedReserves.a1);
        Decimal.D256 memory price02 = Decimal.from(orderedReserves.b2).div(orderedReserves.a2);
        Decimal.D256 memory price03 = Decimal.from(orderedReserves.b3).div(orderedReserves.a3);
        Decimal.D256 memory maxPrice = price01.greaterThan(price02) ? price01 : price02;
        maxPrice = maxPrice.greaterThan(price03) ? maxPrice : price03;

        Decimal.D256 memory fee = Decimal.D256(997 * 10**15);

        Decimal.D256 memory maxBorrowRatio = Decimal.D256(9 * 10**17); // 9 * 10^17 = 0.9 // max ratio is 90%
        Decimal.D256 memory realBorrowRatio = maxBorrowRatio.mul(fee);

        Decimal.D256 memory amountToBorrow = maxPrice.mul(realBorrowRatio).mul(Decimal.from(balanceAmount));
        borrowAmount = amountToBorrow.value;
    }

    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256 amountIn) {
        require(amountOut > 0, 'Invalid amountOut');
        require(reserveIn > 0 && reserveOut > 0, 'Invalid reserves');
        amountIn = reserveIn.mul(amountOut) / reserveOut;
    }

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256 amountOut) {
        require(amountIn > 0, 'Invalid amountIn');
        require(reserveIn > 0 && reserveOut > 0, 'Invalid reserves');
        amountOut = reserveOut.mul(amountIn) / reserveIn;
    }
}
