# Observed behavior

This file records what the author of this tool observed while checking one real settlement, and what each observation rests on. It is a lab notebook, not a specification.

## 1. Scope

- This is an unofficial document. It is not affiliated with, reviewed by, or endorsed by Atum Labs.
- Everything under "Observed" comes from one testnet settlement, called sample-001 in this repository: one x402 payment from Base Sepolia to Arbitrum Sepolia, USDC to USDC, 6 decimals on both sides, amount 50000 atomic units, handled by a single settler address. The sample was captured on 2026-10-06.
- Unless an item says otherwise, the sample count is one. Items supported by one sample are written as "observed on one testnet settlement (sample-001), not generalized". They say nothing about other tokens, other chains, other payment paths, or mainnet.
- This file does not claim that any official document is right or wrong. Where two texts differ, they are listed side by side with their sources and no conclusion is drawn.
- Evidence paths:
  - Paths such as `README.md`, `src/...`, `test/...` and `scripts/...` are files in this repository.
  - The captured RPC data is in `test/fixtures/real/`.

## 2. Observed

### 2a. Event structure and the quoteHash link

Fact. The escrow contract emitted these events for the sample, with these fields (indexed fields first, as declared):

| Event | Emitted by | Fields |
| --- | --- | --- |
| `Deposited` | escrow, source chain | indexed `depositId`, `quoteHash`, `depositor`; then `settler`, `token`, `amount`, `feeAmount`, `reserver`, `releaser` |
| `DepositCommitments` | escrow, source chain, same transaction as `Deposited` | indexed `depositId`; then `depositRequestHash`, `destinationHash` |
| `Released` | escrow, source chain | indexed `depositId`, `settler`; then `token`, `amount`, `feeAmount` |
| `Fulfilled` | fulfillment proxy, destination chain | indexed `quoteHash`, `settler`; then `to`, `token`, `amount`, `timestamp` |

Fact. `Deposited.quoteHash` on the source chain and `Fulfilled.quoteHash` on the destination chain had the same value in the sample (`0x15fc7798...1664`). The verifier uses this value to find the destination event from the source transaction.

Fact. The settler address was the same in `Deposited`, `Fulfilled` and `Released`.

How the ABI was obtained. The full ABI JSON of the escrow and the fulfillment proxy comes from public block-explorer source verification (`test/fixtures/README.md` line 26). The hand-written event declarations in `src/abi.ts` are compared against those ABI files by a test, so a wrong type, name or indexed flag fails the test. The offline replay of the stored real logs passes all 15 checks (`test/fixtures/sample-001.cli-output.txt` line 59).

Evidence:

- `src/abi.ts` lines 9-12 and 20 (event declarations used by the verifier).
- `test/fixtures/README.md` line 26 (the full ABI JSON files under `test/fixtures/abi/`) and `test/abi-guard.test.ts` lines 13-19 and 53-58 (a test compares every hand-written event signature in `src/abi.ts` against those ABI files).
- `README.md` lines 22 and 137 (V7), line 144 (same settler on deposit, fulfillment and release), and the "Read from chain" block at lines 153-176 (field values from the sample).
- `test/fixtures/real/base-sepolia.escrow-logs.json` and `test/fixtures/real/arbitrum-sepolia.proxy-logs.json` (raw logs).

Samples: one (sample-001).


### 2b. request_id and depositRequestHash

Fact. In sample-001, `DepositCommitments.depositRequestHash` equals `keccak256(utf8(request_id))`, where `request_id` can be computed offline as:

```
"req_x402_" + first 24 hex characters of keccak256("atum-request:v1:" + purchaseId + ":" + lowercase(payer))
```

The computed `request_id` was `req_x402_938003bbdf80468e558d3a89`. Its keccak256 matched the on-chain `depositRequestHash` (`0xef67b8be...a679`).

How the rule was found. It was inferred by reading the installed npm package `@atumlabs/x402-atum-escrow` version 0.3.1, not from a written description:

- Its bundled code defines the domain string `"atum-request:v1:"`.
- It exports a function `atumEscrowRequestId(anchor, account)` that uses the prefix `"req_x402_"`.
- The exact hashing and truncation steps were then written down as a candidate rule and tested against the chain data. (The package is on public npm; its files are not part of this repository.)

How it was checked on chain. In sample-001 the `depositRequestHash` read from `DepositCommitments` equals the hash of the derived `request_id` (check V6). Also, the payment id equals `Deposited.depositId` (check V6b).

Destination commitment. `DepositCommitments.destinationHash` equals `keccak256` of `lower("<caip2>/erc20:<asset>@<recipient>")`. For the sample this is `eip155:421614/erc20:0x75faf114...aa4d@0xfd1290ac...273f`, lowercased.

Observed on one testnet settlement (sample-001), not generalized. The rule was checked for the x402 path only. MPP and PGC paths were not checked.

Evidence:

- `src/derive.ts` lines 3-28 (the derivation as implemented, with the same caveat in its comment).
- `README.md` lines 19-21 (V5, V6, V6b), 131-134 (output of V5 and V6), 219 (known limit 5).
- `test/fixtures/expected.json` (expected `requestId`, `depositRequestHash`, `destinationHash`).
- `test/decode-derive.test.ts` (unit tests of the derivation functions).

Samples: one.

### 2c. Amount behavior

Fact. In sample-001:

| Quantity | Value |
| --- | --- |
| `FULFILLMENT_AMOUNT` (destination, atomic units) | 50000 |
| `MARKUP_BPS` | 300 |
| Source spend cap, `50000 * 10300 / 10000` | 51500 |
| `Deposited.amount` | 50000 |
| `Deposited.feeAmount` | 10 |
| `Released.amount`, `Released.feeAmount` | 50000, 10 |
| ERC20 transfer from escrow to settler at release | 49990 |
| `Fulfilled.amount` | 50000 |

So `Deposited.amount` was 1:1 with `FULFILLMENT_AMOUNT`, the fee of 10 was taken from inside that amount, and the escrow paid out `amount - feeAmount = 49990` at release. The cap of 51500 was not reached.

Consequence for the verifier. Because the deposited amount was below the cap, V3 checks `Deposited.amount <= cap` (and greater than zero). It does not check equality with the cap, and the sample would have failed an equality check. The cap formula is `amount * (10000 + markup_bps) / 10000` with integer division.

Observed on one testnet settlement (sample-001), not generalized. USDC to USDC with equal decimals is a 1:1 route. The sample cannot say what the deposited amount is for other token pairs, other decimals, or other pricing settings.

Texts found in the project that describe markup. These are listed without a conclusion. Each is quoted from its source.

1. Example merchant code, repository `Atum-Labs/examples`, commit `4efa78e665435a9c4b043f3dca5ea93c0adf07a2`, file `x402-accept-payments/src/merchant.ts` lines 45-47 and 50-52. Permalink: https://github.com/Atum-Labs/examples/blob/4efa78e665435a9c4b043f3dca5ea93c0adf07a2/x402-accept-payments/src/merchant.ts#L45-L52
   - Lines 45-47: "Markup over FULFILLMENT_AMOUNT, in basis points (100 bps = 1%). Added on top of the fulfillment amount to derive the source-chain spend cap, and covers settlement fees and cross-chain conversion."
   - Lines 50-52: "The maximum the payer authorizes on the source chain = fulfillment amount + markup. Atum converts this to the exact FULFILLMENT_AMOUNT on the destination chain; anything above the fulfillment amount covers fees."
2. docs.atum.xyz pages, read on 2026-10-07:
   - Page "Develop with Atum SDK" (MPP, accept payments), https://docs.atum.xyz/payment-protocols/mpp/accept-payments/develop-with-the-sdk : code comment `markupBps: 300, // source cap = fulfillment amount + 3%`.
   - Page "Develop with Atum SDK" (x402, accept payments), https://docs.atum.xyz/payment-protocols/x402/accept-payments/develop-with-the-sdk : code comment `price: "$0.10", // required by the route type, but ignored: the amount is fulfillmentAmount + markup`.
   - Page "Prerequisites", https://docs.atum.xyz/get-started/start-building/prerequisites : a table row for the source token balance: "At least the amount plus any markup the payment requires".
   - Page "Bidding strategies", https://docs.atum.xyz/settle-payments/bidding-strategies : "Quotes the `fulfillment_amount` as the `source_amount`" followed by "1:1 pricing with no markup" (the original joins them with a dash); and, for the static markup strategy, "Applies a fixed percentage markup plus an optional flat fee to every payment."

Evidence:

- `src/verify.ts` lines 351-358 (V3 as implemented).
- `README.md` lines 17, 127, 220 (V3 text, V3 output, known limit 6 on the fee).
- `README.md` lines 140 (`Fulfilled` amount 50000), 145-146 (V11, "settler received amount - fee = 49990") and 163-164 (source amount and fee in the read-from-chain block).
- `test/fixtures/expected.json` (`sourceAmount` 50000, `feeAmount` 10, `markupBps` 300).

Samples: one.

### 2d. Public RPC behavior (third-party, not Atum)

The items in this section describe public RPC endpoints run by third parties. They are not Atum behavior.

Fact. `eth_getLogs` block range limits seen from the error messages of two public Base Sepolia endpoints:

| Endpoint | Observed limit | Source of the observation |
| --- | --- | --- |
| `https://base-sepolia-rpc.publicnode.com` | 50000 blocks | error message "exceed maximum block range: 50000" |
| `https://sepolia.base.org` | 500 blocks; history not available below block 46,000,000 | error message "eth_getLogs is limited to a 500 range" |
| `https://rpc.moderato.tempo.xyz` (Tempo Moderato) | a 5000-block window succeeded; the real limit may be higher | one successful request, not an error message |

The configured ranges for Arbitrum Sepolia, Base mainnet and Arbitrum One are conservative guesses that were never tested. They are marked `assumed` in the configuration and are listed again under Unverified.

Fact. The Arbitrum Sepolia public endpoint `https://sepolia-rollup.arbitrum.io/rpc` returned `blockTimestamp: "0x0"` inside `eth_getLogs` results for the destination `Fulfilled` log, while the transaction receipt for the same log carried a real value (`0x6ac4a1af` in the stored fixture). The verifier never reads that log field. It takes block times from `eth_getBlockByNumber`.

Observed on one testnet settlement (sample-001), not generalized. Public endpoints change their limits and behavior over time, and a different endpoint for the same chain may behave differently.

Evidence:

- `src/config/testnet.ts` lines 30-33 (Base Sepolia limits and pruning), 45-46 (Arbitrum Sepolia, `assumed`), 58-59 (Tempo Moderato, `observed-working`).
- `src/config/mainnet.ts` lines 21, 31, 41 (mainnet ranges, `assumed`).
- `README.md` line 218 (known limit 4).
- `test/fixtures/README.md` line 18, `test/fixtures/real/capture-meta.json` and `test/fixtures-real.test.ts` lines 38-39 (the `0x0` timestamp, with the receipt value alongside).
- `test/fixtures/real/arbitrum-sepolia.proxy-logs.json` (raw log) and `test/fixtures/real/arbitrum-sepolia.fulfill-receipt.json` (receipt).

Samples: one for the timestamp behavior. The Base Sepolia limits come from error messages seen during research.

## 3. Unverified

The following were not verified, and nothing above should be read as covering them.

- Mainnet. Mainnet contract addresses were read from the mainnet gateway defaults and from public source-verification and bytecode lookups. No mainnet settlement was analysed. (`README.md` lines 208 and 216.)
- Tempo, including Tempo Moderato. The network is configured, and the same contract addresses were seen in bytecode and logs, but no Tempo settlement was analysed. (`README.md` line 207; `src/config/testnet.ts` line 61.)
- Refunds. The `Refunded` event signature is known from the ABI, but no real refund was seen. The "no refund" result of check V12 applies only to the scanned block range. (`README.md` lines 27, 217 and 221.)
- Batch events (`DepositedMany`, `ReleasedMany`, `RefundedMany`, `FulfilledMany`). The signatures come from the ABI. No real batch settlement was seen, the verifier does not decode their contents, and a batch settlement is reported as unsupported or unknown. (`README.md` lines 29, 31 and 217; `src/abi.ts` lines 13-16 and 21.)
- Multiple settlers. All observed transactions used one settler address.
- Other token pairs and other decimals. Whether `Fulfilled.amount` equals `FULFILLMENT_AMOUNT` for a route with different tokens or decimals is not known. (`README.md` line 215: the only sample is a 1:1 USDC to USDC route.)
- The fee formula. The fee of 10 on 50000 (0.02%) was seen. How it is derived from per-token fee settings was not checked. (`README.md` line 220.)
- MPP and PGC payment paths. The `request_id` rule and the payment id equality were checked for x402 only. (`README.md` line 219.)
- The block-explorer verification status of the contracts (full or partial) was not investigated.
- The Arbitrum Sepolia and mainnet `eth_getLogs` ranges (see 2d).
- Reorgs and finality. Reads are of the latest state returned by one RPC at a time. (`README.md` line 224.)

## 4. How to reproduce

1. Offline replay of the stored sample. The fixtures in `test/fixtures/real/` are raw public-RPC results for sample-001, captured once on 2026-10-06 (see `test/fixtures/README.md` and `test/fixtures/real/capture-meta.json`). The expected CLI output for the replay is stored in `test/fixtures/sample-001.cli-output.txt`.
2. Live check against public RPCs. The command and its real output are in `README.md` under "Usage" (lines 70-84) and "Example: sample 001" (lines 111-176). Install steps are at lines 56-68 (Node.js 20 or newer, `npm ci`, `npm run build`, `node dist/cli.js`). Public RPCs may throttle or prune history, so a later run can return `unknown` for checks that passed on 2026-10-06.
3. Re-capturing the raw data. `scripts/capture-sample-001.mjs` is the script that saved the fixtures. It only runs with `LIVE=1` and reads public data.

A pass in any of these runs says that the listed checks held for this one payment on the data the RPC returned. It is not a security guarantee and not an audit.
