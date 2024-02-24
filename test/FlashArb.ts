import { ethers } from 'hardhat';
import { FlashArbitrage } from '../typechain/FlashArbitrage';
import { expect } from 'chai';

describe('FlashArbitrage', function () {
  let flashContract: FlashArbitrage;
  let owner;
 
  const WETH = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';
  const uniswapRouter = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff';
  const USDT = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';
  const ETH = '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619';
  const UNI = '0xb33eaad8d922b1083446dc23f610c2567fb5180f';
  const gasFee = ethers.utils.parseUnits('10', 'gwei');
  const amountIn = 1000; // Amount to trade in tokenA

  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    const FlashContract = await ethers.getContractFactory('FlashArbitrage');
    flashContract = await FlashContract.deploy(WETH, uniswapRouter) as FlashArbitrage;
    await flashContract.deployed();
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

  it('should calculate profit correctly', async function () {
    // Mock reserves for the token pairs
    const reserves = {
      [USDT]: {
        [ETH]: 1000, // Mock reserves for tokenA-tokenB pair
        [UNI]: 2000, // Mock reserves for tokenA-tokenC pair
      },
      [ETH]: {
        [UNI]: 3000, // Mock reserves for tokenB-tokenC pair
      },
    };

    // Calculate profits for all token pairs
    for (const [tokenX, tokenYReserves] of Object.entries(reserves)) {
      for (const [tokenY, reserve] of Object.entries(tokenYReserves)) {
        const profit = await flashContract.getProfit(tokenX, tokenY, gasFee);
        const expectedProfit = tokenX < tokenY ? reserves[tokenX][tokenY] : 0; // Assuming tokenX is always less than tokenY
        expect(profit).to.equal(expectedProfit);
      }
    }
  });

 it('should perform flash arbitrage correctly', async function () {
    // Prepare token paths for two scenarios
    const pathA = [WETH, USDT, ETH, UNI];
    const pathB = [WETH, UNI, ETH];

    // Execute flash arbitrage for scenario A
    await flashContract.executeFlashArbitrage(USDT, ETH, UNI, amountIn, pathA, pathB, gasFee);
    // Add assertions to verify the outcome of flash arbitrage for scenario A

    // Check the token balances after the flash arbitrage for scenario A
    const usdtBalanceAfterA = await usdt.balanceOf(flashContract.address);
    const uniBalanceAfterA = await uni.balanceOf(flashContract.address);
    const ethBalanceAfterA = await eth.balanceOf(flashContract.address);
    // Assert that the token balances are as expected
    expect(usdtBalanceAfterA).to.equal(0); // USDT balance should be 0 after the flash arbitrage
    expect(uniBalanceAfterA).to.equal(0); // UNI balance should be 0 after the flash arbitrage
    expect(ethBalanceAfterA).to.equal(0); // ETH balance should be 0 after the flash arbitrage
    // You can also check emitted events or any other relevant state changes

    // Execute flash arbitrage for scenario B
    await flashContract.executeFlashArbitrage(UNI, ETH, USDT, amountIn, pathB, pathA, gasFee);
    // Add assertions to verify the outcome of flash arbitrage for scenario B

    // Check the token balances after the flash arbitrage for scenario B
    const usdtBalanceAfterB = await usdt.balanceOf(flashContract.address);
    const uniBalanceAfterB = await uni.balanceOf(flashContract.address);
    const ethBalanceAfterB = await eth.balanceOf(flashContract.address);
    // Assert that the token balances are as expected
    expect(usdtBalanceAfterB).to.equal(0); // USDT balance should be 0 after the flash arbitrage
    expect(uniBalanceAfterB).to.equal(0); // UNI balance should be 0 after the flash arbitrage
    expect(ethBalanceAfterB).to.equal(0); // ETH balance should be 0 after the flash arbitrage
    // You can also check emitted events or any other relevant state changes
});

  it('should revert if trying to perform flash arbitrage with invalid token paths', async function () {
    // Prepare invalid token paths
    const invalidPathA = [WETH, USDT, ETH]; // Missing last token
    const invalidPathB = [USDT, ETH, UNI]; // Missing WETH as the first token

    // Execute flash arbitrage with invalid token paths and expect it to revert
    await expect(flashContract.executeFlashArbitrage(USDT, ETH, UNI, amountIn, invalidPathA, invalidPathB)).to.be.reverted;
  });

  it('should revert if trying to perform flash arbitrage with insufficient input amount', async function () {
    // Prepare token paths for a scenario
    const path = [WETH,USDT, ETH, UNI];
    const insufficientAmountIn = 10; // Insufficient amount to trigger flash arbitrage

    // Execute flash arbitrage with insufficient input amount and expect it to revert
    await expect(flashContract.executeFlashArbitrage(USDT, ETH, UNI, insufficientAmountIn, path, path)).to.be.reverted;
  });
  // Add more test cases as needed

});
