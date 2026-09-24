import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, type Address, type Hex } from 'viem';
import { BASE_SWAP, BaseSwapService, parseSwapAmount, QUOTER_ABI, ROUTER_ABI, TOKEN_ABI } from '../src/base-swap';
import type { EvmProvider } from '../src/wallet';

const ACCOUNT = `0x${'1'.repeat(40)}` as Address;
const HASH = `0x${'a'.repeat(64)}` as Hex;
const NOW = 1_790_208_000_000;
type Transaction = { to: Address; from?: Address; data: Hex; value?: Hex; chainId?: string; gas?: string };
class Provider extends EventEmitter implements EvmProvider {
  chain: string = BASE_SWAP.chainId;
  account: string = ACCOUNT;
  eth = 10n ** 18n;
  usdc = 1000_000000n;
  allowance = 0n;
  failSimulation = false;
  gas = 100000n;
  receiptStatus: string | null = null;
  send: (transaction: Transaction) => Promise<unknown> = async () => HASH;
  onSimulation: (() => void) | null = null;
  request = vi.fn(async ({ method, params = [] }: { method: string; params?: unknown[] }): Promise<unknown> => {
    if (method === 'eth_chainId') return this.chain;
    if (method === 'eth_accounts') return [this.account];
    if (method === 'eth_getBlockByNumber') return { number: '0x1000', timestamp: `0x${Math.floor(NOW / 1000).toString(16)}` };
    if (method === 'eth_getCode') return '0x60006000';
    if (method === 'eth_getBalance') return `0x${this.eth.toString(16)}`;
    if (method === 'eth_estimateGas') return `0x${this.gas.toString(16)}`;
    if (method === 'eth_gasPrice') return '0x3b9aca00';
    if (method === 'eth_sendTransaction') return this.send(params[0] as Transaction);
    if (method === 'eth_getTransactionReceipt') return this.receiptStatus === null ? null : { transactionHash: HASH, status: this.receiptStatus };
    if (method !== 'eth_call') throw new Error(`Unexpected method: ${method}`);
    const transaction = params[0] as Transaction;
    if (transaction.to === BASE_SWAP.usdc) {
      const call = decodeFunctionData({ abi: TOKEN_ABI, data: transaction.data });
      if (call.functionName === 'decimals') return encodeFunctionResult({ abi: TOKEN_ABI, functionName: 'decimals', result: 6 });
      if (call.functionName === 'balanceOf') return encodeFunctionResult({ abi: TOKEN_ABI, functionName: 'balanceOf', result: this.usdc });
      if (call.functionName === 'allowance') return encodeFunctionResult({ abi: TOKEN_ABI, functionName: 'allowance', result: this.allowance });
      if (call.functionName === 'approve') {
        this.onSimulation?.();
        if (this.failSimulation) throw new Error('execution reverted');
        return encodeFunctionResult({ abi: TOKEN_ABI, functionName: 'approve', result: true });
      }
    }
    if (transaction.to === BASE_SWAP.quoter) {
      const { args: [input] } = decodeFunctionData({ abi: QUOTER_ABI, data: transaction.data });
      // Synthetic prices only: the 0.05% pool is the best fixture route.
      const output = input.tokenIn.toLowerCase() === BASE_SWAP.usdc ? input.amountIn * 10n ** 12n / 2500n : input.amountIn * 2500n / 10n ** 12n;
      const adjusted = output * (input.fee === 500 ? 10000n : 9900n) / 10000n;
      return encodeFunctionResult({ abi: QUOTER_ABI, functionName: 'quoteExactInputSingle', result: [adjusted, 1n, 0, 60000n] });
    }
    if (transaction.to === BASE_SWAP.router) {
      this.onSimulation?.();
      if (this.failSimulation) throw new Error('execution reverted');
      const call = decodeFunctionData({ abi: ROUTER_ABI, data: transaction.data });
      if (call.functionName !== 'multicall') throw new Error('Expected deadline multicall');
      const swap = decodeFunctionData({ abi: ROUTER_ABI, data: call.args[1][0] });
      if (swap.functionName !== 'exactInputSingle') throw new Error('Expected exact input');
      return encodeFunctionResult({ abi: ROUTER_ABI, functionName: 'multicall', result: [encodeAbiParameters([{ type: 'uint256' }], [swap.args[0].amountOutMinimum + 1n]), '0x'] });
    }
    throw new Error('Unexpected contract');
  });
}

describe('Base swap preparation and wallet handoff', () => {
  let provider: Provider, service: BaseSwapService, stop: () => void;
  const sends = () => provider.request.mock.calls.filter(([request]) => request.method === 'eth_sendTransaction');
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    provider = new Provider(); service = new BaseSwapService(provider, ACCOUNT); stop = service.observe();
  });
  afterEach(() => { stop(); vi.useRealTimers(); });

  it.each(['0', '-1', '1e3', '1,5', 'NaN', ' 1', '1.0000001'])('rejects invalid or imprecise USDC amounts: %s', input => {
    expect(() => parseSwapAmount(input, 'buy')).toThrow();
  });
  it('preserves ETH precision and rejects excess decimals instead of rounding', () => {
    expect(parseSwapAmount('0.000000000000000001', 'sell')).toBe(1n);
    expect(() => parseSwapAmount('0.0000000000000000001', 'sell')).toThrow();
    expect(() => parseSwapAmount('9'.repeat(80), 'sell')).toThrow();
  });
  it('quotes with reads only, compares direct pools, and computes integer minimum output', async () => {
    const quote = await service.quote({ side: 'buy', amount: '25', slippageBps: 50 });
    expect(quote).toMatchObject({ poolFee: 500, amountIn: 25_000000n, amountOut: 10n ** 16n, minimumOut: 995n * 10n ** 13n, kind: 'approval' });
    expect(quote.gasLimit).toBe(120000n);
    expect(sends()).toHaveLength(0);
    expect(Object.isFrozen(quote)).toBe(true);
    expect(provider.request.mock.calls.filter(([request]) => request.method === 'eth_call' && (request.params![0] as Transaction).to === BASE_SWAP.quoter)).toHaveLength(4);
  });
  it('approves only the reviewed USDC amount for the fixed router, and never auto-submits a swap', async () => {
    const quote = await service.quote({ side: 'buy', amount: '25', slippageBps: 50 });
    expect(await service.submitReviewed(quote.id)).toMatchObject({ kind: 'approval', hash: HASH, status: 'pending' });
    const transaction = sends()[0][0].params![0] as Transaction;
    expect(transaction).toMatchObject({ to: BASE_SWAP.usdc, from: ACCOUNT, value: '0x0', chainId: '0x2105' });
    expect(decodeFunctionData({ abi: TOKEN_ABI, data: transaction.data })).toMatchObject({ functionName: 'approve', args: [expect.stringMatching(new RegExp(BASE_SWAP.router, 'i')), 25_000000n] });
    await expect(service.submitReviewed(quote.id)).rejects.toThrow('expired or changed');
    expect(sends()).toHaveLength(1);
  });
  it('buys native ETH using a deadline and atomic unwrap to the connected account', async () => {
    provider.allowance = provider.usdc;
    const quote = await service.quote({ side: 'buy', amount: '25', slippageBps: 100 });
    expect(quote.kind).toBe('swap'); await service.submitReviewed(quote.id);
    const transaction = sends()[0][0].params![0] as Transaction;
    expect(transaction).toMatchObject({ to: BASE_SWAP.router, value: '0x0', chainId: '0x2105' });
    const call = decodeFunctionData({ abi: ROUTER_ABI, data: transaction.data });
    expect(call.functionName).toBe('multicall'); if (call.functionName !== 'multicall') throw new Error('Wrong function');
    expect(call.args[0]).toBe(BigInt(NOW / 1000 + 180));
    const swap = decodeFunctionData({ abi: ROUTER_ABI, data: call.args[1][0] });
    if (swap.functionName !== 'exactInputSingle') throw new Error('Wrong function');
    expect(swap.args[0].recipient.toLowerCase()).toBe(BASE_SWAP.router);
    expect(swap.args[0].amountOutMinimum).toBe(quote.minimumOut);
    expect(decodeFunctionData({ abi: ROUTER_ABI, data: call.args[1][1] })).toMatchObject({ functionName: 'unwrapWETH9', args: [quote.minimumOut, ACCOUNT] });
  });
  it('sells native ETH with exact value, USDC recipient and refund of unspent ETH', async () => {
    const quote = await service.quote({ side: 'sell', amount: '0.01', slippageBps: 50 });
    await service.submitReviewed(quote.id);
    const transaction = sends()[0][0].params![0] as Transaction;
    expect(BigInt(transaction.value!)).toBe(10n ** 16n);
    const call = decodeFunctionData({ abi: ROUTER_ABI, data: transaction.data });
    if (call.functionName !== 'multicall') throw new Error('Wrong function');
    const swap = decodeFunctionData({ abi: ROUTER_ABI, data: call.args[1][0] });
    if (swap.functionName !== 'exactInputSingle') throw new Error('Wrong function');
    expect(swap.args[0].recipient).toBe(ACCOUNT);
    expect(swap.args[0].tokenIn.toLowerCase()).toBe(BASE_SWAP.weth);
    expect(swap.args[0].tokenOut.toLowerCase()).toBe(BASE_SWAP.usdc);
    expect(decodeFunctionData({ abi: ROUTER_ABI, data: call.args[1][1] }).functionName).toBe('refundETH');
  });
  it('rejects wrong networks and insufficient funds before asking to sign', async () => {
    provider.chain = '0x1';
    await expect(service.quote({ side: 'sell', amount: '0.01', slippageBps: 50 })).rejects.toThrow('Base Mainnet');
    provider.chain = BASE_SWAP.chainId; provider.eth = 0n;
    await expect(service.quote({ side: 'buy', amount: '25', slippageBps: 50 })).rejects.toThrow('enough ETH');
    provider.eth = 10n ** 18n; provider.usdc = 1n;
    await expect(service.quote({ side: 'buy', amount: '25', slippageBps: 50 })).rejects.toThrow('Insufficient USDC');
    expect(sends()).toHaveLength(0);
  });
  it.each(['accountsChanged', 'chainChanged', 'disconnect'])('invalidates reviewed quotes on %s', async event => {
    const quote = await service.quote({ side: 'sell', amount: '0.01', slippageBps: 50 });
    provider.emit(event);
    await expect(service.submitReviewed(quote.id)).rejects.toThrow('expired or changed');
    expect(sends()).toHaveLength(0);
  });
  it('rechecks identity immediately before wallet handoff even without wallet events', async () => {
    const quote = await service.quote({ side: 'sell', amount: '0.01', slippageBps: 50 });
    provider.onSimulation = () => { provider.account = `0x${'2'.repeat(40)}`; };
    await expect(service.submitReviewed(quote.id)).rejects.toThrow('account changed');
    expect(sends()).toHaveLength(0);
  });
  it('blocks expired quotes, altered IDs, changed allowances and failed simulations', async () => {
    let quote = await service.quote({ side: 'buy', amount: '25', slippageBps: 50 });
    await expect(service.submitReviewed('forged')).rejects.toThrow('expired or changed');
    vi.setSystemTime(NOW + 60_000);
    await expect(service.submitReviewed(quote.id)).rejects.toThrow('expired or changed');
    vi.setSystemTime(NOW); quote = await service.quote({ side: 'buy', amount: '25', slippageBps: 50 });
    provider.allowance = 25_000000n;
    await expect(service.submitReviewed(quote.id)).rejects.toThrow('allowance changed');
    quote = await service.quote({ side: 'buy', amount: '25', slippageBps: 50 });
    provider.failSimulation = true;
    await expect(service.submitReviewed(quote.id)).rejects.toThrow('reverted');
    expect(sends()).toHaveLength(0);
  });
  it('does not retry ambiguous submissions or reuse a consumed quote', async () => {
    const quote = await service.quote({ side: 'sell', amount: '0.01', slippageBps: 50 });
    provider.send = async () => { throw new Error('Connection lost after submission'); };
    await expect(service.submitReviewed(quote.id)).rejects.toThrow('Check wallet activity');
    await expect(service.submitReviewed(quote.id)).rejects.toThrow('expired or changed');
    expect(sends()).toHaveLength(1);
  });
  it('prevents duplicate wallet prompts while a request is pending and reports user rejection', async () => {
    const quote = await service.quote({ side: 'sell', amount: '0.01', slippageBps: 50 });
    let decline!: (reason: unknown) => void;
    provider.send = () => new Promise((_, reject) => { decline = reject; });
    const pending = service.submitReviewed(quote.id);
    const rejection = expect(pending).rejects.toThrow('declined');
    await vi.waitFor(() => expect(decline).toBeTypeOf('function'));
    await expect(service.submitReviewed(quote.id)).rejects.toThrow('already open');
    decline({ code: 4001 }); await rejection;
    expect(sends()).toHaveLength(1);
  });
  it('distinguishes pending, included and reverted receipts', async () => {
    expect(await service.receipt(HASH)).toBe('pending');
    provider.receiptStatus = '0x1'; expect(await service.receipt(HASH)).toBe('included');
    provider.receiptStatus = '0x0'; expect(await service.receipt(HASH)).toBe('reverted');
    provider.chain = '0x1'; await expect(service.receipt(HASH)).rejects.toThrow('Switch to Base');
  });
  it('rejects receipts read across a network change without a provider event', async () => {
    provider.receiptStatus = '0x1';
    const request = provider.request.getMockImplementation()!;
    provider.request.mockImplementation(async input => {
      const result = await request(input);
      if (input.method === 'eth_getTransactionReceipt') provider.chain = '0x1';
      return result;
    });
    await expect(service.receipt(HASH)).rejects.toThrow('Switch to Base');
    expect(sends()).toHaveLength(0);
  });
});
