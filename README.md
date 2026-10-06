# atum-settlement-verifier

A **read-only** command-line tool that re-checks one cross-chain escrow settlement against on-chain data, using only public RPC endpoints.

> **Unofficial. Not affiliated with or endorsed by Atum Labs.** The name describes what the tool reads; it does not imply any relationship, and the tool is not supported by Atum. **This is not a security audit, and it is not a guarantee of the safety of any funds.** A passing result means only that the checks listed below held for one payment, on the data the RPC returned.

It needs no private key and never asks for one. It sends no transactions.

## What it verifies

Given a payment id (or the source deposit transaction), the tool finds the escrow `Deposited` event on the source chain, follows its `quoteHash` to the `Fulfilled` event on the destination chain, finds the escrow `Released` event, and checks for `Refunded`. It then reports, check by check:

| ID | Check | Evidence behind the check |
| --- | --- | --- |
| V1 | The source tx emitted `Deposited` from the configured escrow, and succeeded | one cross-chain sample |
| V2 | `Deposited.token` is the expected source asset and the depositor's token transfer into the escrow matches the amount (needs `--source-asset`) | one cross-chain sample |
| V3 | `Deposited.amount <= amount * (10000 + markup-bps) / 10000`. This is a spend **cap**, not an exact price | one cross-chain sample |
| V4 | `reserver` / `releaser` equal the configured `quote_selector` / `fulfillment_verifier` | one cross-chain sample |
| V5 | `destinationHash` equals `keccak256(lower(<caip2>/erc20:<asset>@<recipient>))` for the expected destination | one cross-chain sample |
| V6 | `depositRequestHash` equals `keccak256(request_id)` for the x402 `request_id` derived from `--purchase-id` and `--payer` | one cross-chain sample, x402 only |
| V6b | The payment id equals `Deposited.depositId` | one cross-chain sample |
| V7 | The destination proxy emitted `Fulfilled` with the same `quoteHash` | one cross-chain sample |
| V8 | `Fulfilled.to`, `token`, `amount` equal the expected recipient, asset and amount | one cross-chain sample |
| V9 | The destination tx contains an ERC20 transfer to the recipient that matches `Fulfilled` | one cross-chain sample |
| V10 | The `settler` is the same on deposit, fulfillment and release | one cross-chain sample |
| V11 | `Released` exists for the deposit and the settler received `amount - feeAmount` | one cross-chain sample |
| V12 | No `Refunded` event for the deposit, within the scanned block range | partial: only the "no refund" case was seen |
| V13 | Time order: deposit <= fulfillment <= release | one cross-chain sample |
| V14 | Batch (`*Many`) events: detected and reported, never verified | none: no real batch sample exists |

**A `PASS` on V14 only means that no batch (`*Many`) events were found in the scanned block ranges. It does not mean that a batch settlement has been verified:** batch events are never decoded into checks, and a batch settlement is reported as `unsupported` (or `unknown`), not as a pass.

### Result vocabulary (fail-closed)

Every check ends in exactly one of:

- **pass**: the data was fetched, decoded and matched.
- **fail**: the data was fetched and contradicts the expectation.
- **unknown**: the data could not be fetched or decoded, a log is missing, or the option needed to run the check was not given. Missing data is never a pass.
- **unsupported**: the situation is outside what the tool understands (a network that is not configured, a batch `*Many` event that covers the payment).

Each check also prints its **evidence level**: how much real-world data backs the check's logic (not whether it passed).

The overall verdict is `pass` only if **every** check passed. Any failure makes it `fail`. Anything else (including a single `unknown`) is `inconclusive`. A report with no checks is never a pass.

## What it does not verify

- **That the payment was a good deal.** It does not check quotes, prices, the fee formula, or whether the settler was authorised to settle.
- **Contract safety.** It does not audit the escrow or proxy contracts, their roles, upgrade or pause state, or their source code. It only checks that the contract addresses it reads from match its built-in configuration.
- **Finality.** It reads what the RPC returns for the latest state; it does not wait for confirmations or detect reorgs.
- **RPC honesty.** A malicious or faulty RPC could return false data. Use more than one endpoint for anything important.
- **Anything about fiat, accounts, identity, disputes, or chargebacks.**
- **Batch (`*Many`) settlements and refund flows.** These are detected and reported as unsupported or unknown; their contents are not verified.
- **Chains other than EVM chains**, and destinations whose asset is not an ERC20 (the destination commitment format has only been seen for `erc20`).

## Install

Requires Node.js 20 or newer. The package is not published to npm; build it from a clone of this repository:

```sh
git clone https://github.com/pplmaverick/atum-settlement-verifier.git atum-settlement-verifier
cd atum-settlement-verifier
npm ci
npm run build
node dist/cli.js --help
```

`npm run build` compiles `src/` to `dist/` and marks `dist/cli.js` executable. Run the tool with `node dist/cli.js ...` from the repository directory.

## Usage

```sh
node dist/cli.js \
  --source-network eip155:84532 \
  --dest-network   eip155:421614 \
  --payment-id     0x8e731bb2dba644355e73f0cd8da6a32777a2b5ef1b68b248d6bd9c2110b9d5bb \
  --dest-address   0xfd1290aC16f8FCfd4B84c5b1604bA0E1aE1A273f \
  --dest-asset     0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d \
  --amount         50000 \
  --source-asset   0x036CbD53842c5426634e7929541eC2318f3dCF7e \
  --purchase-id    order_a6516e1fd1be2b9e589f \
  --payer          0xd2F450592564202a2AbEdC622e703271C996d79d \
  --lookback-blocks 40000 --dest-lookahead-seconds 600 --request-delay-ms 300
```

The minimum flags are `--source-network`, `--dest-network`, `--payment-id` (or `--source-tx`), `--dest-address`, `--dest-asset` and `--amount`. The other flags enable V2 (`--source-asset`) and V6 (`--purchase-id` with `--payer`), or narrow the search windows and space out the requests (`--lookback-blocks`, `--dest-lookahead-seconds`, `--request-delay-ms`). With only the minimum flags the run cannot be a full pass: V2 and V6 report `UNKNOWN` and the exit code is 2.

Options:

| Option | Meaning |
| --- | --- |
| `--source-network`, `--dest-network` | CAIP-2 ids, e.g. `eip155:84532`. Must be configured (see "Networks") |
| `--payment-id` or `--source-tx` | One is required. For x402 on EVM the payment id equals the escrow `depositId`. With only a payment id the tool searches a window of source blocks |
| `--dest-address`, `--dest-asset` | Expected recipient and destination token |
| `--amount` | Expected `FULFILLMENT_AMOUNT` in the destination token's atomic units (an integer) |
| `--markup-bps` | Markup used to compute the source spend cap (default `300`) |
| `--source-asset` | Expected source token (enables V2) |
| `--purchase-id` and `--payer` | Together, enable the x402 `request_id` check (V6) |
| `--dest-tx` | Read this destination transaction instead of searching for it |
| `--from-block`, `--to-block`, `--lookback-blocks` | Source search window when only `--payment-id` is given (default lookback 100000 blocks) |
| `--max-scan-blocks` | How far past the deposit to look for `Released` / `Refunded` (default 50000) |
| `--dest-lookahead-seconds` | How long after the deposit to search the destination chain (default 3600) |
| `--request-delay-ms` | Minimum gap between RPC requests (default 200) |
| `--json` | Print the report as one JSON document |

Environment variables (public RPC overrides only):

- `ATUM_VERIFY_RPC_<chainId>=<url>` replaces the RPC list for that chain.
- `ATUM_VERIFY_LOG_RANGE_<chainId>=<blocks>` caps the `eth_getLogs` window for that chain.

### Example: sample 001

This is the real output of the command above, run once against the public RPC endpoints on 2026-10-06 at about 11:08 UTC (3 h 46 min (about 4 hours) after the deposit block, which is dated 07:22 UTC; the run took about 39 seconds at 300 ms between requests). It exited with code 0.

The offline replay from the captured fixtures (the snapshot used by the tests) does not pass `--lookback-blocks` or `--dest-lookahead-seconds`, so it uses the default search windows, and its fake chain ends at the end of the captured block window. Its report is the same as the real one except for two block ranges: the destination search range in V7 (`316289781..316291185` offline, `316289786..316293379` in the real run) and the refund scan range in V12 (`47751527..47751647` offline, `47751527..47758308` in the real run). All 15 checks, their statuses and every value read from chain are identical.

```text
atum-settlement-verifier 0.0.1
  source: Base Sepolia (eip155:84532, testnet)
  dest:   Arbitrum Sepolia (eip155:421614, testnet)

ID   STATUS       EVIDENCE                CHECK
V1   PASS         one-cross-chain-sample  Source tx emitted Deposited from the configured escrow
     -> Deposited from 0x0F875601504C9179562506AFa34b2D084268869b in successful tx 0x386f666af482685aeea3f13a6aa904e31333e048c1f2425bf5a9dc74c327de4b
V2   PASS         one-cross-chain-sample  Deposited.token equals the expected source asset and the payer's Transfer to escrow matches amount
     -> Transfer(0xd2F450592564202a2AbEdC622e703271C996d79d -> escrow, 50000) on 0x036CbD53842c5426634e7929541eC2318f3dCF7e
V3   PASS         one-cross-chain-sample  Deposited.amount <= FULFILLMENT_AMOUNT * (10000 + MARKUP_BPS) / 10000 (a spend cap, not an exact price)
     -> Deposited.amount 50000 <= cap 51500 (fee 10 is part of the amount)
V4   PASS         one-cross-chain-sample  Deposited.reserver / releaser equal the configured quote_selector / fulfillment_verifier
     -> reserver / releaser equal the configured quote_selector / fulfillment_verifier
V5   PASS         one-cross-chain-sample  DepositCommitments.destinationHash equals keccak256(lower(dest CAIP-19 asset) + '@' + lower(dest address))
     -> destinationHash matches keccak256("eip155:421614/erc20:0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d@0xfd1290ac16f8fcfd4b84c5b1604ba0e1ae1a273f")
V6   PASS         one-cross-chain-sample  DepositCommitments.depositRequestHash equals keccak256(request_id) derived from purchase id and payer (x402 only)
     -> depositRequestHash equals keccak256(req_x402_938003bbdf80468e558d3a89) (x402 derivation)
V6b  PASS         one-cross-chain-sample  The payment id equals Deposited.depositId
     -> payment id equals Deposited.depositId
V7   PASS         one-cross-chain-sample  Destination proxy emitted Fulfilled with the same quoteHash as Deposited
     -> Fulfilled from 0x1F1F8FA642bc5F530ba37F1Db3a656E9eB8BaFeb carries the same quoteHash (destination blocks 316289786..316293379)
V8   PASS         one-cross-chain-sample  Fulfilled.to, token and amount equal the expected destination address, asset and amount
     -> Fulfilled to 0xfd1290aC16f8FCfd4B84c5b1604bA0E1aE1A273f, token 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d, amount 50000 as expected
V9   PASS         one-cross-chain-sample  Destination tx contains an ERC20 Transfer to the recipient matching Fulfilled
     -> ERC20 Transfer of 50000 to 0xfd1290aC16f8FCfd4B84c5b1604bA0E1aE1A273f on 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d in the destination tx
V10  PASS         one-cross-chain-sample  Deposited.settler equals Fulfilled.settler
     -> settler 0x0eEE42EC90Eb7D1e53504fb508790e410a286A11 is the same on deposit, fulfillment and release
V11  PASS         one-cross-chain-sample  Released exists for the depositId and the settler received amount - feeAmount
     -> Released in 0x8194ed69a06b7b90f06aae2ee3196913546ab25bbd4e5e15b46b0053224d1341; settler received amount - fee = 49990
V12  PASS         partial-sample          No Refunded event for the depositId (only within the scanned block range)
     -> no Refunded for this depositId in blocks 47751527..47758308 (scan reached the chain head)
V13  PASS         one-cross-chain-sample  Time order: Deposited <= Fulfilled <= Released
     -> deposit 1791271342, fulfilled 1791271343, released 1791271348 (unix seconds; chains' clocks are compared as reported)
V14  PASS         none                    Batch (*Many) events: detected and reported; their contents are not verified
     -> no batch (*Many) events were found in the scanned ranges

Read from chain:
  depositTx: 0x386f666af482685aeea3f13a6aa904e31333e048c1f2425bf5a9dc74c327de4b
  depositBlock: 47751527
  depositTimestamp: 1791271342
  depositId: 0x8e731bb2dba644355e73f0cd8da6a32777a2b5ef1b68b248d6bd9c2110b9d5bb
  quoteHash: 0x15fc7798c729f7656db29d7b52169312eb7dc1e82211c8d4ebdc1cfa89ba1664
  depositor: 0xd2F450592564202a2AbEdC622e703271C996d79d
  settler: 0x0eEE42EC90Eb7D1e53504fb508790e410a286A11
  sourceToken: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
  sourceAmount: 50000
  feeAmount: 10
  depositRequestHash: 0xef67b8be998d1b93408f472efe7e6354917dc2b5a531ad0ebd0b5ab027e8a679
  destinationHash: 0x863ab2c2d44eeab961d3f26ccbbb7c2524de7ed060b2168fbc7f5a316dde28a1
  releaseTx: 0x8194ed69a06b7b90f06aae2ee3196913546ab25bbd4e5e15b46b0053224d1341
  releaseTimestamp: 1791271348
  fulfillmentTx: 0xe9e12b6a1edd55371212dd4a313b7b0431eb25154329901c6167c34225e72059
  fulfillmentBlock: 316290985
  fulfillmentTimestamp: 1791271343
  fulfilledTo: 0xfd1290aC16f8FCfd4B84c5b1604bA0E1aE1A273f
  fulfilledToken: 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d
  fulfilledAmount: 50000

Summary: 15 pass, 0 fail, 0 unknown, 0 unsupported
Overall: PASS (exit code 0)

Unofficial, read-only tool; not affiliated with Atum. Its logic was checked against one cross-chain sample. A pass means the listed checks held for this payment on the data the RPC returned; it is not a security guarantee.
```

With `--source-asset`, `--purchase-id` and `--payer` left out, V2 and V6 cannot run. They are reported as `UNKNOWN`, the report lists what is missing, and the exit code is 2:

```text
Not verified because an option was not given:
  V2: add --source-asset
  V6: add --purchase-id and --payer
...
Overall: INCONCLUSIVE (exit code 2)
```

All 15 checks passing here says the tool agrees with the one payment it was built from. It says nothing about other payments (see "Known limits").

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | For a verification run: the overall verdict is `pass`, every check passed, and no other verification outcome exits 0. (`--help` and `--version` also exit 0; they verify nothing, so only a verification run's 0 means `pass`) |
| 1 | At least one check failed |
| 2 | Inconclusive: some check is `unknown` or `unsupported` and none failed (also used for unexpected internal errors) |
| 3 | Usage error: bad or missing options. Nothing was queried |

## Networks

Network settings live in `src/config/testnet.ts` and `src/config/mainnet.ts`: the escrow, fulfillment proxy, `quote_selector` and verifier addresses, default public RPC endpoints, and the `eth_getLogs` block range per endpoint.

- **Testnet:** Base Sepolia, Arbitrum Sepolia, Tempo Moderato. **Tempo Moderato is configured, but no Tempo Moderato settlement has been analysed, so it is unverified;** only Base Sepolia and Arbitrum Sepolia were checked against a real sample. The addresses are a snapshot of the gateway's `/v1/defaults` response. Re-check them against the gateway before relying on the tool: the gateway is the source of truth, this repository is not.
- **Mainnet (experimental):** Base and Arbitrum One. Addresses come from the mainnet gateway's `/v1/defaults`. **No mainnet settlement has been analysed**, so results involving a mainnet network are labelled experimental.
- A network that is not configured is reported as `unsupported`.

## Known limits

Please read these before trusting a result.

1. **One sample.** The checks were built from, and tested against, one real **x402** settlement on **testnet**: a single forward payment from **Base Sepolia to Arbitrum Sepolia**, **USDC to USDC** (both 6 decimals, 1:1), handled by a **single settler** address. Every claim above is as strong as that one sample, no stronger.
2. **Mainnet is experimental.** Mainnet addresses were read from the gateway's defaults and from public source-verification and bytecode lookups. There is no mainnet sample; mainnet behaviour has not been observed.
3. **Refunds and batch events have no real samples.** The `Refunded` and `*Many` code paths are exercised only by synthetic tests built from the published contract ABI. A real refund or batch settlement may look different. The tool is built to say `fail`, `unknown` or `unsupported` for these, never `pass`, but that behaviour is untested against real data.
4. **`eth_getLogs` block ranges are partly assumed.** For Base Sepolia the limits of two public RPCs were read from their error messages. For Tempo Moderato a window of 5,000 blocks was seen to work. For Arbitrum Sepolia and the mainnets the ranges are conservative guesses that were never tested. The tool halves the window and retries (a bounded number of times) when an RPC rejects a range, and reports `unknown` if it cannot succeed.
5. **`request_id` derivation is verified for x402 only.** The rule (`req_x402_` plus the first 24 hex characters of `keccak256("atum-request:v1:" + purchaseId + ":" + lowercase payer)`) matched one x402 sample. MPP and PGC payments may derive it differently; the tool does not check them.
6. **The fee amount is not verified.** The sample shows a fee of 10 on 50000 (0.02%), taken out of the deposited amount. The fee formula and per-token fee settings are not read or checked.
7. **Refund absence is limited to the scanned range.** V12 passes only if the scan reached the chain head and a `Released` event was found; an old deposit beyond `--max-scan-blocks` gives `unknown`.
8. **The deposit-to-destination search is time-based.** The destination `Fulfilled` event is searched in a window around the deposit time. A fulfillment outside that window (or on a chain whose RPC prunes that history) yields `unknown`, or `fail` if the escrow already released the funds.
9. **Cross-chain clocks are compared as reported.** V13 compares block timestamps from two different chains.
10. **Reads are unconfirmed and use a single RPC at a time.** There is no finality check and no cross-checking between providers.
11. **A real query is many small requests, and public RPCs may rate-limit.** Verifying sample 001 took roughly 60 to 80 small requests (an estimate, not a measured count). The tool spaces requests out (`--request-delay-ms`, default 200) and treats an RPC error as `unknown`, but a busy or throttling public endpoint can still make a run fail or come back inconclusive. Set `ATUM_VERIFY_RPC_<chainId>` (for example `ATUM_VERIFY_RPC_84532`) to use your own RPC endpoint instead.
12. **Contract addresses are a snapshot** (see "Networks").
13. **The name does not imply any relationship with Atum.** This is an independent tool.

## Development

```sh
npm ci
npx tsc --noEmit      # typecheck
npx vitest run        # offline tests
```

- **Tests are fully offline.** A setup file makes any `fetch` call throw unless `LIVE=1` is set, and a fake in-memory JSON-RPC node serves the fixtures.
- **Fixtures** in `test/fixtures/real/` are raw public-RPC responses for sample 001 (three transaction receipts, the unfiltered `eth_getLogs` answers around them, and block timestamps), saved by `scripts/capture-sample-001.mjs`. They contain only public on-chain data. `test/fixtures/abi/` holds the full published contract ABIs that a test compares against the hand-written event signatures in `src/abi.ts`.
- **Negative tests** change one fact at a time (a one-digit `quoteHash` change, an amount one unit short, another recipient or asset, a missing or extra event, an event from the wrong contract, empty or malformed RPC answers, batch events, ...) and require that the result is never `pass`.
- **Live test:** skipped by default. `LIVE=1 npx vitest run test/live.test.ts` re-verifies sample 001 from the public RPCs with small windows and paced requests. It needs those RPCs to still serve the sample's history.

## License

MIT. See `LICENSE`.
