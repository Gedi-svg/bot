import fs from 'fs';
import path from 'path';
import lodash from 'lodash';
import { Contract } from '@ethersproject/contracts';
import { ethers } from 'hardhat';

import log from './log';

export enum Network {
  POLYGON = 'polygon',
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const polygonBaseTokens: Tokens = {
  wmatic: { symbol: 'WMATIC', address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270' },
  usdt: { symbol: 'USDT', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' },
  usdc: { symbol: 'USDC', address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' },
};

const polygonQuoteTokens: Tokens = {
  link: { symbol: 'LINK', address: '0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39' },
  eth: { symbol: 'ETH', address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619' },
  dai: { symbol: 'DAI', address: '0x6b175474e89094c44da98b954eedeac495271d0f' },
  aave: { symbol: 'AAVE', address: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9' },
  uni: { symbol: 'UNI', address: '0xb33eaad8d922b1083446dc23f610c2567fb5180f' },
  sushi: { symbol: 'SUSHI', address: '0x0b3f868e0be5597d5db7feb59e1cadbb0fdda50a' },
  quick: { symbol: 'QUICK', address: '0x831753dd7087cac61ab5644b308642cc1c33dc13' },
  busd: { symbol: 'BUSD', address: '0xdab529f40e671a1d4bf91361c21bf9f0c9712ab7' },
};

const polygonDexes: AmmFactories = {
  quickswap: '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32',
  apeswap: '0xCf083Be4164828f00cAE704EC15a36D711491284',
  sushiswap: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',

};

function getFactories(network: Network): AmmFactories {
  switch (network) {
    case Network.POLYGON:
      return polygonDexes;
    default:
      throw new Error(`Unsupported network:${network}`);
  }
}

export function getIntermediateTokens(baseTokens: Tokens, quoteTokens: Tokens): Tokens {
  const intermediateTokens: Tokens = {};
  for (const quoteKey in quoteTokens) {
    const quoteToken = quoteTokens[quoteKey];
    for (const intermediateKey in quoteTokens) {
      const intermediateToken = quoteTokens[intermediateKey];
      if (!baseTokens[intermediateToken.symbol] && !quoteTokens[intermediateToken.symbol] && quoteToken.symbol !== intermediateToken.symbol) {
        intermediateTokens[intermediateToken.symbol] = intermediateToken;
      }
    }
  }
  return intermediateTokens;
}

export function getTokens(network: Network): [Tokens, Tokens] {
  switch (network) {
    case Network.POLYGON:
      return [polygonBaseTokens, polygonQuoteTokens];
    default:
      throw new Error(`Unsupported network:${network}`);
  }
}

async function updatePairs(network: Network): Promise<ArbitragePair[]> {
  log.info('Updating arbitrage token pairs');
  const [baseTokens, quoteTokens] = getTokens(network);
  const intermediateTokens = getIntermediateTokens(baseTokens, quoteTokens);
  const factoryAddrs = getFactories(network);

  const factoryAbi = ['function getPair(address, address) view returns (address pair)'];
  let factories: Contract[] = [];

  log.info(`Fetch from dexes: ${Object.keys(factoryAddrs)}`);
  for (const key in factoryAddrs) {
    const addr = factoryAddrs[key];
    const factory = new ethers.Contract(addr, factoryAbi, ethers.provider);
    factories.push(factory);
  }

  let tokenPairs: ArbitragePair[] = [];
  for (const baseKey in baseTokens) {
    const baseToken = baseTokens[baseKey];
    for (const quoteKey in quoteTokens) {
      const quoteToken = quoteTokens[quoteKey];
      for (const intermediateKey in intermediateTokens) {
        const intermediateToken = intermediateTokens[intermediateKey];
        if (baseToken.symbol !== quoteToken.symbol && baseToken.symbol !== intermediateToken.symbol && quoteToken.symbol !== intermediateToken.symbol) {
          let tokenPair: ArbitragePair = { symbols: `${quoteToken.symbol}-${intermediateToken.symbol}-${baseToken.symbol}`, pairs: [] };
          for (const factory of factories) {
            const pair1 = await factory.getPair(baseToken.address, quoteToken.address);
            const pair2 = await factory.getPair(quoteToken.address, intermediateToken.address);
            const pair3 = await factory.getPair(intermediateToken.address, baseToken.address);
            if (pair1 != ZERO_ADDRESS && pair2 != ZERO_ADDRESS && pair3 != ZERO_ADDRESS) {
              tokenPair.pairs.push(pair1, pair2, pair3);
            }
          }
          if (tokenPair.pairs.length === 3) {
            tokenPairs.push(tokenPair);
          }
        }
      }
    }
  }


  let allPairs: ArbitragePair[] = [];
  for (const tokenPair of tokenPairs) {
    if (tokenPair.pairs.length < 3) {
      continue;
    } else {
      const combinations = lodash.combinations(tokenPair.pairs, 3);
      for (const pair of combinations) {
        const arbitragePair: ArbitragePair = {
          symbols: tokenPair.symbols,
          pairs: pair as [string, string, string],
        };
        const poolAddr = await getPairAddress(pair);
        if (poolAddr !== ZERO_ADDRESS) {
          allPairs.push({ ...arbitragePair, pool: poolAddr });
        }
      }
    }
  }
  return allPairs;

}

async function getPairAddress(pair: [string, string, string]): Promise<string> {
  // Implementation of getting pool address for a triplet pair
  return ZERO_ADDRESS;
}

function getPairsFile(network: Network) {
  return path.join(__dirname, `../pairs-${network}.json`);
}

export async function tryLoadPairs(network: Network): Promise<ArbitragePair[]> {
  let pairs: ArbitragePair[] | null;
  const pairsFile = getPairsFile(network);
  try {
    pairs = JSON.parse(fs.readFileSync(pairsFile, 'utf-8'));
    log.info('Load pairs from json');
  } catch (err) {
    pairs = null;
  }

  if (pairs) {
    return pairs;
  }
  pairs = await updatePairs(network);

  fs.writeFileSync(pairsFile, JSON.stringify(pairs, null, 2));
  return pairs;
}
