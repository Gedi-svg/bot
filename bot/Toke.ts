import fs from 'fs';
import path from 'path';
import { Contract } from '@ethersproject/contracts';
import { ethers } from 'hardhat';
import log from './log';

export enum Network {
  POLYGON = 'polygon',
}

interface Token {
  symbol: string;
  address: string;
}

interface Tokens {
  [key: string]: Token;
}

interface AmmFactories {
  [key: string]: string;
}

export interface TokenCombination {
  symbols: string;
  addresses: string[];
  pairs: string[];
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
  dfyn: '0xE7Fb3e833eFE5F9c441105EB65Ef8b261266423B',
  jetswap: '0x668ad0ed2622C62E24f0d5ab6B6Ac1b9D2cD4AC7',
};

function getFactories(network: Network): AmmFactories {
  switch (network) {
    case Network.POLYGON:
      return polygonDexes;
    default:
      throw new Error(`Unsupported network:${network}`);
  }
}

export function getTokens(network: Network): [Tokens, Tokens] {
  switch (network) {
    case Network.POLYGON:
      return [polygonBaseTokens, polygonQuoteTokens];
    default:
      throw new Error(`Unsupported network:${network}`);
  }
}

async function updateCombinations(network: Network): Promise<TokenCombination[]> {
  // Fetch base and quote tokens for the network
  const [baseTokens, quoteTokens] = getTokens(network);

  let combinations: TokenCombination[] = [];

  // Generate combinations of three tokens
  for (const baseKey in baseTokens) {
    const baseToken = baseTokens[baseKey];
    for (const quote1Key in quoteTokens) {
      const quoteToken1 = quoteTokens[quote1Key];
      for (const quote2Key in quoteTokens) {
        if (quote1Key === quote2Key) continue; // Ensure different tokens
        const quoteToken2 = quoteTokens[quote2Key];
        
        // Construct combination
        const combination: TokenCombination = {
          symbols: `${baseToken.symbol}-${quoteToken1.symbol}-${quoteToken2.symbol}`,
          addresses: [baseToken.address, quoteToken1.address, quoteToken2.address],
          pairs: []
        };
        combinations.push(combination);
      }
    }
  }

  // Fetch pair addresses for each combination
  let factories: Contract[] = [];
  const factoryAddrs = getFactories(network);
  for (const key in factoryAddrs) {
    const addr = factoryAddrs[key];
    const factory = new ethers.Contract(addr, ['function getPair(address, address) view returns (address pair)'], ethers.provider);
    factories.push(factory);
  }

  for (const combination of combinations) {
    const [pair0, pair1, pair2] = await Promise.all([
      factories[0].getPair(combination.addresses[0], combination.addresses[1]),
      factories[1].getPair(combination.addresses[1], combination.addresses[2]),
      factories[2].getPair(combination.addresses[2], combination.addresses[0])
    ]);
    combination.pairs.push(pair0, pair1, pair2);
  }

  return combinations;
}



function getCombinationsFile(network: Network) {
  return path.join(__dirname, `../combinations-${network}.json`);
}

export async function tryLoadCombinations(network: Network): Promise<TokenCombination[]> {
  let validCombinations: TokenCombination[] | null;
  const combinationsFile = getCombinationsFile(network);
  try {
    validCombinations = JSON.parse(fs.readFileSync(combinationsFile, 'utf-8'));
    log.info('Load validCombinations from json');
  } catch (err) {
    validCombinations = null;
  }

  if (validCombinations) {
    return validCombinations;
  }
  validCombinations = await updateCombinations(network);

  fs.writeFileSync(combinationsFile, JSON.stringify(validCombinations, null, 2));
  return validCombinations;
}
