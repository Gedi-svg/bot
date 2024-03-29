import { ethers, run } from 'hardhat';

import deployer from '../.secret';

// WBNB address on BSC, WETH address on ETH
const WmaticAddr = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';
const uniRout = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff';


async function main() {
  await run('compile');
  const FlashBot = await ethers.getContractFactory('FlashArbitrage');
  const flashBot = await FlashBot.deploy(WmaticAddr, uniRout);

  console.log(`FlashBot deployed to ${flashBot.address}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
