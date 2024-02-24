import { Contract } from '@ethersproject/contracts';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { ethers, waffle } from 'hardhat';
import { Flash } from '../typechain/Flash';
import { IWETH } from '../typechain/IWETH';
import {combinationsPolygon} from '../combinations-polygon';
describe('Flashswap', () => {
  let weth: IWETH;
  let flashBot: Flash;

  const WMATIC = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';
  const BUSD =  '0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39';


  beforeEach(async () => {
    const wethFactory = (await ethers.getContractAt('IWETH', WMATIC)) as IWETH;
    weth = wethFactory.attach(WMATIC) as IWETH;

    const fbFactory = await ethers.getContractFactory('Flash');
    flashBot = (await fbFactory.deploy(WMATIC)) as Flash;
  });

  describe('flash swap arbitrage', () => {
    let signer: SignerWithAddress;

    const uniFactoryAbi = ['function getPair(address, address) view returns (address pair)'];
    const uniPairAbi = ['function sync()'];

    const quickFactoryAddr = '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32';
    const quickFactory = new ethers.Contract(quickFactoryAddr, uniFactoryAbi, waffle.provider);
    let quickPairAddr: any;
    let quickPair: Contract;

    const apeFactoryAddr = '0xCf083Be4164828f00cAE704EC15a36D711491284';
    const apeFactory = new ethers.Contract(apeFactoryAddr, uniFactoryAbi, waffle.provider);
    let apePairAddr: any;

    before(async () => {
      [signer] = await ethers.getSigners();
      quickPairAddr = await quickFactory.getPair(WMATIC, BUSD);
      quickPair = new ethers.Contract(quickPairAddr, uniPairAbi, waffle.provider);
      apePairAddr = await apeFactory.getPair(WMATIC, BUSD);
    });

    it('do flash swap between Pancake and MDEX', async () => {
      // transfer 100000 to mdex pair
      const amountEth = ethers.utils.parseEther('100000');
      await weth.deposit({ value: amountEth });
      await weth.transfer(quickPairAddr, amountEth);
      await quickPair.connect(signer).sync();
      const balanceBefore = await ethers.provider.getBalance(flashBot.address);
      await flashBot.flashArbitrage(quickPairAddr, apePairAddr)
      const balanceAfter = await ethers.provider.getBalance(flashBot.address);
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it('calculate how much profit we get', async () => {
      // transfer 100000 to mdex pair
      const amountEth = ethers.utils.parseEther('100000');
      await weth.deposit({ value: amountEth });
      await weth.transfer(quickPairAddr, amountEth);
      await quickPair.connect(signer).sync();
      const res = await flashBot.getProfit(quickPairAddr, apePairAddr);
      expect(res.baseToken).to.be.eq(WMATIC);
    });

    it('revert if callback is called from address without permission', async () => {
      await expect(
        flashBot.uniswapV2Call(flashBot.address, ethers.utils.parseEther('1'), 0, '0xabcd')
      ).to.be.revertedWith('Non permissioned address call');
    });
  });
});