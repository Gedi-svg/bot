import { task, HardhatUserConfig } from 'hardhat/config';
import '@typechain/hardhat';
import '@nomiclabs/hardhat-waffle';

import deployer from './.secret';

// const BSC_RPC = 'https://bsc-dataseed.binance.org/';
const zk_RPC = 'https://polygonzkevm-mainnet.g.alchemy.com/v2/LgO78ofPwcPs_924mMe11wozolXlvTUj';
const POLYGON_RPC = 'https://polygon-mainnet.g.alchemy.com/v2/DcqRhPPSW0upcwmCtR8oa3Pb2clizqgG';

const config: HardhatUserConfig = {
  solidity: { version: '0.7.6',
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }}, 
  networks: {
    hardhat: {
      // loggingEnabled: true,
      forking: {
        url: POLYGON_RPC,
        enabled: true,
      },
      accounts: {
        accountsBalance: '1000000000000000000000000', // 1 mil ether
      },
    },
    polygon: {
      url: POLYGON_RPC,
      chainId: 0x89,
      accounts: [deployer.private],
    },
    zk: {
      url: zk_RPC,
      chainId: 0x44D,
      accounts: [deployer.private],
    },
  },
  mocha: {
    timeout: 40000,
  },
};

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = config;
