pragma solidity ^0.7.0;
pragma abicoder v2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import "@uniswap/v2-core/contracts/interfaces/IUniswapV2Factory.sol";
import "hardhat/console.sol";
contract FlashArbitrage is Ownable {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    struct OrderedReserves {
        uint256 a; // Token 1
        uint256 b; // Token 2
        uint256 c; // Token 3
    }

    address immutable WETH;
    address immutable uniswapRouter;

    EnumerableSet.AddressSet private baseTokens;

    event Withdrawn(address indexed to, uint256 indexed value);
    event BaseTokenAdded(address indexed token);
    event BaseTokenRemoved(address indexed token);
    event FlashArbitrageExecuted(uint256 amountIn, uint256 amountOut);
    event ProfitWithdrawn(address indexed recipient, uint256 amount);

    constructor(address _WETH, address _uniswapRouter) {
        WETH = _WETH;
        uniswapRouter = _uniswapRouter;
        baseTokens.add(_WETH);


    }

    // Receive function to receive ETH
    receive() external payable {}

    // Functions to manage base tokens
    function addBaseToken(address token) external onlyOwner {
       baseTokens.add(token);
       emit BaseTokenAdded(token);
    }

    function removeBaseToken(address token) external onlyOwner {
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

    // Internal function to check if a token is a base token
    function isBaseToken(address token) internal view returns (bool) {
        return baseTokens.contains(token);
    }

    // Internal function to get the smaller token in a pair
    function getSmallerToken(address tokenA, address tokenB) internal pure returns (address smallerToken, address largerToken) {
        return tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    // Internal function to get reserves of a given token pair
    function getReserves(address tokenA, address tokenB) internal view returns (uint256 reserveA, uint256 reserveB) {
        // Get the pair address
        address pair = IUniswapV2Factory(IUniswapV2Router02(uniswapRouter).factory()).getPair(tokenA, tokenB);
        require(pair != address(0), "Pair not found");

        // Get reserves from the pair
        (uint256 reserve0, uint256 reserve1, ) = IUniswapV2Pair(pair).getReserves();

        // Determine which reserve is for tokenA and tokenB
        (reserveA, reserveB) = tokenA < tokenB ? (reserve0, reserve1) : (reserve1, reserve0);
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

    function getOrderedReserves(address tokenIn, address tokenOut, address pair) public view returns (OrderedReserves memory orderedReserves) {
        // Initialize Uniswap V2 pair
        IUniswapV2Pair pairInstance = IUniswapV2Pair(pair);

        // Retrieve reserves for the pair
        (uint256 a, uint256 b, ) = pairInstance.getReserves();

        // Order the reserves according to the defined struct
        orderedReserves = tokenIn < tokenOut ? OrderedReserves(a, b, 0) : OrderedReserves(0, b, a);

        return orderedReserves;
    }
    // Function to calculate profit for a given pair of tokens
    function getProfit(address token1, address token2, uint256 gasFee) public view returns (uint256) {
        address pair = IUniswapV2Factory(IUniswapV2Router02(uniswapRouter).factory()).getPair(token1, token2);
        OrderedReserves memory reserves = getOrderedReserves(token1, token2, pair);
        
        console.log('profit: ', calculateProfit(reserves, gasFee));
        return calculateProfit(reserves, gasFee);
    }

    function executeFlashArbitrage(
        address tokenA,
        address tokenB,
        address tokenC,
        uint256 amountIn,
        address[] memory pathA,
        address[] memory pathB,
        uint256 gasFee
    ) public {
        // Perform the flash loan and initiate the trade for the best route
        uint256 profitAB = getProfit(tokenA, tokenB, gasFee);
        uint256 profitBC = getProfit(tokenB, tokenC, gasFee);
        uint256 profitAC = getProfit(tokenA, tokenC, gasFee);
        
        address[] memory path;
        if (profitAB >= profitBC && profitAB >= profitAC) {
            path = pathA;
        } else if (profitBC >= profitAB && profitBC >= profitAC) {
            path = pathB;
        } else {
            path = pathA; // Default to pathA in case of equal profits or unexpected scenarios
        }

        // Swap tokens using the selected route
        IUniswapV2Router02(uniswapRouter).swapExactTokensForTokens(
            amountIn,
            0,
            path,
            address(this),
            block.timestamp
        );
    }


    // Internal function to get reserves and ordered reserves
    

    // Internal function to calculate the amount to borrow
    function calcBorrowAmount(OrderedReserves memory reserves) public pure returns (uint256 amount) {
        // Calculate the optimal amount to borrow for flash arbitrage
        uint256 maxReserveAmount = reserves.a > reserves.b ? reserves.a : reserves.b;
        maxReserveAmount = maxReserveAmount > reserves.c ? maxReserveAmount : reserves.c;
        
        return maxReserveAmount;
    }

    // Internal function to calculate the quadratic coefficients
    function calculateQuadraticCoefficients(OrderedReserves memory reserves, uint256 d) internal pure returns (int256 a, int256 b, int256 c) {
        // Define constants
        int256 A = int256(reserves.a) * int256(reserves.b);
        int256 B = int256(reserves.b) * int256(reserves.c);
        int256 C = int256(reserves.a) * int256(reserves.c);

        // Calculate quadratic coefficients
        a = A + B + C;
        b = int256(d) * (A + B + C) * int256(3);
        c = int256(d) * int256(d) * A;

        return (a, b, c);
    }

    // Internal function to calculate solutions for quadratic equation
    function calcSolutionForQuadratic(int256 a, int256 b, int256 c) internal pure returns (int256 x1, int256 x2) {
        // Calculate discriminant
        int256 discriminant = b * b - 4 * a * c;

        // Calculate solutions
        if (discriminant >= 0) {
            int256 sqrtDiscriminant = int256(sqrt(uint256(discriminant)));
            x1 = (-b + sqrtDiscriminant) / (2 * a);
            x2 = (-b - sqrtDiscriminant) / (2 * a);
        } else {
            // Complex roots, set both to zero
            x1 = 0;
            x2 = 0;
        }

        return (x1, x2);
    }

    // Internal square root function for integers
    function sqrt(uint256 x) internal pure returns (uint256 y) {
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
