import axios from 'axios';
import AsyncLock from 'async-lock';

import config from './config';
import log from './log';

const lock = new AsyncLock();

let maticPrice = 0;

// clear matic price every hour
setInterval(() => {
  lock
    .acquire('matic-price', () => {
      maticPrice = 0;
      return;
    })
    .then(() => {});
}, 3600000);

export async function getMaticPrice(): Promise<number> {
  return await lock.acquire('matic-price', async () => {
    if (maticPrice !== 0) {
      return maticPrice;
    }
    const res = await axios.get(config.polygonScanUrl);
    maticPrice = parseFloat(res.data.result.ethusd);
    log.info(`MATIC price: $${maticPrice}`);
    return maticPrice;
  });
}
