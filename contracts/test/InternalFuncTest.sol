// SPDX-License-Identifier: MIT
pragma solidity ^0.7.6;
pragma abicoder v2;

import "../Fv3.sol";

contract InternalFuncTest is FlashArbitrageV3 {
    constructor(
        address _WETH,
        address _swapRouter,
        address _nonfungiblePositionManager
    )
        FlashArbitrageV3(_WETH, _swapRouter, _nonfungiblePositionManager)
    {}

    // Expose internal functions as public for testing

    function _calculateReserves(uint160 sqrtPriceX96, uint128 liquidity)
        public
        pure
        returns (uint256 reserveA, uint256 reserveB)
    {
        return calculateReserves(sqrtPriceX96, liquidity);
    }

    function _getReserves(address poolAddress, uint256 positionId)
        public
        view
        returns (uint256 reserveA, uint256 reserveB)
    {
        return getReserves(poolAddress, positionId);
    }

    function _calculateProfit(
        uint256 reserveA,
        uint256 reserveB,
        uint256 reserveC,
        uint256 gasFee,
        uint256 borrowAmount
    ) public pure returns (uint256) {
        return calculateProfit(reserveA, reserveB, reserveC, gasFee, borrowAmount);
    }

    function _chooseBestPath(
        address[] memory path1,
        address[] memory path2,
        address[] memory path3,
        PoolData memory poolData
    ) public {
        chooseBestPath(path1, path2, path3, poolData);
    }

    function _getOrderedReserves(
        address tokenIn,
        address tokenOut,
        PoolData memory poolData
    )
        public
        view
        returns (uint256, uint256, uint256)
    {
        return getOrderedReserves(tokenIn, tokenOut, poolData);
    }
}
