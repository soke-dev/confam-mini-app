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

## What was built for Nimiq Pay

The app already existed as a phone app settling in USDC on Base. Making it a
mini app was not a port — it is the **same code**, every screen unchanged, with
three things added.

### 1. Wallet sign-in beside the existing auth

The phone app signs in with Privy and gets an embedded wallet. Inside a wallet
host neither makes sense: the host has already put a wallet in front of the
person, and it is the only credential they carry.

`utils/authWallet.ts` implements the same interface as the Privy halves, so
`useAuth()` and `getToken()` satisfy every screen without one of them being
rewritten. `utils/privy.web.ts` picks between the two **at module load**, from
a build-time flag — not inside a hook, because a hook choosing an
implementation per render would change the hook count between renders.

The session is an HMAC token this server signs. `authenticate` accepts it
wherever it accepts a Privy JWT, told apart by prefix rather than by trying one
and falling back. The result is that the mini app is a first-class client of
the routes the phone app already uses, rather than a second half-built API.

### 2. An escrow on Polygon

`AskEscrow` was deployed to Polygon, and the contract gained a second funding
path. Both live in one contract, so the same code serves both chains:

- `fund` — EIP-3009 `receiveWithAuthorization`, for USDC on Base
- `fundWithPermit` — EIP-2612 `permit` + `transferFrom`, for USDT on Polygon

Everything after funding — claim, release, dispute, refund — reads the chain
the job was funded on from `questions.fund_chain` and talks to the matching
contract.

### 3. Self-custody, which removes screens rather than adding them

A Nimiq Pay user holds their own keys, so there is nothing to deposit into and
nothing to withdraw from. The escrow pays them directly at the address they
already control, and they top that wallet up wherever they normally would. The
top-up and withdraw screens are hidden in wallet builds, because both only
exist for the embedded wallet.

---

## Two things about USDT on Polygon worth knowing

Both cost real time to find, and both are invisible until they are expensive.
They are written up here because anyone else integrating that token will hit
them.

**It has no EIP-3009.** `receiveWithAuthorization` does not exist on
`0xc2132D05…`, so the Base funding path cannot reach it at all. It does
implement EIP-2612, which is why `fundWithPermit` exists.

**Its EIP-712 domain uses `salt`, not `chainId`:**

```
EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)
name: "USDT0"   version: "1"   salt: bytes32(137)
```

Sign it the ordinary way — as viem and ethers do by default — and every
signature is well formed, correctly signed, and rejected by the token. The
name is `USDT0` rather than `Tether USD`, too, and the name is part of the
domain.

Both were established by rebuilding each candidate domain and comparing
against what the contract returns from `DOMAIN_SEPARATOR()`. `npm run
check:permit` re-proves it against mainnet on every run, for free, by
simulating a real `permit()` call with `eth_call` — and asserts that a
standard-domain signature is **refused**, so the check cannot pass for the
wrong reason.

There is a third, which is a host behaviour rather than a token one: Nimiq Pay
opens on Ethereum. A permit carries no `chainId` for a wallet to object to, so
funding succeeds on the wrong chain — while claim and release, signed against
the escrow's own domain, are refused with no prompt at all. The app switches to
Polygon before signing, and remembers it for the session.

---

## Gas

Nobody using the app holds POL. A relayer submits every transaction and pays
the fee, so the asker signs a permit and the verifier signs a claim, and
neither needs the native token. That is the same arrangement the phone app has
always used on Base, pointed at a different chain.

NIM cannot pay Polygon gas — it is the native token of Nimiq's own L1, which
has no smart contracts and so cannot hold an escrow. Polygon fees are POL.

---

## Layout

```
app/            the Expo application, expo-router file routes
components/     shared UI
contexts/       app state
utils/          API client, wallet auth, the Privy/wallet split
constants/      areas, type scale, chain naming, the legal documents

api/            Node, Express, Postgres
  src/routes/   auth, questions, escrow, evidence, agent, admin, mini
  src/          the agent's triage, its wallet, settlement sweep,
                the landing page, the agent terminal, the proof page
  migrations/   plain SQL, applied on boot

contracts/      Foundry. AskEscrow, its tests, and the deploy script
site/           the Vercel project for the marketing site: a proxy
```

The mini app is the same Expo build as the phone app, exported for web with
one variable changed.

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
- [Privy](https://privy.io) — embedded wallets, for the phone app only
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
