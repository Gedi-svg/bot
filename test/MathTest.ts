import lodash from 'lodash';
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { InternalFuncTest } from '../typechain/InternalFuncTest';

const { BigNumber } = ethers;

describe('MathTest', () => {
  let flashBot: InternalFuncTest;

  beforeEach(async () => {
    const factory = await ethers.getContractFactory('InternalFuncTest');
    flashBot = (await factory.deploy()) as InternalFuncTest;
  });

  describe('#calcBorrowAmount', () => {
      it('returns right amount with small liquidity pairs', async () => {
          const reserves = { a1: '5000', b1: '10', a2: '6000', b2: '10', a3: '7000', b3: '10' }; // Add a third pair
          const input = lodash.mapValues(reserves, (v) => ethers.utils.parseEther(v));
          const res = await flashBot._calcBorrowAmount(input);
          // @ts-ignore
          expect(res).to.be.closeTo(ethers.utils.parseEther('4.5'), ethers.utils.parseEther('0.01')); // Expected borrowed amount adjusted
      });

      it('returns right amount with large liquidity pairs', async () => {
          const reserves = { a1: '1200000000', b1: '600000', a2: '1000000000', b2: '300000', a3: '800000000', b3: '200000' }; // Add a third pair
          const input = lodash.mapValues(reserves, (v) => ethers.utils.parseEther(v));
          const res = await flashBot._calcBorrowAmount(input);
          // @ts-ignore
          expect(res).to.be.closeTo(ethers.utils.parseEther('530528.604'), ethers.utils.parseEther('1500')); // Expected borrowed amount adjusted
      });

      it('returns right amount with big difference between liquidity pairs', async () => {
          const reserves = { a1: '12000000', b1: '6000', a2: '1000', b2: '30', a3: '500', b3: '10' }; // Add a third pair
          const input = lodash.mapValues(reserves, (v) => ethers.utils.parseEther(v));
          const res = await flashBot._calcBorrowAmount(input);
          // @ts-ignore
          expect(res).to.be.closeTo(ethers.utils.parseEther('87.29'), ethers.utils.parseEther('0.01')); // Expected borrowed amount adjusted
      });

      it('revert with wrong order input', async () => {
          const reserves = { a1: '1000000000', b1: '300000', a2: '1200000000', b2: '600000', a3: '1400000000', b3: '900000' }; // Add a third pair
          const input = lodash.mapValues(reserves, (v) => ethers.utils.parseEther(v));
          await expect(flashBot._calcBorrowAmount(input)).to.be.revertedWith('Wrong input order');
    });
  });
});
