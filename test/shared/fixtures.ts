import { ethers } from 'hardhat';
import { TestERC20 } from '../../typechain/TestERC20';
import { Flash } from '../../typechain/Flash';

interface FlashBotFixture {
  weth: TestERC20;
  flashBot: Flash;
}

export const flashBotFixture = async (): Promise<FlashBotFixture> => {
  const flashBotFactory = await ethers.getContractFactory('Flash');
  const tokenFactory = await ethers.getContractFactory('TestERC20');

  const weth = (await tokenFactory.deploy('Weth', 'WETH')) as TestERC20;
  const flashBot = (await flashBotFactory.deploy(weth.address)) as Flash;

  return { weth, flashBot };
};
