// SPDX-License-Identifier: MIT
pragma solidity 0.7.6;
pragma abicoder v2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";
import "@uniswap/v3-periphery/contracts/interfaces/IPeripheryImmutableState.sol";
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";


contract FlashArbitrageV3 is Ownable {
    using SafeERC20 for IERC20;

    struct PoolData {
        address poolAddressAB;
        address poolAddressBC;
        address poolAddressCA;
        uint256 positionIdAB;
        uint256 positionIdBC;
        uint256 positionIdCA;
        uint256 borrowAmount;
        uint256 profit1;
        uint256 profit2;
        uint256 profit3;
    }

    address immutable WETH;
    address immutable swapRouter;
    address immutable nonfungiblePositionManager;

    EnumerableSet.AddressSet private baseTokens;

    event Withdrawn(address indexed to, uint256 indexed value);
    event BaseTokenAdded(address indexed token);
    event BaseTokenRemoved(address indexed token);
    event FlashArbitrageExecuted(uint256 amountIn, uint256 amountOut);
    event ProfitWithdrawn(address indexed recipient, uint256 amount);

    constructor(address _WETH, address _swapRouter, address _nonfungiblePositionManager) {
        WETH = _WETH;
        swapRouter = _swapRouter;
        nonfungiblePositionManager = _nonfungiblePositionManager;
        EnumerableSet.add(baseTokens, _WETH);
    }

    receive() external payable {}

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

    function getReserves(address poolAddress, uint256 positionId) internal view returns (uint256 reserveA, uint256 reserveB) {
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(poolAddress).slot0();
        (uint128 liquidity, , ) = getPositionDetails(positionId);
        return calculateReserves(sqrtPriceX96, liquidity);
    }

    function getOrderedReserves(
        address tokenIn,
        address tokenOut,
        PoolData memory poolData
    ) 
        public 
        view 
        returns (uint256, uint256, uint256) 
    {
        (uint256 reserveA1, uint256 reserveB1) = getReserves(poolData.poolAddressAB, poolData.positionIdAB);
        (uint256 reserveB2, uint256 reserveC2) = getReserves(poolData.poolAddressBC, poolData.positionIdBC);
        (uint256 reserveC3, uint256 reserveA3) = getReserves(poolData.poolAddressCA, poolData.positionIdCA);

        return (reserveA1, reserveB2, reserveC2); // Consolidated return
    }

    function calculateProfit(
        uint256 reserveA,
        uint256 reserveB,
        uint256 reserveC,
        uint256 gasFee,
        uint256 borrowAmount
    ) public pure returns (uint256) {
        uint256 profit;
        assembly {
            if gt(reserveA, reserveC) {
                profit := sub(sub(sub(reserveA, reserveC), gasFee), borrowAmount)
            }
        }
        return profit > 0 ? profit : 0;
    }

    function executeSwap(address[] memory path, uint256 amountIn, uint256 amountOut) internal {
        ISwapRouter(swapRouter).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: path[0],
                tokenOut: path[1],
                fee: 3000,
                recipient: address(this),
                deadline: block.timestamp + 15,
                amountIn: amountIn,
                amountOutMinimum: amountOut,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function chooseBestPath(
        address[] memory path1,
        address[] memory path2,
        address[] memory path3,
        PoolData memory poolData
    ) public {
        (uint256 reserveA1, uint256 reserveB1, uint256 reserveC1) = getOrderedReserves(path1[0], path1[1], poolData);
        (uint256 reserveA2, uint256 reserveB2, uint256 reserveC2) = getOrderedReserves(path2[0], path2[1], poolData);
        (uint256 reserveA3, uint256 reserveB3, uint256 reserveC3) = getOrderedReserves(path3[0], path3[1], poolData);

        poolData.profit1 = calculateProfit(reserveA1, reserveB1, reserveC1, 10, poolData.borrowAmount);
        poolData.profit2 = calculateProfit(reserveA2, reserveB2, reserveC2, 10, poolData.borrowAmount);
        poolData.profit3 = calculateProfit(reserveA3, reserveB3, reserveC3, 10, poolData.borrowAmount);

        if (poolData.profit1 >= poolData.profit2 && poolData.profit1 >= poolData.profit3) {
            executeSwap(path1, poolData.borrowAmount, poolData.profit1);
        } else if (poolData.profit2 >= poolData.profit1 && poolData.profit2 >= poolData.profit3) {
            executeSwap(path2, poolData.borrowAmount, poolData.profit2);
        } else {
            executeSwap(path3, poolData.borrowAmount, poolData.profit3);
        }
    }

    function executeFlashArbitrage(
        address[] memory path1,
        address[] memory path2,
        address[] memory path3,
        uint256 amountIn,
        PoolData memory poolData
    ) external {
        poolData.borrowAmount = amountIn;
        chooseBestPath(path1, path2, path3, poolData);

        emit FlashArbitrageExecuted(amountIn, poolData.profit1 >= poolData.profit2 && poolData.profit1 >= poolData.profit3 ? poolData.profit1 : poolData.profit2 >= poolData.profit1 && poolData.profit2 >= poolData.profit3 ? poolData.profit2 : poolData.profit3);
    }

    function withdrawProfit(address payable recipient, uint256 amount) external onlyOwner {
        require(amount <= address(this).balance, "Insufficient balance");
        recipient.transfer(amount);
        emit ProfitWithdrawn(recipient, amount);
    }

    function withdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        payable(owner()).transfer(balance);
        emit ProfitWithdrawn(owner(), balance);
    }
}
