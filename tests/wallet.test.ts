import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { discoverWallets, nativeBalance, WalletConnection, type EvmProvider, type WalletOption, type WalletState } from '../src/wallet';

const ADDRESS = `0x${'1'.repeat(40)}`;
const SECOND = `0x${'2'.repeat(40)}`;
class Provider extends EventEmitter implements EvmProvider {
  accounts = [ADDRESS];
  chain = '0x1';
  balance = '0xde0b6b3a7640000';
  request = vi.fn(async ({ method }: { method: string; params?: unknown[] }): Promise<unknown> => {
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return this.accounts;
    if (method === 'eth_chainId') return this.chain;
    if (method === 'eth_getBalance') return this.balance;
    throw new Error(`Unexpected wallet method: ${method}`);
  });
}
const option = (provider: Provider, name = 'MetaMask'): WalletOption => ({ id: name, name, provider });
function client() {
  const states: WalletState[] = [];
  return { session: new WalletConnection(state => states.push(state)), states, latest: () => states.at(-1)! };
}

describe('read-only EVM connection', () => {
  it('discovers multiple extensions without requesting accounts and ignores malformed announcements', () => {
    const target = new EventTarget();
    const first = new Provider(), second = new Provider();
    let wallets: WalletOption[] = [];
    const announce = () => {
      for (const [provider, name, uuid] of [[first, 'MetaMask', '59dbfd97-8b68-49b6-90df-231868988d62'], [second, 'Rabby', '51494c58-46fd-43a5-9e63-3f680f1e45b0']] as const) {
        target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { provider, info: { name, uuid } } }));
      }
    };
    target.addEventListener('eip6963:requestProvider', announce);
    const stop = discoverWallets(target, value => { wallets = value; });
    announce();
    target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { name: '<script>bad</script>' }, provider: {} } }));
    expect(wallets.map(item => item.name)).toEqual(['MetaMask', 'Rabby']);
    expect(first.request).not.toHaveBeenCalled(); expect(second.request).not.toHaveBeenCalled();
    stop();
  });

  it('reads the explicitly selected provider using only the allowed account and balance methods', async () => {
    const { session, latest } = client(); const provider = new Provider();
    await session.connect(option(provider, 'Rabby'));
    expect(latest()).toMatchObject({ status: 'connected', name: 'Rabby', account: ADDRESS, chainId: '0x1', balance: provider.balance });
    expect(provider.request.mock.calls.filter(([input]) => input.method === 'eth_requestAccounts')).toHaveLength(1);
    expect(provider.request.mock.calls.every(([input]) => ['eth_requestAccounts', 'eth_accounts', 'eth_chainId', 'eth_getBalance'].includes(input.method))).toBe(true);
    expect(provider.request).toHaveBeenCalledWith({ method: 'eth_getBalance', params: [ADDRESS, 'latest'] });
    session.disconnect(); expect(provider.eventNames()).toHaveLength(0);
  });

  it('handles rejection and an empty account list without retaining access', async () => {
    const { session, latest } = client(); const provider = new Provider();
    provider.request.mockRejectedValueOnce({ code: 4001 });
    await session.connect(option(provider));
    expect(latest()).toMatchObject({ status: 'disconnected', account: null, error: expect.stringContaining('declined') });
    await session.connect(option(provider));
    provider.accounts = []; provider.emit('accountsChanged', []);
    await vi.waitFor(() => expect(latest().status).toBe('disconnected'));
    expect(latest().balance).toBeNull(); expect(provider.eventNames()).toHaveLength(0);
  });

  it('invalidates the old balance immediately on account or chain changes', async () => {
    const { session, latest } = client(); const provider = new Provider();
    await session.connect(option(provider));
    provider.accounts = [SECOND]; provider.chain = '0xaa36a7'; provider.balance = '0x2';
    provider.emit('chainChanged', provider.chain);
    expect(latest().balance).toBeNull(); expect(latest().account).toBeNull();
    await vi.waitFor(() => expect(latest().account).toBe(SECOND));
    expect(latest()).toMatchObject({ chainId: '0xaa36a7', balance: '0x2' });
    session.disconnect();
  });

  it('does not publish a late RPC response after local disconnect', async () => {
    const { session, latest } = client(); const provider = new Provider();
    await session.connect(option(provider));
    let finish!: (value: unknown) => void;
    provider.request.mockImplementation(async ({ method }) => {
      if (method === 'eth_accounts') return [ADDRESS];
      if (method === 'eth_chainId') return '0x1';
      return new Promise(resolve => { finish = resolve; });
    });
    const pending = session.refresh();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    session.disconnect(); finish('0x123'); await pending;
    expect(latest()).toMatchObject({ status: 'disconnected', account: null, balance: null });
  });

  it('ignores old requests when the selected wallet changes', async () => {
    const { session, latest } = client(); const old = new Provider(), current = new Provider();
    let finish!: (value: unknown) => void;
    old.request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = session.connect(option(old));
    current.accounts = [SECOND]; await session.connect(option(current, 'Rabby'));
    finish([ADDRESS]); await pending;
    expect(latest()).toMatchObject({ name: 'Rabby', account: SECOND });
    expect(old.eventNames()).toHaveLength(0); session.disconnect();
  });

  it('detects network changes during an RPC even without provider events', async () => {
    const { session, latest } = client(); const provider = new Provider();
    provider.request.mockImplementation(async ({ method }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [ADDRESS];
      if (method === 'eth_chainId') return provider.chain;
      provider.chain = '0xaa36a7'; return '0x1';
    });
    await session.connect(option(provider));
    expect(latest()).toMatchObject({ account: null, balance: null, error: expect.stringContaining('changed while reading') });
    session.disconnect();
  });

  it('keeps native balances exact and does not guess decimals on unknown chains', () => {
    expect(nativeBalance('0x1', '0xde0b6b3a7640001').amount).toBe('1.000000000000000001');
    expect(nativeBalance('0xaa36a7', '0x0')).toMatchObject({ amount: '0', network: 'Sepolia testnet' });
    expect(nativeBalance('0x2105', '0xde0b6b3a7640001')).toEqual({ amount: '1.000000000000000001', network: 'Base Mainnet', unit: 'ETH' });
    expect(nativeBalance('0x38', '0x20000000000001')).toEqual({ network: 'Chain 56', amount: '9007199254740993', unit: 'native base units' });
  });
});
