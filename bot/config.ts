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

const contractAddr = '0xadbe79ddac961a2ea340e5595c94d67675c0b1b7'; // flash bot contract address
const gasPrice = utils.parseUnits('10', 'gwei');
const gasLimit = 310000;
const zkpolygonScanApiKey = 'GMM8XWAJ8166FR8NGRDGG3JBQQP3QASS84';
const polygonScanApiKey = '48U9KEJTZBNTDI8W6Y4D99GMSSE6PKW2VD'; // bscscan API key
const polygonScanUrl = `https://api.polygonscan.com/api?module=stats&action=maticPrice&apikey=${polygonScanApiKey}`;
const zkpolygonScanUrl = `https://api-zkevm.polygonscan.com/api?module=stats&action=maticPrice&apikey=${zkpolygonScanApiKey}';
}`;
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
