/** Public RPC reads and eth_call only. No wallet, keys, approvals, or broadcasts. */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, formatUnits, type Hex } from 'viem';
import { BASE_SWAP, QUOTER_ABI, ROUTER_ABI, TOKEN_ABI, swapTransaction } from '../src/base-swap.js';

const RPC = 'https://mainnet.base.org';
let id = 0;
async function read(method: string, params: unknown[] = []) {
  assert(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'].includes(method));
  for (let attempt = 0; attempt < 4; attempt++) {
    await delay(attempt ? 1000 * 2 ** attempt : 400);
    const response = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(15_000) });
    if (response.status === 429 && attempt < 3) { await response.text(); continue; }
    if (!response.ok) throw new Error(`Base RPC returned HTTP ${response.status}`);
    const result = await response.json() as { result?: unknown; error?: { code?: number; message: string } };
    if (result.error?.code === 429 && attempt < 3) continue;
    if (result.error) throw new Error(result.error.message);
    return result.result;
  }
  throw new Error('Base RPC rate limit persisted');
}

assert.equal(BigInt(await read('eth_chainId') as string), 8453n);
const block = await read('eth_getBlockByNumber', ['latest', false]) as { number: Hex; timestamp: Hex };
for (const [name, address] of Object.entries(BASE_SWAP).filter(([name]) => name !== 'chainId')) {
  assert.match(String(await read('eth_getCode', [address, block.number])), /^0x[0-9a-f]{2,}$/i, `${name} has no bytecode`);
}
const decimals = await read('eth_call', [{ to: BASE_SWAP.usdc, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'decimals' }) }, block.number]) as Hex;
assert.equal(decodeFunctionResult({ abi: TOKEN_ABI, functionName: 'decimals', data: decimals }), 6);
const dummyAccount = '0x1111111111111111111111111111111111111111';
const amountIn = 10n ** 15n;
const quotes: { fee: number; amountOut: bigint }[] = [];
for (const fee of [100, 500, 3000, 10000]) {
  const data = encodeFunctionData({ abi: QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [{ tokenIn: BASE_SWAP.weth,
    tokenOut: BASE_SWAP.usdc, amountIn, fee, sqrtPriceLimitX96: 0n }] });
  try {
    const result = await read('eth_call', [{ to: BASE_SWAP.quoter, data }, block.number]) as Hex;
    const amountOut = decodeFunctionResult({ abi: QUOTER_ABI, functionName: 'quoteExactInputSingle', data: result })[0];
    if (amountOut > 0n) quotes.push({ fee, amountOut });
  } catch (error) { console.warn(`Pool ${fee}: ${error instanceof Error ? error.message : 'quote unavailable'}`); }
}
assert(quotes.length > 0, 'No valid direct-pool quotes');
const best = quotes.reduce((best, quote) => quote.amountOut > best.amountOut ? quote : best);
const minimumOut = best.amountOut * 995n / 1000n;
const transaction = swapTransaction({ account: dummyAccount, side: 'sell', amountIn, minimumOut, poolFee: best.fee, deadline: BigInt(block.timestamp) + 180n });
// A hypothetical balance exists only inside this eth_call, never on the network.
const simulated = await read('eth_call', [transaction, block.number, { [dummyAccount]: { balance: '0x56bc75e2d63100000' } }]) as Hex;
const results = decodeFunctionResult({ abi: ROUTER_ABI, functionName: 'multicall', data: simulated });
assert.equal(results.length, 2);
assert(decodeAbiParameters([{ type: 'uint256' }], results[0])[0] >= minimumOut);
const approval = encodeFunctionData({ abi: TOKEN_ABI, functionName: 'approve', args: [BASE_SWAP.router, 1_000000n] });
const approvalResult = await read('eth_call', [{ from: dummyAccount, to: BASE_SWAP.usdc, data: approval }, block.number]) as Hex;
assert.equal(decodeFunctionResult({ abi: TOKEN_ABI, functionName: 'approve', data: approvalResult }), true);
console.log(`Base block ${BigInt(block.number)}: contract code, native USDC decimals, ${quotes.length} pool quotes, router simulation and approval eth_call passed.`);
console.log(`Read-only sample: 0.001 ETH -> ${formatUnits(best.amountOut, 6)} USDC before gas. No transaction was signed or broadcast.`);
