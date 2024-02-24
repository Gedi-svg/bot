import { ethers } from 'hardhat';
import { FlashArbitrage } from '../typechain/FlashArbitrage';
import { expect } from 'chai';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { IUniswapV2Factory } from '../typechain/IUniswapV2Factory';
describe('Flash Arbitrage', function () {
  let flashContract: FlashArbitrage;
  let signer: SignerWithAddress;
  let uniswapFactory: IUniswapV2Factory;

  const WMATIC = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';
  const UNI = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984'; // Example token address
  const ETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'; // Example token address
  const USDT = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984'; // Example token address
  const uniRout = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff';
  
  before(async function () {
    [signer] = await ethers.getSigners();
    const FlashContract = await ethers.getContractFactory('FlashArbitrage');
    flashContract = (await FlashContract.deploy(WMATIC, uniRout)) as FlashArbitrage;
    console.log("Contract deployed to address:", flashContract.address);
    uniswapFactory = await ethers.getContractAt('IUniswapV2Factory', '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f'); 
  });
  
  
  it('should add and remove base tokens correctly', async function () {
    // Add a new base token
    const newToken = '0x0000000000000000000000000000000000000001';
    await flashContract.addBaseToken(newToken);
    let baseTokens = await flashContract.getBaseTokens();
    expect(baseTokens).to.include(newToken);

    // Remove the newly added base token
    await flashContract.removeBaseToken(newToken);
    baseTokens = await flashContract.getBaseTokens();
    expect(baseTokens).to.not.include(newToken);
  });

  it('should revert if trying to perform flash arbitrage with invalid token paths', async function () {
    // Prepare invalid token paths
    const invalidPathA = [WMATIC, USDT, ETH]; // Missing last token
    const invalidPathB = [USDT, ETH, UNI];  // Missing WETH as the first token
    const gasFee = 100;
    const amountIn = 1000;  

    // Execute flash arbitrage with invalid token paths and expect it to revert
    await expect(flashContract.executeFlashArbitrage(USDT, ETH, UNI, amountIn, invalidPathA, invalidPathB, gasFee)).to.be.reverted;
  });

  it('should revert if trying to perform flash arbitrage with insufficient input amount', async function () {
    // Prepare token paths for a scenario
    const path = [WMATIC ,USDT, ETH, UNI];
    const gasFee = 100;
    const insufficientAmountIn = 10; // Insufficient amount to trigger flash arbitrage

    // Execute flash arbitrage with insufficient input amount and expect it to revert
    await expect(flashContract.executeFlashArbitrage(USDT, ETH, UNI, insufficientAmountIn, path, path, gasFee)).to.be.reverted;
  });

  it('should calculate profit correctly', async function () {
    // Get the list of base tokens
    const baseTokens = await flashContract.getBaseTokens();
    console.log('Base Tokens:', baseTokens);
    // Iterate over each token pair
    for (const tokenA of baseTokens) {
      for (const tokenB of baseTokens) {
        if (tokenA === tokenB) continue;

        // Get reserves of the token pair
        const gasFee = 100; // Example gas fee
        const profit = await flashContract.getProfit(tokenA, tokenB, gasFee);
        console.log('Profit for pair ${tokenA}, ${tokenB}: ${profit}');
        
        // Assert that the calculated profit is greater than or equal to zero
        expect(profit).to.be.gt(0);
      }
    }
  });

  it('should execute flash arbitrage correctly', async function () {
    // Prepare token paths for two scenarios
    const pathA = [WMATIC, USDT, ETH, UNI];
    const pathB = [WMATIC, UNI, ETH];

    const gasFee = 100; // Example gas fee

    // Get the pair addresses for each token pair
    const pairAddressAB = await uniswapFactory.getPair(USDT, ETH);
    const pairAddressBC = await uniswapFactory.getPair(ETH, UNI);
    const pairAddressAC = await uniswapFactory.getPair(USDT, UNI);

    // Get the reserves of the token pairs
    const reservesAB = await flashContract.getOrderedReserves(USDT, ETH, pairAddressAB);
    const reservesBC = await flashContract.getOrderedReserves(ETH, UNI, pairAddressBC);
    const reservesAC = await flashContract.getOrderedReserves(USDT, UNI, pairAddressAC);
    
    // Calculate the amount to borrow for each scenario
    const amountInAB = await flashContract.calcBorrowAmount(reservesAB);
    const amountInBC = await flashContract.calcBorrowAmount(reservesBC);
    const amountInAC = await flashContract.calcBorrowAmount(reservesAC);

    // Execute flash arbitrage for scenario A
    await flashContract.executeFlashArbitrage(USDT, ETH, UNI, amountInAB, pathA, pathB, gasFee);
    // Add assertions to verify the outcome of flash arbitrage for scenario A
    // For example, you can check token balances or emitted events

    // Execute flash arbitrage for scenario B
    await flashContract.executeFlashArbitrage(ETH, UNI, USDT, amountInBC, pathB, pathA, gasFee);
    // Add assertions to verify the outcome of flash arbitrage for scenario B

    // Execute flash arbitrage for scenario C
    await flashContract.executeFlashArbitrage(USDT, UNI, ETH, amountInAC, pathA, pathB, gasFee);
    // Add assertions to verify the outcome of flash arbitrage for scenario C
  });
});
