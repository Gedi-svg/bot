import { ethers } from 'hardhat';
import { FlashArbitrageV3 } from '../typechain/FlashArbitrageV3';

async function main(token: string) {
  const [signer] = await ethers.getSigners();
  const flashBot: FlashArbitrageV3 = (await ethers.getContractAt(
    'FlashArbitrageV3',
    '0xadbe79ddac961a2ea340e5595c94d67675c0b1b7', // your contract address
    signer
  )) as FlashArbitrageV3;

  await flashBot.addBaseToken(token);
  console.log(`Base token added: ${token}`);
}

const args = process.argv.slice(2);

main(args[0])
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
