import { Address, BigInt } from "@graphprotocol/graph-ts";
import { Transfer } from "../generated/NonfungiblePositionManager/NonfungiblePositionManager";
import { Pool, Position } from "../generated/schema";
import { NonfungiblePositionManager } from "../generated/NonfungiblePositionManager/NonfungiblePositionManager";

// Fetch Position IDs using the tokenByIndex method
function fetchPositionIds(poolAddress: Address): void {
  let contract = NonfungiblePositionManager.bind(poolAddress);
  
  // Try to get the total number of tokens
  let totalSupplyResult = contract.try_totalSupply();
  if (totalSupplyResult.reverted) return;

  let totalSupply = totalSupplyResult.value;
  for (let i = BigInt.fromI32(0); i.lt(totalSupply); i = i.plus(BigInt.fromI32(1))) {
    let tokenIdResult = contract.try_tokenByIndex(i);
    if (tokenIdResult.reverted) continue;

    let tokenId = tokenIdResult.value;

    // Load or create a new Position entity
    let position = Position.load(tokenId.toString());
    if (!position) {
      position = new Position(tokenId.toString());
      position.pool = poolAddress.toHex();
      position.owner = contract.ownerOf(tokenId);
    }
    position.save();
  }
}

export function handleTransfer(event: Transfer): void {
  let poolAddress = event.address;
  fetchPositionIds(poolAddress);
}
