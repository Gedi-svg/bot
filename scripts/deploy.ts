import { ethers, run } from 'hardhat';

import deployer from '../.secret';

// WBNB address on BSC, WETH address on ETH
const WmaticAddr = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';
const uniRout = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const posman = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';

async function main() {
  await run('compile');
  const FlashBot = await ethers.getContractFactory('FlashArbitrageV3');
  const flashBot = await FlashBot.deploy(WmaticAddr, uniRout, posman, {gasLimit: 2000000});

  console.log(`FlashBot deployed to ${flashBot.address}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
