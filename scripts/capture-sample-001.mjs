// Saves the raw public-RPC responses behind sample 001 into test/fixtures/real/.
//
// Read-only and small: ~12 requests, spaced out, to two public testnet RPCs. Allowed methods only:
// eth_chainId, eth_blockNumber, eth_getTransactionReceipt, eth_getBlockByNumber, eth_getLogs.
// It never reads a key and never sends a transaction. Refuses to run unless LIVE=1 is set.
//
//   LIVE=1 node scripts/capture-sample-001.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.env.LIVE !== "1") {
  console.error("Refusing to run: this script queries live public RPCs. Set LIVE=1 to confirm.");
  process.exit(2);
}

const OUT = fileURLToPath(new URL("../test/fixtures/real/", import.meta.url));
const BASE = "https://sepolia.base.org";
const ARB = "https://sepolia-rollup.arbitrum.io/rpc";
const ESCROW = "0x0F875601504C9179562506AFa34b2D084268869b";
const PROXY = "0x1F1F8FA642bc5F530ba37F1Db3a656E9eB8BaFeb";
const TX = {
  deposit: "0x386f666af482685aeea3f13a6aa904e31333e048c1f2425bf5a9dc74c327de4b",
  release: "0x8194ed69a06b7b90f06aae2ee3196913546ab25bbd4e5e15b46b0053224d1341",
  fulfillment: "0xe9e12b6a1edd55371212dd4a313b7b0431eb25154329901c6167c34225e72059",
};
const DELAY_MS = 500;
const calls = [];
let id = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => "0x" + BigInt(n).toString(16);

async function rpc(label, url, method, params) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await sleep(DELAY_MS * attempt);
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const body = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
    if (!body.error) {
      calls.push({ label, chain: url === BASE ? "base-sepolia" : "arbitrum-sepolia", method, params });
      return body.result;
    }
    if (attempt === 3) throw new Error(`${label}: ${method} failed: ${JSON.stringify(body.error)}`);
  }
}
const save = (name, value) => writeFileSync(OUT + name, JSON.stringify(value, null, 2) + "\n");
const must = (cond, msg) => {
  if (!cond) throw new Error(`sanity check failed: ${msg}`);
};

mkdirSync(OUT, { recursive: true });

// ---- Base Sepolia (source)
const baseChainId = await rpc("base chain id", BASE, "eth_chainId", []);
must(BigInt(baseChainId) === 84532n, "Base Sepolia chain id");
const baseHead = BigInt(await rpc("base head", BASE, "eth_blockNumber", []));
const depositReceipt = await rpc("deposit receipt", BASE, "eth_getTransactionReceipt", [TX.deposit]);
const releaseReceipt = await rpc("release receipt", BASE, "eth_getTransactionReceipt", [TX.release]);
must(depositReceipt?.transactionHash === TX.deposit && depositReceipt.status === "0x1", "deposit receipt");
must(releaseReceipt?.transactionHash === TX.release && releaseReceipt.status === "0x1", "release receipt");
const depBlock = BigInt(depositReceipt.blockNumber);
const relBlock = BigInt(releaseReceipt.blockNumber);
const depBlockObj = await rpc("deposit block", BASE, "eth_getBlockByNumber", [hex(depBlock), false]);
const relBlockObj = await rpc("release block", BASE, "eth_getBlockByNumber", [hex(relBlock), false]);
// Unfiltered escrow logs for a small window: the real eth_getLogs answer around the sample (includes other payers' events).
const logsFrom = depBlock - 5n;
const logsTo = depBlock + 120n;
must(logsTo - logsFrom + 1n <= 500n, "window within the 500-block limit of this RPC");
const escrowLogs = await rpc("escrow logs", BASE, "eth_getLogs", [{ address: ESCROW, fromBlock: hex(logsFrom), toBlock: hex(logsTo) }]);

// ---- Arbitrum Sepolia (destination)
const arbChainId = await rpc("arbitrum chain id", ARB, "eth_chainId", []);
must(BigInt(arbChainId) === 421614n, "Arbitrum Sepolia chain id");
const fulfillReceipt = await rpc("fulfillment receipt", ARB, "eth_getTransactionReceipt", [TX.fulfillment]);
must(fulfillReceipt?.transactionHash === TX.fulfillment && fulfillReceipt.status === "0x1", "fulfillment receipt");
const destBlock = BigInt(fulfillReceipt.blockNumber);
const destBlockObj = await rpc("fulfillment block", ARB, "eth_getBlockByNumber", [hex(destBlock), false]);
const arbHead = BigInt(await rpc("arbitrum head", ARB, "eth_blockNumber", []));
const proxyFrom = destBlock - 200n;
const proxyTo = destBlock + 200n;
const proxyLogs = await rpc("proxy logs", ARB, "eth_getLogs", [{ address: PROXY, fromBlock: hex(proxyFrom), toBlock: hex(proxyTo) }]);

const pick = (b) => ({ number: b.number, timestamp: b.timestamp });
save("base-sepolia.deposit-receipt.json", depositReceipt);
save("base-sepolia.release-receipt.json", releaseReceipt);
save("arbitrum-sepolia.fulfill-receipt.json", fulfillReceipt);
save("base-sepolia.escrow-logs.json", escrowLogs);
save("arbitrum-sepolia.proxy-logs.json", proxyLogs);
save("capture-meta.json", {
  note: "Raw public-RPC results for sample 001. Block objects are reduced to number and timestamp.",
  capturedAtUtc: new Date().toISOString(),
  chains: { "base-sepolia": { chainId: baseChainId, headAtCapture: hex(baseHead), logsWindow: [hex(logsFrom), hex(logsTo)] }, "arbitrum-sepolia": { chainId: arbChainId, headAtCapture: hex(arbHead), logsWindow: [hex(proxyFrom), hex(proxyTo)] } },
  blocks: { deposit: pick(depBlockObj), release: pick(relBlockObj), fulfillment: pick(destBlockObj) },
  counts: { escrowLogs: escrowLogs.length, proxyLogs: proxyLogs.length },
  calls,
});
console.log(`saved to ${OUT.replace(process.cwd(), ".")}`);
console.log(`requests: ${calls.length}; escrow logs in window: ${escrowLogs.length}; proxy logs in window: ${proxyLogs.length}`);
