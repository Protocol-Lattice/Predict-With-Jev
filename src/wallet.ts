export interface EvmProvider {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}
export interface WalletOption { id: string; name: string; provider: EvmProvider }
export interface WalletState {
  status: 'disconnected' | 'connecting' | 'connected';
  name: string | null;
  account: string | null;
  chainId: string | null;
  balance: string | null;
  error: string | null;
  refreshing: boolean;
}
const emptyState = (): WalletState => ({ status: 'disconnected', name: null, account: null, chainId: null, balance: null, error: null, refreshing: false });
function isProvider(value: unknown): value is EvmProvider {
  if (!value || typeof value !== 'object') return false;
  const provider = value as Partial<EvmProvider>;
  return typeof provider.request === 'function' && typeof provider.on === 'function' && typeof provider.removeListener === 'function';
}

/** EIP-6963 discovery never requests accounts or renders untrusted provider icons. */
export function discoverWallets(target: EventTarget & { ethereum?: unknown }, update: (wallets: WalletOption[]) => void): () => void {
  const wallets = new Map<string, WalletOption>();
  const announce = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!detail || typeof detail !== 'object') return;
    const { info, provider } = detail as { info?: { uuid?: unknown; name?: unknown }; provider?: unknown };
    if (!info || typeof info.uuid !== 'string' || !/^[0-9a-f-]{36}$/i.test(info.uuid)
      || typeof info.name !== 'string' || !info.name.trim() || info.name.length > 80 || !isProvider(provider) || wallets.size >= 32) return;
    if (wallets.has(info.uuid)) return;
    for (const [id, wallet] of wallets) if (wallet.provider === provider) wallets.delete(id);
    wallets.set(info.uuid, { id: info.uuid, name: info.name, provider });
    update([...wallets.values()]);
  };
  target.addEventListener('eip6963:announceProvider', announce);
  const request = () => {
    target.dispatchEvent(new Event('eip6963:requestProvider'));
    if (!wallets.size && isProvider(target.ethereum)) {
      wallets.set('injected', { id: 'injected', name: 'Browser EVM wallet', provider: target.ethereum });
      update([...wallets.values()]);
    }
  };
  target.addEventListener('ethereum#initialized', request);
  request();
  return () => {
    target.removeEventListener('eip6963:announceProvider', announce);
    target.removeEventListener('ethereum#initialized', request);
  };
}

function accounts(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !/^0x[0-9a-f]{40}$/i.test(item))) throw new Error('Invalid wallet accounts.');
  return value as string[];
}
function quantity(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(value)) throw new Error('Invalid wallet quantity.');
  return `0x${BigInt(value).toString(16)}`;
}
function walletError(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (code === 4001) return 'Connection declined in the wallet. You can try again.';
  if (code === -32002) return 'A wallet request is already open. Complete it in your extension.';
  if (code === 4100) return 'Wallet access is not authorized. Connect again.';
  if (code === 4900 || code === 4901) return 'The wallet is disconnected from its network.';
  return 'Could not read the wallet. Unlock your extension and check its network, then reconnect.';
}

/** Read-only connection. This class intentionally has no signing or transaction methods. */
export class WalletConnection {
  private state = emptyState();
  private revision = 0;
  private wallet: WalletOption | null = null;
  private cleanup: (() => void) | null = null;
  constructor(private update: (state: WalletState) => void) {}
  connectedProvider(): EvmProvider | null { return this.state.status === 'connected' && this.state.account ? this.wallet?.provider ?? null : null; }
  private publish(patch: Partial<WalletState>) { this.state = { ...this.state, ...patch }; this.update({ ...this.state }); }

  disconnect() {
    this.revision++;
    this.cleanup?.(); this.cleanup = null; this.wallet = null;
    this.state = emptyState(); this.update({ ...this.state });
  }
  async connect(wallet: WalletOption): Promise<void> {
    this.disconnect();
    this.wallet = wallet;
    const revision = ++this.revision;
    this.publish({ status: 'connecting', name: wallet.name });
    const changed = () => { void this.refresh(); };
    const disconnected = () => this.disconnect();
    try {
      wallet.provider.on('accountsChanged', changed);
      wallet.provider.on('chainChanged', changed);
      wallet.provider.on('disconnect', disconnected);
      this.cleanup = () => {
        wallet.provider.removeListener('accountsChanged', changed);
        wallet.provider.removeListener('chainChanged', changed);
        wallet.provider.removeListener('disconnect', disconnected);
      };
      const granted = accounts(await wallet.provider.request({ method: 'eth_requestAccounts' }));
      if (this.revision !== revision) return;
      if (!granted.length) { this.disconnect(); return; }
      await this.refresh();
    } catch (error) {
      if (this.revision !== revision) return;
      this.disconnect(); this.publish({ error: walletError(error) });
    }
  }
  async refresh(): Promise<void> {
    const wallet = this.wallet;
    if (!wallet) return;
    const revision = ++this.revision;
    this.publish({ account: null, chainId: null, balance: null, error: null, refreshing: true });
    try {
      const granted = accounts(await wallet.provider.request({ method: 'eth_accounts' }));
      if (revision !== this.revision) return;
      if (!granted.length) { this.disconnect(); return; }
      const account = granted[0];
      const chainId = quantity(await wallet.provider.request({ method: 'eth_chainId' }));
      if (revision !== this.revision) return;
      const balance = quantity(await wallet.provider.request({ method: 'eth_getBalance', params: [account, 'latest'] }));
      if (revision !== this.revision) return;
      // An extension may change networks while an RPC request is still pending.
      const currentChain = quantity(await wallet.provider.request({ method: 'eth_chainId' }));
      const currentAccounts = accounts(await wallet.provider.request({ method: 'eth_accounts' }));
      if (revision !== this.revision) return;
      if (currentChain !== chainId || currentAccounts[0]?.toLowerCase() !== account.toLowerCase()) {
        this.publish({ status: 'connected', refreshing: false, error: 'The wallet changed while reading its balance. Refresh to read the current account and network.' });
        return;
      }
      this.publish({ status: 'connected', name: wallet.name, account, chainId, balance, refreshing: false, error: null });
    } catch (error) {
      if (revision !== this.revision) return;
      this.disconnect(); this.publish({ error: walletError(error) });
    }
  }
}

export function nativeBalance(chainId: string, balance: string): { network: string; amount: string; unit: string } {
  const id = BigInt(chainId);
  const value = BigInt(balance);
  // Unknown chains are displayed in raw units, without guessing their native asset or decimals.
  if (id !== 1n && id !== 11155111n && id !== 8453n) return { network: `Chain ${id}`, amount: value.toString(), unit: 'native base units' };
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return { network: id === 1n ? 'Ethereum Mainnet' : id === 8453n ? 'Base Mainnet' : 'Sepolia testnet', amount: `${whole}${fraction ? `.${fraction}` : ''}`, unit: 'ETH' };
}
