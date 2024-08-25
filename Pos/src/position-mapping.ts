// position-mapping.ts
import { BigInt } from "@graphprotocol/graph-ts";

import { PositionCreated } from "../generated/PositionManager/PositionManager";
import { Position } from "../generated/schema";

export function handlePositionCreated(event: PositionCreated): void {
  let position = new Position(event.params.tokenId.toHexString());
  position.tokenId = event.params.tokenId.toHexString();
  position.poolAddress = event.params.pool.toHexString();
  position.save();
}
