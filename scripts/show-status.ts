import { ethers, run } from 'hardhat';
import { FlashBot } from '../typechain/FlashArbitrageV3';

async function main() {
  await run('compile');
  const flashBot: FlashBot = (await ethers.getContractAt(
    'FlashArbitrageV3',
    '0xadbe79ddac961a2ea340e5595c94d67675c0b1b7' // contract address
  )) as FlashArbitrageV3;

  const owner = await flashBot.owner();
  console.log(`Owner: ${owner}`);

  const tokens = await flashBot.getBaseTokens();
  console.log('Base tokens: ', tokens);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
