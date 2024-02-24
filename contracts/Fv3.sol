// SPDX-License-Identifier: MIT
pragma solidity ^0.7.0;
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
import "hardhat/console.sol";

interface IVault {
    // Define the functions and events of the IVault interface here
    // For example:
     function totalAmounts() external view returns (uint256 a, uint256 b, uint256 c);
}

contract FlashArbitrageV3 is Ownable {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    struct OrderedReserves {
        uint256 a; // Token 1
        uint256 b; // Token 2
        uint256 c; // Token 3
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

    // Receive function to receive ETH
    receive() external payable {}

    // Functions to manage base tokens
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

    // Internal function to check if a token is a base token
    function isBaseToken(address token) internal view returns (bool) {
        return EnumerableSet.contains(baseTokens, token);
    }

    // Internal function to get the smaller token in a pair
    function getSmallerToken(address tokenA, address tokenB) internal pure returns (address smallerToken, address largerToken) {
        return tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    function calculateReserves(uint160 sqrtPriceX96, int24 tick) internal view returns (uint256 reserveA, uint256 reserveB) {
        // Calculate price
        uint256 priceX96 = uint256(sqrtPriceX96) ** 2;
        
        // Calculate reserves
        uint256 pow = uint256(tick >= 0 ? tick : -tick) ** 2;
        reserveA = tick > 0 ? (priceX96 * 1e18) / pow : (priceX96 * pow) / 1e18;
        reserveB = tick > 0 ? (priceX96 * pow) / 1e18 : (priceX96 * 1e18) / pow;
    }

    // Internal function to get reserves of a given token pair
    function getReserves(address tokenA, address tokenB) internal view returns (uint256 reserveA, uint256 reserveB) {
        // Get the pair address
        address factory = IPeripheryImmutableState(swapRouter).factory();
        address pair = IUniswapV3Factory(factory).getPool(tokenA, tokenB, 500);

        // Get reserves from the pair
        (uint160 sqrtPriceX96, int24 tick, , , , , ) = IUniswapV3Pool(pair).slot0();
        (reserveA, reserveB) = calculateReserves(sqrtPriceX96, tick);
    }

    // Internal function to calculate the profit
    function calculateProfit(OrderedReserves memory reserves, uint256 gasFee) internal pure returns (uint256) {
        // Calculate the profit as the difference between the reserves of the last pool and the first pool
        // before and after the trade
        uint256 initialReserve = reserves.c;
        uint256 finalReserve = reserves.a;

        // Subtract gas fee from the profit
        uint256 profit = finalReserve > initialReserve ? finalReserve - initialReserve : 0;
        if (profit >= gasFee) {
            profit -= gasFee;
        } else {
            profit = 0; // Ensure profit cannot be negative
        }

        return profit;
    }

    // Function to withdraw accumulated profits
    function withdrawProfit(uint256 amount) external onlyOwner {
        require(amount > 0, "Invalid amount");
        require(amount <= address(this).balance, "Insufficient balance");
        payable(owner()).transfer(amount);
        emit ProfitWithdrawn(owner(), amount);
    }

    function getOrderedReserves(address tokenIn, address tokenOut, address vault) public view returns (OrderedReserves memory orderedReserves) {
        // Initialize Uniswap V3 vault
        IVault vaultInstance = IVault(vault);

        // Retrieve reserves for the vault
        (uint256 a, uint256 b, ) = vaultInstance.totalAmounts();

        // Order the reserves according to the defined struct
        orderedReserves = tokenIn < tokenOut ? OrderedReserves(a, b, 0) : OrderedReserves(0, b, a);

        return orderedReserves;
    }

    // Function to calculate profit for a given pair of tokens
    function getProfit(address token1, address token2, uint256 gasFee, address vault) public view returns (uint256) {
        OrderedReserves memory reserves = getOrderedReserves(token1, token2, vault);
        console.log('profit: ', calculateProfit(reserves, gasFee));
        return calculateProfit(reserves, gasFee);
    }

    function executeFlashArbitrage(
        address tokenA,
        address tokenB,
        address tokenC,
        uint256 amountIn,
        uint256 amountOut,
        uint256 gasFee,
        address vault
    ) public {
        // Perform the flash arbitrage and initiate the trade for the best route
        uint256 profitAB = getProfit(tokenA, tokenB, gasFee, vault);
        uint256 profitBC = getProfit(tokenB, tokenC, gasFee, vault);
        uint256 profitAC = getProfit(tokenA, tokenC, gasFee, vault);

        address[] memory path;
        if (profitAB >= profitBC && profitAB >= profitAC) {
            path = new address[](2);
            path[0] = tokenA;
            path[1] = tokenB;
        } else if (profitBC >= profitAB && profitBC >= profitAC) {
            path = new address[](2);
            path[0] = tokenB;
            path[1] = tokenC;
        } else {
            path = new address[](2);
            path[0] = tokenA;
            path[1] = tokenC; // Default to pathA in case of equal profits or unexpected scenarios
        }

        // Swap tokens using the selected route
        ISwapRouter(swapRouter).exactInputSingle{ value: amountIn }(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenA,
                tokenOut: tokenC,
                fee: 500,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: amountOut,
                sqrtPriceLimitX96: 0
            })
        );
    }
}
