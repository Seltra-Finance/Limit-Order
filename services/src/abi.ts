/** Minimal ABIs for the off-chain services (human-readable, ethers v6). */

export const SETTLEMENT_ABI = [
  "function fillOrderDEX((address maker,address receiver,address makerAsset,address takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 salt,uint256 epoch,uint40 expiry,address allowedSender,uint8 flags) order, ((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit, bytes signature, (uint8 adapterId,bytes extra) route) returns (uint256 amountOut)",
  "function fillOrderP2P((address maker,address receiver,address makerAsset,address takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 salt,uint256 epoch,uint40 expiry,address allowedSender,uint8 flags) a, ((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permitA, bytes sigA, (address maker,address receiver,address makerAsset,address takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 salt,uint256 epoch,uint40 expiry,address allowedSender,uint8 flags) b, ((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permitB, bytes sigB)",
  "function hashOrder((address maker,address receiver,address makerAsset,address takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 salt,uint256 epoch,uint40 expiry,address allowedSender,uint8 flags) order) view returns (bytes32)",
  "function currentEpoch(address maker) view returns (uint256)",
  "function fillsPaused() view returns (bool)",
  "function allowedTokens(address token) view returns (bool)",
  "function incrementEpoch()",
  "function pauseFills()",
  "function unpauseFills()",
  "event OrderFilledDEX(bytes32 indexed orderHash, address indexed maker, address indexed keeper, uint8 adapterId, uint256 makingAmount, uint256 amountOut, uint256 makerImprovement, uint256 keeperReward)",
  "event OrderFilledP2P(bytes32 indexed hashA, bytes32 indexed hashB, uint256 surplus, uint256 makerShareA, uint256 makerShareB, uint256 keeperReward)",
  "event EpochIncremented(address indexed maker, uint256 newEpoch)",
  "event FillsPaused(address guardian)",
  "event FillsUnpaused()",
];

export const ROUTER_ABI = [
  "function quote(uint8 adapterId, address tokenIn, address tokenOut, uint256 amountIn, bytes extra) returns (uint256 amountOut)",
  "function isRegistered(uint8 id) view returns (bool)",
];

export const PERMIT2_ABI = [
  "function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)",
  "function invalidateUnorderedNonces(uint256 wordPos, uint256 mask)",
  "event UnorderedNonceInvalidation(address indexed owner, uint256 word, uint256 mask)",
];

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
];
