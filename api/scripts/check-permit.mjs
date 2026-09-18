/**
 * Proves that the permit signature we build is one the real USDT contract on
 * Polygon accepts — against mainnet, spending nothing.
 *
 * This exists because the failure it catches is invisible until it is
 * expensive. USDT on Polygon signs permits against an EIP-712 domain that uses
 * `salt` instead of `chainId`, and its name is "USDT0" rather than "Tether
 * USD". Build the domain the ordinary way and every signature is well formed,
 * correctly signed, and rejected by the token — a failure that shows up as
 * "funding failed" for every user and looks like a relayer problem.
 *
 * Two checks, both against the live contract:
 *
 *   1. The domain separator we compute equals the one the token reports.
 *   2. A signature built from our typed data survives a real permit() call,
 *      simulated with eth_call so no gas is spent and no state changes.
 *
 * The second is the one that matters. The first could pass while some other
 * detail of the struct hash is wrong; only executing the contract's own
 * verification proves the whole construction.
 *
 *   npm run check:permit
 */
import { privateKeyToAccount } from 'viem/accounts';
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  parseAbiParameters,
  stringToHex,
  toHex,
} from 'viem';
import { polygon } from 'viem/chains';

const RPC = process.env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com';
const USDT = (
  process.env.POLYGON_USDT_ADDRESS ?? '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'
).toLowerCase();
const CHAIN_ID = 137;

/* A published Anvil test key. It has never held anything. */
const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

const client = createPublicClient({ chain: polygon, transport: http(RPC) });

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

/**
 * The payload the server actually sends, not a copy of it.
 *
 * This used to rebuild the domain by hand beside escrow.ts's own. Both were
 * right, and that is precisely the problem: two hand-written copies of a
 * structure whose whole difficulty is being easy to get subtly wrong, with
 * nothing to make them disagree out loud. Change one and this passes while
 * production fails.
 *
 * Imported from dist, so `npm run build` has to have run — which it has, since
 * the build is what produces the code this is checking.
 */
const { permitPayload } = await import('../dist/escrow.js');

const built = await permitPayload({ owner: account.address, amount: 1 });

/*
 * Round-tripped through JSON exactly as the client does: the browser hands
 * eth_signTypedData_v4 a string, so anything that does not survive
 * stringify/parse — a bigint, undefined, a Date — breaks there and not here.
 */
const typedData = JSON.parse(JSON.stringify(built.typedData));
const domain = typedData.domain;
const types = typedData.types;

/* ── 1. the domain separator ──────────────────────────────────────────── */

const onChain = await client.readContract({
  address: USDT,
  abi: [
    {
      name: 'DOMAIN_SEPARATOR',
      type: 'function',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'bytes32' }],
    },
  ],
  functionName: 'DOMAIN_SEPARATOR',
});

const ours = keccak256(
  encodeAbiParameters(parseAbiParameters('bytes32, bytes32, bytes32, address, bytes32'), [
    keccak256(
      stringToHex(
        'EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)',
      ),
    ),
    keccak256(stringToHex(domain.name)),
    keccak256(stringToHex(domain.version)),
    domain.verifyingContract,
    domain.salt,
  ]),
);

check('our domain separator matches the token', ours === onChain, onChain);

/* ── 2. a real signature, through the contract's own verification ─────── */

const nonce = await client.readContract({
  address: USDT,
  abi: [
    {
      name: 'nonces',
      type: 'function',
      stateMutability: 'view',
      inputs: [{ name: 'owner', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }],
    },
  ],
  functionName: 'nonces',
  args: [account.address],
});

/*
 * The built message, unaltered. Its spender is the deployed escrow and its
 * nonce was read from the token when permitPayload ran — so this checks the
 * figures that would really be signed, not stand-ins for them.
 */
const message = typedData.message;
const value = BigInt(message.value);
const deadline = BigInt(message.deadline);

check(
  'the payload names the live nonce',
  BigInt(message.nonce) === nonce,
  `payload ${message.nonce}, chain ${nonce}`,
);

const signature = await account.signTypedData({
  domain,
  types,
  primaryType: 'Permit',
  message,
});

const permitAbi = [
  {
    name: 'permit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
];

const raw = signature.slice(2);
const r = `0x${raw.slice(0, 64)}`;
const s = `0x${raw.slice(64, 128)}`;
let v = parseInt(raw.slice(128, 130), 16);
if (v < 27) v += 27;

const call = async (args) => {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: USDT, data: encodeFunctionData({ abi: permitAbi, functionName: 'permit', args }) }, 'latest'],
    }),
  });
  return res.json();
};

const good = await call([message.owner, message.spender, value, deadline, v, r, s]);
check(
  'the live contract accepts our signature',
  good.result !== undefined && !good.error,
  good.error ? good.error.message : 'permit() executed without reverting',
);

/*
 * And the negative, which is the whole point: the same permit signed against
 * the ordinary chainId domain must be refused. Without this the test above
 * could pass for the wrong reason — a contract that accepted anything.
 */
const wrongDomain = {
  name: 'USDT0',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: USDT,
};

const wrongSig = await account.signTypedData({
  domain: wrongDomain,
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    Permit: types.Permit,
  },
  primaryType: 'Permit',
  message,
});

const wr = wrongSig.slice(2);
let wv = parseInt(wr.slice(128, 130), 16);
if (wv < 27) wv += 27;

const bad = await call([
  message.owner,
  message.spender,
  value,
  deadline,
  wv,
  `0x${wr.slice(0, 64)}`,
  `0x${wr.slice(64, 128)}`,
]);
check(
  'a standard-domain signature is refused',
  Boolean(bad.error),
  bad.error ? bad.error.message : 'ACCEPTED — the domain check proves nothing',
);

console.log(failures === 0 ? '\nall good' : `\n${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
