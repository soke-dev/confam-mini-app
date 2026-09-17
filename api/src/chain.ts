import { config } from './config.js';

/**
 * Reads USDC balances from Base.
 *
 * Raw JSON-RPC rather than a library: this needs one `eth_call` against one
 * well-known ABI, and hand-encoding a 4-byte selector plus a padded address is
 * less code than the dependency would be — with nothing to keep up to date.
 *
 * Every figure here comes from the chain. Nothing about a person's real balance
 * is stored in Postgres, because the chain is the account and a copy of it in
 * our database would be a second answer to the same question that goes stale
 * the moment somebody transacts outside the app.
 */

/** keccak256("balanceOf(address)") — first four bytes. */
const BALANCE_OF = '0x70a08231';

/** USDC has six decimals, unlike the eighteen most ERC-20s use. */
const USDC_DECIMALS = 6;

type CacheEntry = { atBlock: number; raw: bigint; readAt: number };
const cache = new Map<string, CacheEntry>();

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  // Log scans go to the endpoint that allows a wide block range; see
  // config.chain.logsRpcUrl for why those are not the same provider.
  const endpoint = method === 'eth_getLogs' ? config.chain.logsRpcUrl : config.chain.rpcUrl;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) throw new Error(`RPC ${method} returned ${response.status}`);

  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
  if (body.result === undefined) throw new Error(`RPC ${method} returned nothing`);
  return body.result;
}

export type UsdcBalance = {
  /** Whole USDC, already divided down from the six-decimal integer. */
  usdc: number;
  /** The integer as a decimal string, for anything that must not lose precision. */
  raw: string;
  blockNumber: number;
  /** True when this came from cache rather than a fresh call. */
  cached: boolean;
};

/**
 * Which chain a balance is being asked about.
 *
 * 'base' is this server's chain and the default everywhere: the escrow holds
 * USDC there and settlement happens there. 'polygon' exists for the mini app,
 * which runs inside a wallet host that offers Polygon and not Base, so the
 * money in front of that person is USDT on Polygon.
 */
export type BalanceChain = 'base' | 'polygon';

export type TokenBalance = UsdcBalance & {
  /** What was actually counted, so nothing has to assume it was USDC. */
  token: 'USDC' | 'USDT';
  chain: BalanceChain;
};

/**
 * One token, on one chain.
 *
 * Both tokens here happen to have six decimals, which is why one divisor
 * serves. That is a fact about USDC and USDT rather than a rule about ERC-20s
 * — most use eighteen — so a third token added here needs its decimals
 * checked rather than assumed.
 */
export async function tokenBalanceOf(
  address: string,
  chain: BalanceChain = 'base',
): Promise<TokenBalance> {
  if (chain === 'base') {
    const balance = await usdcBalanceOf(address);
    return { ...balance, token: 'USDC', chain: 'base' };
  }

  const key = address.toLowerCase();
  /*
   * Its own cache key. Sharing one with the Base read would hand somebody the
   * wrong chain's figure for as long as the entry lived, which is the kind of
   * wrong that looks like a balance rather than like a bug.
   */
  const cacheKey = `polygon:${key}`;
  const hit = cache.get(cacheKey);

  if (hit && Date.now() - hit.readAt < config.chain.cacheMs) {
    return {
      usdc: toUsdc(hit.raw),
      raw: hit.raw.toString(),
      blockNumber: hit.atBlock,
      cached: true,
      token: 'USDT',
      chain: 'polygon',
    };
  }

  const data = BALANCE_OF + key.replace(/^0x/, '').padStart(64, '0');

  const [result, blockHex] = await Promise.all([
    polygonRpc<string>('eth_call', [{ to: config.polygon.usdt, data }, 'latest']),
    polygonRpc<string>('eth_blockNumber', []),
  ]);

  const raw = BigInt(result);
  const atBlock = Number(BigInt(blockHex));
  cache.set(cacheKey, { atBlock, raw, readAt: Date.now() });

  return {
    usdc: toUsdc(raw),
    raw: raw.toString(),
    blockNumber: atBlock,
    cached: false,
    token: 'USDT',
    chain: 'polygon',
  };
}

/** The same JSON-RPC, pointed at Polygon. */
async function polygonRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(config.polygon.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) throw new Error(`Polygon RPC ${method} returned ${response.status}`);

  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`Polygon RPC ${method}: ${body.error.message}`);
  if (body.result === undefined) throw new Error(`Polygon RPC ${method} returned nothing`);
  return body.result;
}

export async function usdcBalanceOf(address: string): Promise<UsdcBalance> {
  const key = address.toLowerCase();
  const hit = cache.get(key);

  if (hit && Date.now() - hit.readAt < config.chain.cacheMs) {
    return { usdc: toUsdc(hit.raw), raw: hit.raw.toString(), blockNumber: hit.atBlock, cached: true };
  }

  // balanceOf takes one address, encoded as 32 bytes: 24 zeros then 20 bytes.
  const data = BALANCE_OF + key.replace(/^0x/, '').padStart(64, '0');

  const [result, blockHex] = await Promise.all([
    rpc<string>('eth_call', [{ to: config.chain.usdc, data }, 'latest']),
    rpc<string>('eth_blockNumber', []),
  ]);

  // BigInt, not Number: a token amount is a 256-bit integer and USDC's six
  // decimals mean the raw value passes 2^53 at about nine billion dollars.
  // Parsing it as a float would round silently long before any error appeared.
  const raw = BigInt(result === '0x' ? '0x0' : result);
  const blockNumber = Number(BigInt(blockHex));

  cache.set(key, { raw, atBlock: blockNumber, readAt: Date.now() });
  return { usdc: toUsdc(raw), raw: raw.toString(), blockNumber, cached: false };
}

function toUsdc(raw: bigint): number {
  const divisor = 10n ** BigInt(USDC_DECIMALS);
  const whole = raw / divisor;
  const fraction = raw % divisor;
  return Number(whole) + Number(fraction) / Number(divisor);
}

/** Confirms the RPC is reachable and pointed at the chain we expect. */
export async function chainStatus(): Promise<{ ok: boolean; chainId?: number; detail?: string }> {
  try {
    const hex = await rpc<string>('eth_chainId', []);
    const chainId = Number(BigInt(hex));
    if (chainId !== config.chain.chainId) {
      return { ok: false, chainId, detail: `expected chain ${config.chain.chainId}` };
    }
    return { ok: true, chainId };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'unreachable' };
  }
}

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export type IncomingTransfer = {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  from: string;
  /** Whole USDC. */
  usdc: number;
  /** The six-decimal integer, as a string. */
  raw: string;
};

/**
 * Incoming USDC transfers to one address, over a block range.
 *
 * Filtered by the node, not by us: the third topic of a Transfer is the
 * recipient, so passing it as a filter means the RPC returns only this
 * person's transfers rather than every USDC movement on Base for us to sift.
 */
export async function incomingUsdc(
  address: string,
  fromBlock: number,
  toBlock: number,
): Promise<IncomingTransfer[]> {
  const topicTo = `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;

  const logs = await rpc<
    { transactionHash: string; logIndex: string; blockNumber: string; topics: string[]; data: string }[]
  >('eth_getLogs', [
    {
      address: config.chain.usdc,
      // [event, from (any), to (us)]
      topics: [TRANSFER_TOPIC, null, topicTo],
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
    },
  ]);

  return logs.map((log) => {
    const raw = BigInt(log.data === '0x' ? '0x0' : log.data);
    return {
      txHash: log.transactionHash,
      logIndex: Number(BigInt(log.logIndex)),
      blockNumber: Number(BigInt(log.blockNumber)),
      // An indexed address topic is the 20-byte address right-padded into 32.
      from: `0x${(log.topics[1] ?? '').slice(26)}`,
      usdc: toUsdc(raw),
      raw: raw.toString(),
    };
  });
}

export async function latestBlock(): Promise<number> {
  return Number(BigInt(await rpc<string>('eth_blockNumber', [])));
}
