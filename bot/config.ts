import { BigNumber, BigNumberish, utils } from 'ethers';

interface Config {
  contractAddr: string;
  logLevel: string;
  minimumProfit: number;
  gasPrice: BigNumber;
  gasLimit: BigNumberish;
  polygonScanUrl: string;
  concurrency: number;
}

const contractAddr = '0xa37e3Eb0Eef9eE9E7eDE14B82C289B401C390291'; // flash bot contract address
const gasPrice = utils.parseUnits('200', 'gwei');
const gasLimit = 310000;

const polygonScanApiKey = '48U9KEJTZBNTDI8W6Y4D99GMSSE6PKW2VD'; // bscscan API key
const polygonScanUrl = `https://api.polygonscan.com/api?module=stats&action=maticPrice&apikey=${polygonScanApiKey}`;

const config: Config = {
  contractAddr: contractAddr,
  logLevel: 'info',
  concurrency: 50,
  minimumProfit: 10,
  gasPrice: gasPrice,
  gasLimit: gasLimit,
  polygonScanUrl: polygonScanUrl,
};

export default config;
