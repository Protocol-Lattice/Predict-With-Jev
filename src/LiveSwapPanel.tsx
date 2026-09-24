import { useEffect, useRef, useState } from 'react';
import { ArrowRightLeft, ExternalLink, RefreshCw } from 'lucide-react';
import type { Address } from 'viem';
import { BASE_SWAP, BaseSwapService, swapErrorMessage, swapUnits, type SubmittedSwap, type SwapQuote, type SwapSide } from './base-swap';
import type { EvmProvider, WalletState } from './wallet';

const TRANSACTION_KEY = 'jev-base-last-transaction';
function savedTransaction(): SubmittedSwap | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(TRANSACTION_KEY) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const item = value as SubmittedSwap;
    return typeof item.hash === 'string' && /^0x[0-9a-f]{64}$/i.test(item.hash) && ['approval', 'swap'].includes(item.kind)
      && ['pending', 'included', 'reverted'].includes(item.status) && Number.isSafeInteger(item.submittedAt) && item.submittedAt > 0 ? item : null;
  } catch { return null; }
}

export default function LiveSwapPanel({ provider, wallet, enabled }: { provider: EvmProvider | null; wallet: WalletState; enabled: boolean }) {
  const [side, setSide] = useState<SwapSide>('buy');
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState(50);
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [busy, setBusy] = useState<'quote' | 'wallet' | 'network' | null>(null);
  const [error, setError] = useState('');
  const [receiptError, setReceiptError] = useState('');
  const [transaction, setTransaction] = useState<SubmittedSwap | null>(savedTransaction);
  const [now, setNow] = useState(Date.now());
  const client = useRef<BaseSwapService | null>(null);
  const operation = useRef(0);
  const sending = useRef(false);
  const [storageError, setStorageError] = useState('');
  const onBase = wallet.chainId === BASE_SWAP.chainId;
  const connected = wallet.status === 'connected' && Boolean(wallet.account && provider);
  const inputAsset = side === 'buy' ? 'USDC' : 'ETH';
  const outputAsset = side === 'buy' ? 'ETH' : 'USDC';
  const expiresIn = quote ? Math.max(0, Math.ceil((quote.expiresAt - now) / 1000)) : 0;
  const pending = transaction?.status === 'pending';

  useEffect(() => {
    operation.current++; setQuote(null); setError('');
    if (!enabled || !provider || !wallet.account || !onBase) { client.current = null; return; }
    const service = new BaseSwapService(provider, wallet.account as Address);
    client.current = service;
    const stop = service.observe();
    return () => { stop(); client.current = null; operation.current++; };
  }, [provider, wallet.account, onBase, enabled]);
  useEffect(() => {
    if (!quote) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [quote]);

  function saveTransaction(value: SubmittedSwap) {
    setTransaction(value);
    try { localStorage.setItem(TRANSACTION_KEY, JSON.stringify(value)); setStorageError(''); }
    catch { setStorageError('Browser storage is unavailable. Save the BaseScan link before closing this page.'); }
  }
  useEffect(() => {
    const service = client.current;
    if (!service || !transaction || transaction.status !== 'pending') return;
    let cancelled = false, checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const status = await service.receipt(transaction.hash);
        if (cancelled) return;
        setReceiptError('');
        if (status !== 'pending') saveTransaction({ ...transaction, status });
      } catch (error) { if (!cancelled) setReceiptError(swapErrorMessage(error)); }
      finally { checking = false; }
    };
    void check(); const timer = setInterval(() => void check(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [transaction, provider, wallet.account, onBase, enabled]);

  function changed() { operation.current++; client.current?.invalidate(); setQuote(null); setError(''); }
  async function getQuote() {
    if (!enabled || !connected || !onBase || !client.current || busy || sending.current || pending) return;
    const service = client.current, revision = ++operation.current;
    setQuote(null); setBusy('quote'); setError('');
    try {
      const result = await service.quote({ side, amount, slippageBps: slippage });
      if (revision === operation.current) { setQuote(result); setNow(Date.now()); }
    } catch (error) { if (revision === operation.current) setError(swapErrorMessage(error)); }
    finally { setBusy(null); }
  }
  async function confirm() {
    if (!enabled || !connected || !onBase || !client.current || !quote || busy || sending.current || pending) return;
    sending.current = true; setBusy('wallet'); setError('');
    try {
      // The reviewed quote ID is the only argument; transaction recipients and amounts cannot be supplied by the form here.
      const submitted = await client.current.submitReviewed(quote.id);
      saveTransaction(submitted);
    } catch (error) { setError(swapErrorMessage(error)); }
    finally { setQuote(null); setBusy(null); sending.current = false; }
  }
  async function switchNetwork() {
    if (!provider || busy) return;
    changed(); setBusy('network');
    try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_SWAP.chainId }] }); }
    catch { setError('Select Base Mainnet (chain 8453) in your wallet, then reconnect if necessary.'); }
    finally { setBusy(null); }
  }

  return <section className="panel live-swap-panel">
    <div className="panel-title"><div><ArrowRightLeft size={17} /><h2>Base · ETH / USDC</h2></div><span className="mini-pill live-pill">Real funds · Manual</span></div>
    <div className="trading-panel-body">
      <p>BUY ETH with USDC or SELL ETH for USDC on Base Mainnet. Review the quote here, then approve each transaction in your wallet. Paper decisions never trigger this form.</p>
      {!enabled && <p className="trading-note">Live swaps are disabled in demo mode and while the server environment is being checked.</p>}
      {enabled && !connected && <p className="trading-note">Connect your wallet to load a quote. Amounts and transactions require your input.</p>}
      {enabled && connected && !onBase && <div className="trading-actions"><button className="button secondary" disabled={Boolean(busy)} onClick={() => void switchNetwork()}>Switch wallet to Base</button></div>}
      <form onSubmit={event => { event.preventDefault(); void getQuote(); }}>
        <fieldset className="paper-fields" disabled={!enabled || !connected || !onBase || Boolean(busy) || pending}>
          <label htmlFor="live-side">Action<select id="live-side" value={side} onChange={event => { changed(); setSide(event.target.value as SwapSide); setAmount(''); }}><option value="buy">BUY ETH — pay USDC</option><option value="sell">SELL ETH — receive USDC</option></select></label>
          <label htmlFor="live-amount">Pay amount, {inputAsset}<input id="live-amount" type="text" inputMode="decimal" autoComplete="off" required placeholder={inputAsset === 'USDC' ? 'USDC amount' : 'ETH amount'} value={amount} onChange={event => { changed(); setAmount(event.target.value); }} /></label>
          <label htmlFor="live-slippage">Slippage tolerance<select id="live-slippage" value={slippage} onChange={event => { changed(); setSlippage(Number(event.target.value)); }}><option value={10}>0.1%</option><option value={50}>0.5%</option><option value={100}>1%</option></select></label>
          <button className="button secondary" type="submit" disabled={!amount.trim()}><RefreshCw size={14} />{busy === 'quote' ? 'Checking Base…' : 'Get live quote'}</button>
        </fieldset>
      </form>
      {quote && <div className="swap-review">
        <div className="swap-review-title"><strong>Review {quote.kind === 'approval' ? 'USDC approval' : 'swap'}</strong><span>{expiresIn ? `${expiresIn}s remaining` : 'Quote expired'}</span></div>
        <dl>
          <div><dt>You pay</dt><dd>{swapUnits(quote.amountIn, inputAsset)} {inputAsset}</dd></div>
          <div><dt>Quoted output</dt><dd>{swapUnits(quote.amountOut, outputAsset)} {outputAsset}</dd></div>
          <div><dt>Minimum received</dt><dd>{swapUnits(quote.minimumOut, outputAsset)} {outputAsset}</dd></div>
          <div><dt>Pool fee (included in quote)</dt><dd>{quote.poolFee / 10_000}%</dd></div>
          <div><dt>{quote.kind === 'approval' ? 'Approval' : 'Swap'} L2 gas estimate</dt><dd>{swapUnits(quote.estimatedL2Fee, 'ETH')} ETH</dd></div>
          <div><dt>Base balances</dt><dd>{swapUnits(quote.ethBalance, 'ETH')} ETH · {swapUnits(quote.usdcBalance, 'USDC')} USDC</dd></div>
          <div><dt>Receive at</dt><dd className="mono">{quote.account}</dd></div>
        </dl>
        <p className="trading-note">Gas estimate includes a 20% gas-limit buffer and excludes Base L1 data fees. Your wallet displays the final network fee. The quote compares four direct Uniswap v3 pools; it does not search all DEXs or multi-hop routes.</p>
        {quote.kind === 'approval' && <p className="trading-note">First authorize exactly {swapUnits(quote.amountIn, 'USDC')} USDC for the <a href={`https://basescan.org/address/${BASE_SWAP.router}`} target="_blank" rel="noreferrer">Uniswap router</a>. This is a separate paid transaction. After inclusion, request a new quote and confirm the swap separately.</p>}
        <button className="button primary" disabled={!expiresIn || Boolean(busy) || pending} onClick={() => void confirm()}>{busy === 'wallet' ? 'Check your wallet…' : quote.kind === 'approval' ? `Approve ${swapUnits(quote.amountIn, 'USDC')} USDC in wallet` : 'Confirm swap in wallet'}</button>
      </div>}
      {transaction && <div className="swap-transaction" role="status">
        <strong>{transaction.kind === 'approval' ? 'USDC approval' : 'Swap'} · {transaction.status === 'included' ? 'Included on Base' : transaction.status === 'reverted' ? 'Reverted on Base' : 'Submitted · awaiting receipt'}</strong>
        <a href={`https://basescan.org/tx/${transaction.hash}`} target="_blank" rel="noreferrer">View transaction on BaseScan <ExternalLink size={12} /></a>
        {transaction.kind === 'approval' && transaction.status === 'included' && <p className="trading-note">Approval included. Get a new quote to review the swap.</p>}
        {transaction.status === 'pending' && <p className="trading-note">New submissions are paused until this receipt is resolved. If you replaced or cancelled it in the wallet, check BaseScan and use the button below to acknowledge the pending entry.</p>}
        {transaction.status === 'pending' && <button className="button secondary" disabled={Boolean(busy)} onClick={() => { setTransaction(null); try { localStorage.removeItem(TRANSACTION_KEY); } catch {} }}>I checked wallet activity — dismiss pending entry</button>}
        {receiptError && <p className="trading-error">{receiptError}</p>}
        {storageError && <p className="trading-error">{storageError}</p>}
      </div>}
      {error && <p className="trading-error" role="alert">{error}</p>}
      <p className="trading-note">Native <a href={`https://basescan.org/address/${BASE_SWAP.usdc}`} target="_blank" rel="noreferrer">Circle USDC</a> only. ETH wrapping/unwrapping is handled in the swap. The app never requests a seed phrase or private key. A submitted transaction cannot be cancelled by disconnecting this page.</p>
    </div>
  </section>;
}
