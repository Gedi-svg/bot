import { ethers } from 'hardhat';
import { FlashBot } from '../typechain/FlashBot';

async function main(token: string) {
  const [signer] = await ethers.getSigners();
  const flashBot: FlashBot = (await ethers.getContractAt(
    'FlashBot',
    '0xB0682a5F51AE7A5E598DE992E7e72a30C5FB24e0', // your contract address
    signer
  )) as FlashBot;

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
