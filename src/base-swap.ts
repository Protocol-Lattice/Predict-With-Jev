import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, formatUnits, parseAbi, parseUnits, type Address, type Hex } from 'viem';
import type { EvmProvider } from './wallet';

// Chain-specific deployments: Uniswap's Base deployment list and Circle's USDC list.
export const BASE_SWAP = Object.freeze({
  chainId: '0x2105',
  router: '0x2626664c2603336e57b271c5c0b26f421741e481' as Address,
  quoter: '0x3d4e44eb1374240ce5f1b871ab261cd16335b76a' as Address,
  weth: '0x4200000000000000000000000000000000000006' as Address,
  usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address,
});
export const TOKEN_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
export const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);
export const ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function refundETH() payable',
]);
export type SwapSide = 'buy' | 'sell';
export type TransactionKind = 'approval' | 'swap';
export interface SwapRequest { side: SwapSide; amount: string; slippageBps: number }
export interface SwapQuote {
  readonly id: string;
  readonly account: Address;
  readonly side: SwapSide;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly minimumOut: bigint;
  readonly slippageBps: number;
  readonly poolFee: number;
  readonly blockNumber: bigint;
  readonly expiresAt: number;
  readonly deadline: bigint;
  readonly kind: TransactionKind;
  readonly gasLimit: bigint;
  readonly estimatedL2Fee: bigint;
  readonly ethBalance: bigint;
  readonly usdcBalance: bigint;
}
export interface SubmittedSwap { hash: Hex; kind: TransactionKind; submittedAt: number; status: 'pending' | 'included' | 'reverted' }
export class SwapError extends Error {}
const FEES = [100, 500, 3000, 10000] as const;
const QUOTE_TTL = 60_000;
const UINT256_MAX = (1n << 256n) - 1n;
const HASH = /^0x[0-9a-f]{64}$/i;
const hex = (value: bigint): Hex => `0x${value.toString(16)}`;
function rpcHex(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-f]*$/i.test(value)) throw new SwapError('Invalid response from the wallet RPC.');
  return value as Hex;
}
function rpcNumber(value: unknown): bigint {
  const encoded = rpcHex(value);
  if (!/^0x[0-9a-f]{1,64}$/i.test(encoded)) throw new SwapError('Invalid numeric response from the wallet RPC.');
  return BigInt(encoded);
}
export function parseSwapAmount(amount: string, side: SwapSide): bigint {
  const decimals = side === 'buy' ? 6 : 18;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount) || amount.length > 80 || (amount.split('.')[1]?.length ?? 0) > decimals) {
    throw new SwapError(`Enter a positive ${side === 'buy' ? 'USDC' : 'ETH'} amount with at most ${decimals} decimal places.`);
  }
  const value = parseUnits(amount, decimals);
  if (value <= 0n || value > UINT256_MAX) throw new SwapError('The swap amount is outside the supported range.');
  return value;
}
export const swapUnits = (value: bigint, asset: 'ETH' | 'USDC') => formatUnits(value, asset === 'ETH' ? 18 : 6);

/** Build a bounded swap with an on-chain deadline, recipient, and minimum output. */
export function swapTransaction(quote: Pick<SwapQuote, 'account' | 'side' | 'amountIn' | 'minimumOut' | 'poolFee' | 'deadline'>) {
  const buy = quote.side === 'buy';
  const swap = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'exactInputSingle', args: [{
    tokenIn: buy ? BASE_SWAP.usdc : BASE_SWAP.weth, tokenOut: buy ? BASE_SWAP.weth : BASE_SWAP.usdc,
    fee: quote.poolFee, recipient: buy ? BASE_SWAP.router : quote.account,
    amountIn: quote.amountIn, amountOutMinimum: quote.minimumOut, sqrtPriceLimitX96: 0n,
  }] });
  const settlement = buy
    ? encodeFunctionData({ abi: ROUTER_ABI, functionName: 'unwrapWETH9', args: [quote.minimumOut, quote.account] })
    : encodeFunctionData({ abi: ROUTER_ABI, functionName: 'refundETH' });
  return { from: quote.account, to: BASE_SWAP.router, value: buy ? '0x0' as Hex : hex(quote.amountIn),
    data: encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [quote.deadline, [swap, settlement]] }) };
}
function approvalTransaction(account: Address, amount: bigint) {
  return { from: account, to: BASE_SWAP.usdc, value: '0x0' as Hex,
    data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'approve', args: [BASE_SWAP.router, amount] }) };
}
type Call = ReturnType<typeof swapTransaction>;

/** No timers or automatic signing. submitReviewed is called only by the user's confirmation button. */
export class BaseSwapService {
  private generation = 0;
  private disposed = false;
  private sending = false;
  private prepared: SwapQuote | null = null;
  constructor(private provider: EvmProvider, private account: Address, private now: () => number = Date.now) {}
  observe() {
    const invalidate = () => this.invalidate();
    for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) this.provider.on(event, invalidate);
    return () => {
      this.disposed = true; this.invalidate();
      for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) this.provider.removeListener(event, invalidate);
    };
  }
  invalidate() { this.generation++; this.prepared = null; }
  private guard(generation: number) {
    if (this.disposed || generation !== this.generation) throw new SwapError('Wallet or swap details changed. Request a new quote.');
  }
  private async read(method: string, params?: unknown[]): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.provider.request({ method, ...(params ? { params } : {}) }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SwapError('Wallet RPC timed out. Request a new quote.')), 15_000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private async identity(generation: number) {
    const [chain, accounts] = await Promise.all([this.read('eth_chainId'), this.read('eth_accounts')]);
    this.guard(generation);
    if (rpcNumber(chain) !== 8453n) throw new SwapError('Switch your wallet to Base Mainnet (chain 8453).');
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== this.account.toLowerCase()) {
      throw new SwapError('The connected account changed. Reconnect and request a new quote.');
    }
  }
  private async balances(block: Hex | 'latest' = 'latest') {
    const [eth, usdc, allowance] = await Promise.all([
      this.read('eth_getBalance', [this.account, block]),
      this.read('eth_call', [{ to: BASE_SWAP.usdc, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'balanceOf', args: [this.account] }) }, block]),
      this.read('eth_call', [{ to: BASE_SWAP.usdc, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'allowance', args: [this.account, BASE_SWAP.router] }) }, block]),
    ]);
    return { eth: rpcNumber(eth), usdc: decodeFunctionResult({ abi: TOKEN_ABI, functionName: 'balanceOf', data: rpcHex(usdc) }),
      allowance: decodeFunctionResult({ abi: TOKEN_ABI, functionName: 'allowance', data: rpcHex(allowance) }) };
  }
  private async simulate(transaction: Call, kind: TransactionKind, minimumOut: bigint) {
    const raw = rpcHex(await this.read('eth_call', [transaction, 'latest']));
    if (kind === 'approval') {
      if (!decodeFunctionResult({ abi: TOKEN_ABI, functionName: 'approve', data: raw })) throw new SwapError('USDC approval simulation failed.');
    } else {
      const results = decodeFunctionResult({ abi: ROUTER_ABI, functionName: 'multicall', data: raw });
      if (results.length !== 2 || decodeAbiParameters([{ type: 'uint256' }], results[0])[0] < minimumOut) throw new SwapError('Swap simulation returned too little output. Request a new quote.');
    }
  }
  async quote(input: SwapRequest): Promise<SwapQuote> {
    if (this.sending) throw new SwapError('Complete the open wallet request first.');
    this.invalidate(); const generation = this.generation;
    if (!['buy', 'sell'].includes(input.side) || !Number.isInteger(input.slippageBps) || input.slippageBps < 1 || input.slippageBps > 100) throw new SwapError('Choose BUY or SELL and slippage from 0.01% to 1%.');
    const amountIn = parseSwapAmount(input.amount, input.side);
    await this.identity(generation);
    const block = await this.read('eth_getBlockByNumber', ['latest', false]) as { number?: unknown; timestamp?: unknown } | null;
    if (!block) throw new SwapError('The latest Base block is unavailable.');
    const blockNumber = rpcNumber(block.number), blockTime = rpcNumber(block.timestamp);
    if (Math.abs(Number(blockTime) * 1000 - this.now()) > 60_000) throw new SwapError('Base block data is stale or the computer clock is incorrect.');
    const blockTag = hex(blockNumber);
    const [codes, decimals, balances] = await Promise.all([
      Promise.all([BASE_SWAP.router, BASE_SWAP.quoter, BASE_SWAP.usdc, BASE_SWAP.weth].map(address => this.read('eth_getCode', [address, blockTag]))),
      this.read('eth_call', [{ to: BASE_SWAP.usdc, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'decimals' }) }, blockTag]),
      this.balances(blockTag),
    ]);
    this.guard(generation);
    if (codes.some(code => !/^0x[0-9a-f]{2,}$/i.test(String(code))) || decodeFunctionResult({ abi: TOKEN_ABI, functionName: 'decimals', data: rpcHex(decimals) }) !== 6) throw new SwapError('Base contract verification failed.');
    if ((input.side === 'buy' ? balances.usdc : balances.eth) < amountIn) throw new SwapError(`Insufficient ${input.side === 'buy' ? 'USDC' : 'ETH'} balance on Base.`);
    const routes = await Promise.allSettled(FEES.map(async fee => {
      const data = encodeFunctionData({ abi: QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [{
        tokenIn: input.side === 'buy' ? BASE_SWAP.usdc : BASE_SWAP.weth, tokenOut: input.side === 'buy' ? BASE_SWAP.weth : BASE_SWAP.usdc,
        amountIn, fee, sqrtPriceLimitX96: 0n,
      }] });
      const result = decodeFunctionResult({ abi: QUOTER_ABI, functionName: 'quoteExactInputSingle', data: rpcHex(await this.read('eth_call', [{ to: BASE_SWAP.quoter, data }, blockTag])) });
      return { fee, amountOut: result[0] };
    }));
    this.guard(generation);
    const usable = routes.flatMap(route => route.status === 'fulfilled' && route.value.amountOut > 0n ? [route.value] : []);
    const best = usable.reduce<typeof usable[number] | null>((best, value) => !best || value.amountOut > best.amountOut ? value : best, null);
    if (!best) throw new SwapError('No usable Uniswap v3 ETH/USDC pool quote. No transaction was requested.');
    const minimumOut = best.amountOut * BigInt(10_000 - input.slippageBps) / 10_000n;
    if (minimumOut <= 0n) throw new SwapError('Amount is too small for a bounded swap.');
    const kind: TransactionKind = input.side === 'buy' && balances.allowance < amountIn ? 'approval' : 'swap';
    const draft = { account: this.account, side: input.side, amountIn, minimumOut, poolFee: best.fee, deadline: blockTime + 180n };
    const transaction = kind === 'approval' ? approvalTransaction(this.account, amountIn) : swapTransaction(draft);
    await this.simulate(transaction, kind, minimumOut);
    const [gas, price] = await Promise.all([this.read('eth_estimateGas', [transaction]), this.read('eth_gasPrice')]);
    const gasLimit = rpcNumber(gas) * 120n / 100n;
    const estimatedL2Fee = gasLimit * rpcNumber(price);
    if (gasLimit === 0n || balances.eth < (kind === 'swap' && input.side === 'sell' ? amountIn : 0n) + estimatedL2Fee) throw new SwapError('Keep enough ETH on Base for the input and network fees.');
    await this.identity(generation);
    if (this.now() >= Number(blockTime) * 1000 + QUOTE_TTL) throw new SwapError('Quote preparation took too long. Request a new quote.');
    this.prepared = Object.freeze({ ...draft, id: crypto.randomUUID(), amountOut: best.amountOut, slippageBps: input.slippageBps,
      blockNumber, expiresAt: Math.min(this.now() + QUOTE_TTL, Number(blockTime) * 1000 + QUOTE_TTL), kind,
      gasLimit, estimatedL2Fee, ethBalance: balances.eth, usdcBalance: balances.usdc });
    return this.prepared;
  }

  async submitReviewed(id: string): Promise<SubmittedSwap> {
    if (this.sending) throw new SwapError('A wallet request is already open.');
    const quote = this.prepared;
    if (!quote || quote.id !== id || this.now() >= quote.expiresAt) throw new SwapError('Quote expired or changed. Request and review a new quote.');
    this.sending = true;
    const generation = this.generation;
    let walletRequested = false;
    try {
      await this.identity(generation);
      const balances = await this.balances();
      if ((quote.side === 'buy' ? balances.usdc : balances.eth) < quote.amountIn) throw new SwapError('Available balance changed. Request a new quote.');
      if (quote.side === 'buy' && (balances.allowance < quote.amountIn) !== (quote.kind === 'approval')) throw new SwapError('USDC allowance changed. Request a new quote.');
      const transaction = quote.kind === 'approval' ? approvalTransaction(quote.account, quote.amountIn) : swapTransaction(quote);
      await this.simulate(transaction, quote.kind, quote.minimumOut);
      const gas = rpcNumber(await this.read('eth_estimateGas', [transaction]));
      if (gas > quote.gasLimit) throw new SwapError('Gas requirements changed. Request a new quote.');
      const gasPrice = rpcNumber(await this.read('eth_gasPrice'));
      if (balances.eth < (quote.side === 'sell' && quote.kind === 'swap' ? quote.amountIn : 0n) + quote.gasLimit * gasPrice) throw new SwapError('Insufficient ETH for the transaction and current gas estimate.');
      await this.identity(generation);
      if (this.now() >= quote.expiresAt) throw new SwapError('Quote expired during checks. Request a new quote.');
      this.prepared = null;
      walletRequested = true;
      // Never retry this RPC, time it out, or follow approval with an automatic swap.
      const hash = await this.provider.request({ method: 'eth_sendTransaction', params: [{ ...transaction, chainId: BASE_SWAP.chainId, gas: hex(quote.gasLimit) }] });
      if (typeof hash !== 'string' || !HASH.test(hash)) throw new SwapError('Wallet returned no valid transaction hash. Check wallet activity before trying again.');
      return { hash: hash as Hex, kind: quote.kind, submittedAt: this.now(), status: 'pending' };
    } catch (error) {
      this.prepared = null;
      if (walletRequested && !(error instanceof SwapError)) {
        if (error && typeof error === 'object' && (error as { code?: unknown }).code === 4001) throw new SwapError('Transaction declined in the wallet.');
        throw new SwapError('Wallet did not confirm submission. Check wallet activity before trying again; this request will not be retried automatically.');
      }
      throw error;
    } finally { this.sending = false; }
  }
  async receipt(hash: Hex): Promise<SubmittedSwap['status']> {
    if (!HASH.test(hash)) throw new SwapError('Invalid transaction hash.');
    const generation = this.generation;
    if (rpcNumber(await this.read('eth_chainId')) !== 8453n) throw new SwapError('Switch to Base to check this receipt, or open BaseScan.');
    const receipt = await this.read('eth_getTransactionReceipt', [hash]) as { transactionHash?: unknown; status?: unknown } | null;
    if (rpcNumber(await this.read('eth_chainId')) !== 8453n) throw new SwapError('Switch to Base to check this receipt, or open BaseScan.');
    this.guard(generation);
    if (receipt === null) return 'pending';
    if (receipt.transactionHash !== hash || !['0x0', '0x1'].includes(String(receipt.status))) throw new SwapError('Invalid transaction receipt. Check BaseScan.');
    return receipt.status === '0x1' ? 'included' : 'reverted';
  }
}

export function swapErrorMessage(error: unknown) {
  if (error instanceof SwapError) return error.message;
  return 'The contract call could not be completed. Check Base connectivity, balances and pool liquidity, then request a new quote.';
}
