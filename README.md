# Confam — a Nimiq Pay mini app

**Pay somebody who is already there to go and look.**

Some things cannot be looked up. Whether that road is flooded *right now*,
whether the queue at that bank is long, whether the shop on the corner is open
at all. Confam pays a person standing nearby to walk over, photograph it, and
send the answer back — with the bounty held in escrow until the asker accepts.

Inside Nimiq Pay, the whole thing runs on **USDT on Polygon**, and the wallet
the host already provides is the only account anybody needs.

| | |
|---|---|
| Mini app | https://nimiq.confam.xyz |
| Escrow contract (Polygon) | [`0x63B5a872979c6E6476F177078217d1901d21fFb9`](https://polygonscan.com/address/0x63B5a872979c6E6476F177078217d1901d21fFb9) |
| Token | USDT `0xc2132D05D31c914a87C6611C10748AEb04B58e8F`, 6 decimals |
| Licence | MIT |

---

## Opening it

In Nimiq Pay: **Mini Apps → Custom URL →** `https://nimiq.confam.xyz`

There is no sign-up. The app asks the host for an account, you sign one
sentence to prove the address is yours, and that signature *is* the account —
no email, no password, nothing to reset.

## What a job looks like

1. **Somebody asks about a place.** A question, a spot, a bounty, a deadline.
   Asking costs nothing until a job actually goes out.
2. **The bounty is locked.** The asker signs an EIP-2612 permit; the server
   relays `fundWithPermit` and pays the gas. The asker never needs POL.
3. **Confam AI reads the question first** and decides one thing: does anybody
   have to go. If a person verified that place recently and the answer still
   holds, you get their photograph straight away.
4. **Otherwise it goes to people near that place.** Whoever takes it walks
   there and submits a photo or a video, carrying the time it was taken and
   how far from the place. A `keccak256` of the file is written on chain,
   signed by the person who took it.
5. **The asker accepts**, and the escrow pays the verifier directly — into
   their own wallet, on Polygon. If they query it instead, the money freezes
   until a reviewer rules, and neither side can move it in the meantime.

Every answer has a proof page: the hashes, the escrow job, every transaction.
Hash the file yourself and compare — the server is not in the path of that
check.

---

## How it is put together

Confam is a mini app and a mobile app that work hand in hand. They share one
backend, one escrow and one account, so a question asked inside Nimiq Pay can
be answered by somebody carrying the phone app, and the verifier is paid the
same way either way. Neither is a demo of the other.

### Wallet sign-in

There is no sign-up, no email and no password. The app asks Nimiq Pay for an
account, the person signs one sentence, and the server recovers the address
from that signature — which is the account.

`utils/authWallet.ts` handles discovery, connection, the chain switch and the
signing handshake. It is selected **at module load** from a build-time flag
rather than inside a hook, because a hook choosing an implementation per render
would change the hook count between renders, which React forbids.

The session it mints is an HMAC token this server signs. `authenticate` accepts
it on every route the product already exposes, told apart from other
credentials by prefix rather than by trying one and falling back — so a wallet
user reaches the whole API rather than a reduced copy of it.

### The escrow on Polygon

`AskEscrow` holds the bounty from the moment a job goes out until the asker
accepts. It was deployed to Polygon for the mini app and funds through EIP-2612
`permit`, because USDT there does not implement EIP-3009 at all — its
`receiveWithAuthorization` does not exist, so the authorisation has to be a
permit and the relayer pairs it with `transferFrom`.

Its EIP-712 domain is keyed on `salt` rather than `chainId`, and its name is
`USDT0`. Signed the ordinary way — as viem and ethers do by default — every
signature is well formed, correctly signed, and rejected. `npm run
check:permit` proves the construction against mainnet on every run, for free,
by simulating a real `permit()` with `eth_call`.

Everything after funding — claim, release, dispute, refund — reads the chain a
job was funded on from `questions.fund_chain` and talks to the matching
contract, so the two settle independently.

### Self-custody

The money is never held on anybody's behalf. A bounty goes from the asker's own
wallet into the contract, and the contract pays the verifier at the address
they already control — Confam is never in the middle of it. There is nothing to
deposit and nothing to withdraw, which is one fewer screen rather than one
more.

## Gas

Nobody using the app holds POL. A relayer submits every transaction and pays
the fee, so the asker signs a permit and the verifier signs a claim, and
neither ever needs the native token — or has to understand that it exists.

NIM cannot pay Polygon gas — it is the native token of Nimiq's own L1, which
has no smart contracts and so cannot hold an escrow. Polygon fees are POL.

---

## Layout

```
app/            the Expo application, expo-router file routes
components/     shared UI
contexts/       app state
utils/          API client, wallet auth, chain and escrow calls
constants/      areas, type scale, chain naming, the legal documents

api/            Node, Express, Postgres
  src/routes/   auth, questions, escrow, evidence, agent, admin, mini
  src/          the agent's triage, its wallet, settlement sweep,
                the landing page, the agent terminal, the proof page
  migrations/   plain SQL, applied on boot

contracts/      Foundry. AskEscrow, its tests, and the deploy script
site/           the Vercel project for the marketing site: a proxy
```

One codebase serves both surfaces. The mini app is the web build; the phone
app is the native one.

## Running it

**The API** needs Postgres and a `.env` (see `api/.env.example`):

```bash
cd api
npm install
npm run migrate
npm run dev            # http://localhost:8080
```

**The mini app**, over https — which it needs, because geolocation and the
camera are secure-context features and a LAN address is not one:

```bash
npm run mini:https     # raises tunnels for both halves, prints the address
```

Then paste that address into Nimiq Pay's Custom URL field.

**The contracts**:

```bash
cd contracts
forge install          # lib/ is not committed
forge test             # 38 tests
```

## Checks

```bash
npm run check:permit   # proves the permit domain against mainnet, free
npm run check:signin   # sign-in, including every way it must refuse
cd contracts && forge test
```

`check:signin` covers the refusals rather than only the happy path: a
challenge cannot be spent twice, a signature from another key is not accepted
for an address, and a token with one byte changed authenticates nobody. Those
break silently, because breaking them makes nothing fail — it makes more things
succeed.

---

## On chain

`AskEscrow` is a UUPS-upgradeable contract holding the bounty for one job:

```solidity
enum Status { None, Funded, Claimed, Disputed, Released, Refunded }
```

- **`fund` / `fundWithPermit`** take the bounty by signature, so the asker
  never needs the native token.
- **`claim`** records the verifier and the evidence hash, signed by the
  verifier over EIP-712.
- **`release`** pays the verifier and sends the platform's share to the
  treasury. **`refundExpired`** returns an untaken bounty after its deadline,
  and is deliberately permissionless — the outcome that protects the asker must
  not depend on this platform being reachable, solvent, or willing.
- **`dispute`** freezes a job. **`resolve`** is `onlyArbiter` and is the only
  way out of that state.

`fundWithPermit` checks the allowance before calling `permit`. A permit
signature is public the moment it is relayed and anyone may submit it first —
which grants them nothing, since the spender is fixed, but consumes the nonce
and would otherwise revert a signature the asker produced perfectly correctly.

| | |
|---|---|
| Polygon | [`0x63B5a872979c6E6476F177078217d1901d21fFb9`](https://polygonscan.com/address/0x63B5a872979c6E6476F177078217d1901d21fFb9) |
| Base | [`0x8f93ac1d48f219922cCe1c83AF4c4F718cEB8681`](https://basescan.org/address/0x8f93ac1d48f219922cce1c83af4c4f718ceb8681) |

---

## Built with

- [Expo](https://expo.dev) and [React Native](https://reactnative.dev) — the
  app, and its web export
- [viem](https://viem.sh) — signing, encoding and chain reads
- [OpenZeppelin Contracts](https://openzeppelin.com/contracts) — UUPS proxy,
  `SafeERC20`, `ECDSA`
- [Foundry](https://getfoundry.sh) — contract tests and deployment
- [Express](https://expressjs.com) and [PostgreSQL](https://www.postgresql.org)
  — the API
- [Privy](https://privy.io) — embedded wallets on the mobile app
- Nimiq Pay's injected EIP-1193 provider — the mini app's wallet
- [EIP-6963](https://eips.ethereum.org/EIPS/eip-6963) for wallet discovery in
  ordinary browsers, so the same build runs on a desktop

Everything else is original work. The commit history is the record of it.

## A note on what is stored

Evidence is a photograph of a public place, taken deliberately, and it is shown
to the person who asked. Identity documents are held for verification and are
visible only to the team — never to other users, who see a username. The
wallets are non-custodial: the money is the user's, not a balance we owe them.

The full terms and privacy policy are in `constants/legal.ts`, which is the
single source for both the app and the website.

## Licence

MIT. See [LICENSE](LICENSE).
