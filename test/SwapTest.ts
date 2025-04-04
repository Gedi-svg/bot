import { ethers } from 'hardhat';
import { FlashArbitrageV3 } from '../typechain/FlashArbitrageV3';
import { expect } from 'chai';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { IUniswapV3Factory } from '../typechain/IUniswapV3Factory';
import { INonfungiblePositionManager } from '../typechain/INonfungiblePositionManager';

describe("FlashArbitrageV3", function () {
  let flashArbitrage: FlashArbitrageV3;
  let signer: SignerWithAddress;
  let addr1: SignerWithAddress;

  // Addresses on the Polygon network
  const flashArbitrageAddress = '0xaDBE79DdAC961a2ea340E5595C94D67675c0b1B7';
  const posman = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88'; // NonfungiblePositionManager
  const factoryAddress = '0x1F98431c8aD98523631AE4a59f267346ea31F984'; // Uniswap V3 Factory
  const USDT = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'; // WMATIC (used as a stand-in for USDT)
  const WMATIC = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';
  const ETH = '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619';
  const UNI = '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6';

  before(async function () {
    // Get signers
    const signers = await ethers.getSigners();
    signer = signers[0]; // Use the first signer
    addr1 = signers[1];
    
    // Connect to the already deployed FlashArbitrageV3 contract
    flashArbitrage = (await ethers.getContractAt("FlashArbitrageV3", flashArbitrageAddress, signer)) as FlashArbitrageV3;

    console.log("Connected to FlashArbitrageV3 Contract at address:", flashArbitrage.address);
  });

  async function getPoolAddress(tokenA: string, tokenB: string, fee: number = 3000): Promise<string> {
    const factory = (await ethers.getContractAt("IUniswapV3Factory", factoryAddress, signer)) as IUniswapV3Factory;
    const poolAddress = await factory.getPool(tokenA, tokenB, fee);
    if (poolAddress === ethers.constants.AddressZero) {
      throw new Error(`Pool not found for pair ${tokenA}-${tokenB}`);
    }
    return poolAddress;
    console.log("pool address:", poolAddress);
  }

  


  it("Should execute flash arbitrage successfully", async function () {
    const poolAddressAB = await getPoolAddress(WMATIC, ETH);
    const poolAddressBC = await getPoolAddress(ETH, UNI);
    const poolAddressCA = await getPoolAddress(UNI, WMATIC);

    console.log("pool address:", poolAddressAB);
    console.log("pool address:", poolAddressBC);
    console.log("pool address:", poolAddressCA);

    
    const poolData = {
      poolAddressAB,
      poolAddressBC,
      poolAddressCA,
      borrowAmount: ethers.utils.parseEther("10"),
      profit1: 0,
      profit2: 0,
      profit3: 0
    };

    const path1 = [WMATIC, ETH];
    const path2 = [ETH, UNI];
    const path3 = [UNI, WMATIC];

    await expect(
      flashArbitrage.executeFlashArbitrage(path1, path2, path3, poolData.borrowAmount, poolData)
    ).to.emit(flashArbitrage, "FlashArbitrageExecuted")
     .withArgs(poolData.borrowAmount, ethers.utils.parseEther("0")); // Update this based on profit calculation logic
  });
});
