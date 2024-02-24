import { ethers } from 'hardhat';
import { FlashArbitrage } from '../typechain/FlashArbitrage';
import { IWETH } from '../typechain/IWETH';
import { Network, tryLoadCombinations, getTokens, TokenCombination } from './Toke';
import { getMaticPrice } from './basetoken-price';
import log from './log';
import config from './config';

interface ArbitrageFunction {
  (tokenCombination: TokenCombination): Promise<void>;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


async function calcNetProfit(profitWei: ethers.BigNumber, address: string, baseTokens: Tokens): Promise<number> {
  let price = 1;
  if (baseTokens.wmatic.address == address) {
    price = await getMaticPrice();
  }
  let profit = parseFloat(ethers.utils.formatEther(profitWei));
  profit = profit * price;

  const gasCost = price * parseFloat(ethers.utils.formatEther(config.gasPrice)) * (config.gasLimit as number);
  return profit - gasCost;
}

function arbitrageFunc(flashContract: FlashArbitrage, baseTokens: Tokens): ArbitrageFunction {
  return async function arbitrage(tokenCombination: TokenCombination) {
    const { symbols, addresses } = tokenCombination;

    let res: [ethers.BigNumber, string] & {
      profit: ethers.BigNumber;
      baseToken: string;
    };
    try {
      res = await flashContract.getProfit(addresses[0], addresses[1], addresses[2]);
      log.debug(`Profit on ${symbols}: ${ethers.utils.formatEther(res.profit)}`);
    } catch (err) {
      log.debug(err);
      return;
    }

    if (res.profit.gt(ethers.BigNumber.from('0'))) {
      const netProfit = await calcNetProfit(res.profit, res.baseToken, baseTokens);
      if (netProfit < config.minimumProfit) {
        return;
      }

      log.info(`Calling flash arbitrage for ${symbols}, net profit: ${netProfit}`);
      try {
        // lock to prevent tx nonce overlap
        const response = await flashContract.flashArbitrage(addresses[0], addresses[1], addresses[2], {
          gasPrice: config.gasPrice,
          gasLimit: config.gasLimit,
        });
        const receipt = await response.wait(1);
        log.info(`Tx: ${receipt.transactionHash}`);
      } catch (err) {
        if (err.message === 'Too much pending tasks' || err.message === 'async-lock timed out') {
          return;
        }
        log.error(err);
      }
    }
  };
}

async function main() {
  const combinations = await tryLoadCombinations(Network.POLYGON);
  const flashContract = (await ethers.getContractAt('FlashArbitrage', config.contractAddr)) as FlashArbitrage;
  const [baseTokens] = getTokens(Network.POLYGON);

  log.info('Start arbitraging');
  while (true) {
    await Promise.all(
      combinations.map(async (combination) => {
        const arbitrage = arbitrageFunc(flashContract, baseTokens);
        await arbitrage(combination);
      })
    );
    await sleep(1000);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log.error(err);
    process.exit(1);
  });
