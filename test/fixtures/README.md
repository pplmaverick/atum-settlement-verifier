# Offline fixtures

All tests run without network access. These files are the data the tests feed to the RPC layer.

## real/

Raw public-RPC results for sample 001 (Base Sepolia -> Arbitrum Sepolia, 2026-10-06, 50000 atomic USDC), saved once by `scripts/capture-sample-001.mjs` (which only runs with `LIVE=1`). Public on-chain data only.

| File | Content |
| --- | --- |
| `base-sepolia.deposit-receipt.json`, `base-sepolia.release-receipt.json` | `eth_getTransactionReceipt` results for the source deposit and release transactions |
| `arbitrum-sepolia.fulfill-receipt.json` | `eth_getTransactionReceipt` result for the destination transaction |
| `base-sepolia.escrow-logs.json`, `arbitrum-sepolia.proxy-logs.json` | unfiltered `eth_getLogs` results for the escrow / proxy over a small block window around the sample |
| `capture-meta.json` | capture time, chain ids, the log windows, block number and timestamp of the three blocks, and the list of requests made |

The fake RPC (`test/helpers/fake-chain.ts`) answers `eth_getLogs` by filtering the logs of these receipts and files by address, topics and block range, so a test that edits a receipt also changes what `eth_getLogs` returns. Its head block is the end of the captured window. Block timestamps are synthetic except at the real anchor blocks: a linear model through one real (block, timestamp) point per chain, which reproduces the real timestamps of the deposit, release and fulfillment blocks.

Observed quirk: the Arbitrum Sepolia public RPC returns `blockTimestamp: "0x0"` inside `eth_getLogs` results while the receipt has the real value. The verifier never reads that field (see `test/fixtures-real.test.ts`).

## reconstructed/

An earlier, hand-encoded copy of the three receipts (source receipts rebuilt by ABI-encoding event values; the destination receipt was a trimmed real one). Kept only so `fixtures-real.test.ts` can show that the reconstruction agrees with the real data on every semantic field. Placeholders there: `logIndex`, `transactionIndex`, `blockHash`.

## expected.json

Expected values for the sample, from the research notes of the analysed payment.

## abi/

Full ABI JSON of the escrow and fulfillment-proxy contracts as published by public block-explorer source verification (testnet and mainnet deployments). `abi-guard.test.ts` compares every hand-written event signature in `src/abi.ts` against them.

## sample-001.cli-output.txt

The CLI output for the passing run, written by a file-snapshot test and pasted into the README.
