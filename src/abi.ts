import { parseAbi } from "viem";

/**
 * Event definitions the verifier needs. Written from the publicly verified contract ABIs
 * (Escrow and FulfillmentProxy on Blockscout/Sourcify, see spec/abi/ in the research notes).
 * Only events are listed here; calldata decoding is added with the core verification.
 */
export const escrowEvents = parseAbi([
  "event Deposited(bytes32 indexed depositId, bytes32 indexed quoteHash, address indexed depositor, address settler, address token, uint256 amount, uint256 feeAmount, address reserver, address releaser)",
  "event DepositCommitments(bytes32 indexed depositId, bytes32 depositRequestHash, bytes32 destinationHash)",
  "event Released(bytes32 indexed depositId, address indexed settler, address token, uint256 amount, uint256 feeAmount)",
  "event Refunded(bytes32 indexed depositId, address indexed depositor, address token, uint256 amount)",
  // Batch variants: detected so the verifier can say "unsupported" instead of silently missing them.
  "event DepositedMany(bytes32[] depositIds, (bytes32 depositRequestHash, string destination, address reserver, address releaser)[] depositWitnesses, (bytes32 depositId, bytes32 quoteHash, address settler, uint256 sourceAmount)[] reserveWitnesses, uint256[] feeAmounts)",
  "event ReleasedMany((bytes32 depositId, bytes32 quoteHash, bytes32 depositRequestHash, bytes32 destinationHash, address depositor, address token, uint256 amount, uint256 feeAmount, address reserver, address releaser, address settler)[] releaseWitnesses)",
  "event RefundedMany((bytes32 depositId, bytes32 quoteHash, bytes32 depositRequestHash, bytes32 destinationHash, address depositor, address token, uint256 amount, uint256 feeAmount, address reserver, address releaser, address settler)[] refundWitnesses)",
]);

export const proxyEvents = parseAbi([
  "event Fulfilled(bytes32 indexed quoteHash, address indexed settler, address to, address token, uint256 amount, uint256 timestamp)",
  "event FulfilledMany((bytes32 quoteHash, address to, address token, uint256 amount)[] fulfillments, address indexed settler, uint256 timestamp)",
]);

export const erc20Events = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/**
 * topic0 values taken from real logs and from the verified ABI (research notes, section 1.2).
 * A unit test asserts that the definitions above hash to exactly these values, so a typo in an
 * event signature cannot silently change what the tool searches for.
 */
export const EXPECTED_TOPIC0 = {
  Deposited: "0x00d99cb530e2d4ecb11da22fd966de4bd68000fdbc6b822f902163642404000e",
  DepositCommitments: "0xdd71cfeda84126f075a6e6c4e6aacadc514806a79f1bccb0619818b7736eefc5",
  Released: "0x703d1f677dc7a240b8578621df4ac5a0d8323e943fcc50ce0ffd9dcc8f6974cc",
  Refunded: "0x2e0668a62a5f556368dca9c7113e20f2852c05155548243804bf714ce72b25a6",
  DepositedMany: "0x837f538e17106ab6df4c0f8a1de4e8127c1dc86827e956daebf9942a0406e2d0",
  ReleasedMany: "0x63ae99db9a784d0cfddbfc24a172533fca09ed92f286131b04742dbceac30016",
  RefundedMany: "0x949fa5cc9abe2cf38fdd057482e67cc01d31361a8981e80cc0ac93396ecfa801",
  Fulfilled: "0x6344d803114225f61bd0be81b7f0810daff32f11666c3e6e0f51e50a8c7450f2",
  FulfilledMany: "0xa55853fe36e243bbd57e73a1582a883508e206be6fce5a8f07e29cb0808959b5",
  Transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
} as const;
