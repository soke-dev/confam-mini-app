import { WALLET_MODE } from '@/utils/privyShared';

/**
 * What the money is called — and there are two answers, not one.
 *
 * This file exists because a single answer was nearly shipped. The mini app
 * reads its balance from Polygon, so the obvious move was one constant saying
 * "USDT on Polygon" and a search-and-replace over every screen. That would
 * have relabelled the deposit screen too, telling somebody to send USDT on
 * Polygon to an address whose deposit scanner only ever watches Base. They
 * would have sent real money to a chain nothing is listening on, and the app
 * would have shown nothing arriving, forever.
 *
 * Only the balance moved. Funding, deposits, withdrawals and settlement are
 * all still Base, because that is where AskEscrow is. Until the contract is
 * deployed to Polygon those are two different facts and the interface has to
 * be able to say both.
 */

/**
 * What the balance shows: the money actually in front of this person.
 *
 * Polygon USDT in the mini app, because that is the chain the wallet host
 * offers and the token they are holding. Reading Base would show them a zero
 * belonging to an account they have never used.
 */
export const BALANCE = WALLET_MODE
  ? { token: 'USDT', chain: 'Polygon', onChain: 'USDT on Polygon' }
  : { token: 'USDC', chain: 'Base', onChain: 'USDC on Base' };

/**
 * Where the escrow is, where deposits are watched for, and where withdrawals
 * are sent from. Base in every build, including the mini app.
 *
 * Not conditional, and it must not become conditional until AskEscrow is
 * actually deployed elsewhere. Every string built from this is a promise about
 * where somebody's money will be — the deposit address, the network warning,
 * the transaction link — and a promise that is merely aspirational here is one
 * that loses funds.
 */
export const SETTLEMENT = {
  token: 'USDC',
  chain: 'Base',
  onChain: 'USDC on Base',
  explorerName: 'BaseScan',
  explorerTx: (hash: string) => `https://basescan.org/tx/${hash}`,
  /** What the relayer spends on fees. Nobody using the app ever holds this. */
  gasToken: 'ETH',
} as const;
