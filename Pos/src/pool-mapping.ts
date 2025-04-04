// pool-mapping.ts

import { BigInt } from "@graphprotocol/graph-ts";
import { PoolCreated } from "../generated/UniswapV3Factory/UniswapV3Factory";
import { Pool } from "../generated/schema";

export function handlePoolCreated(event: PoolCreated): void {
  let pool = new Pool(event.params.pool.toHexString());
  pool.poolAddress = event.params.pool.toHexString();
  pool.token0 = event.params.token0.toHexString();
  pool.token1 = event.params.token1.toHexString();
  pool.fee = event.params.fee.toString();
  pool.save();
}
