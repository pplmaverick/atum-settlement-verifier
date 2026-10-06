# Offline fixtures

All tests run without network access. These files are the data the tests feed to the RPC layer.

## sample-001

One real cross-chain settlement (Base Sepolia -> Arbitrum Sepolia, 2026-10-06, 50000 atomic USDC).

| File | Provenance |
| --- | --- |
| `arbitrum-sepolia.fulfill-receipt.json` | **Real** `eth_getTransactionReceipt` result for the destination tx, saved from a public RPC. Only `logsBloom` and a few L2-specific gas fields were dropped. |
| `base-sepolia.deposit-receipt.json` | **Reconstructed.** The topics and data of the three logs were rebuilt by ABI-encoding the event values that had been read from chain (the encoding of an event log is fully determined by those values). `transactionIndex`, `blockHash`, and the log order and indexes are placeholders; the tests do not depend on them. |
| `base-sepolia.release-receipt.json` | **Reconstructed**, same method. |
| `expected.json` | Expected values, copied from the research notes of the analysed sample. |

`eth_getLogs` answers are produced by the fake RPC (`test/helpers/fake-chain.ts`) by filtering the logs inside these receipts by address, topics, and block range. Block timestamps are synthetic except at the anchor blocks: a linear model through one real (block, timestamp) point per chain, which reproduces the real timestamps of the deposit, release, and fulfillment blocks.

## abi

Full ABI JSON of the escrow and fulfillment-proxy contracts as published by the public block-explorer source verification (testnet and mainnet deployments). `abi-guard.test.ts` compares every hand-written event signature in `src/abi.ts` against them.
