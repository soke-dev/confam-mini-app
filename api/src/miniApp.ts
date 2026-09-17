import { LOGO_DATA_URI } from './logo.js';

/**
 * The web app: a Nimiq Pay mini app on a phone, an ordinary web app on a
 * desktop, one page doing both.
 *
 * The thing that makes this one page rather than two is that wallet hosts and
 * browser extensions expose the same object. A host injects an EIP-1193
 * provider at window.ethereum before the page runs; an extension announces one
 * over EIP-6963 when asked. After discovery both are a provider with a
 * request() method, and everything below is written against that alone. Nimiq
 * Pay is not a special case in the code — it is a name in a list, found the
 * same way everything else is.
 *
 * It wears the app's clothes, not the website's. The Signal palette is on a
 * near-black ground with a small set of full-chroma colours that each mean one
 * thing: orange is the asking side, green is money and the earning side.
 * Corners are square, borders are drawn rather than implied, nothing is a
 * pill. Somebody who has used the phone app should recognise this immediately,
 * because it is the same product and not a second one.
 *
 * Same rule as the landing page: no framework, no CDN, no backslashes. A
 * backslash here has to survive TypeScript and then the browser, and the two
 * disagree about what it means often enough that the cheapest fix is to never
 * write one.
 */

const USDT_POLYGON = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';
const POLYGON_HEX = '0x89';

const STYLE = `
  :root {
    --bg:#0B0D10; --surface:#14171C; --sunken:#1C2027;
    --line:#2C333C; --line-strong:#454F5B;
    --fg:#F2F5F7; --muted:#9BA5B0; --faint:#6E7883;

    --green:#00C46A; --on-green:#04150C; --green-soft:#0A2A1B;
    --orange:#FF6B00; --on-orange:#1A0900; --orange-soft:#331603;
    --pending:#FFB000; --danger:#FF3B30; --info:#2E9BFF;

    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body {
    margin:0; background:var(--bg); color:var(--fg); min-height:100vh;
    font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    /*
     * Safe-area insets matter here and nowhere else on this server: inside
     * Nimiq Pay this is a full-bleed WebView, so without them the tab bar
     * sits under the home indicator.
     */
    padding:env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
  }
  a { color:var(--orange); }
  .mono { font-family:var(--mono); }
  [hidden] { display:none !important; }

  /* ── Masthead ───────────────────────────────────────────────────────── */
  header {
    display:flex; align-items:center; gap:10px;
    padding:13px 16px; border-bottom:1px solid var(--line);
    background:var(--surface);
  }
  header img { width:24px; height:24px; display:block; }
  header .name { font-weight:700; letter-spacing:-.01em; font-size:16px; }
  header .spacer { flex:1; }

  .chip {
    display:inline-flex; align-items:center; gap:7px;
    border:1px solid var(--line-strong); background:var(--sunken);
    padding:6px 9px; font-size:12px; color:var(--muted); max-width:180px;
  }
  .chip .dot { width:6px; height:6px; background:var(--faint); flex:none; }
  .chip.live .dot { background:var(--green); }
  .chip .who { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  /* ── Tabs ───────────────────────────────────────────────────────────── */
  /*
   * A lit block, the way a board lights a row: solid signal fill with the
   * ground colour knocked out of it. Fixed to the bottom on a phone, where a
   * thumb is; folded under the masthead on a desktop, where one is not.
   */
  nav.tabs {
    position:fixed; left:0; right:0; bottom:0; z-index:20;
    display:grid; grid-template-columns:repeat(3,1fr);
    background:var(--surface); border-top:1px solid var(--line);
    padding-bottom:env(safe-area-inset-bottom);
  }
  nav.tabs button {
    appearance:none; border:0; background:transparent; cursor:pointer;
    font:inherit; font-size:12px; font-weight:600; color:var(--muted);
    padding:11px 6px 13px; display:grid; gap:5px; justify-items:center;
    letter-spacing:.06em; text-transform:uppercase;
  }
  nav.tabs button .glyph { font-size:16px; line-height:1; }
  nav.tabs button[aria-selected="true"] { color:var(--fg); }
  nav.tabs button[data-tint="ask"][aria-selected="true"] {
    background:var(--orange); color:var(--on-orange);
  }
  nav.tabs button[data-tint="earn"][aria-selected="true"] {
    background:var(--green); color:var(--on-green);
  }
  nav.tabs button[data-tint="you"][aria-selected="true"] {
    background:var(--fg); color:var(--bg);
  }

  main { max-width:760px; margin:0 auto; padding:18px 16px 96px; }

  /* ── Type ───────────────────────────────────────────────────────────── */
  h1 { font-size:24px; line-height:1.2; margin:0 0 8px; letter-spacing:-.02em; }
  .lede { margin:14px 0 22px; }
  .lede p { margin:0; color:var(--muted); max-width:58ch; }

  .eyebrow {
    font-size:11px; letter-spacing:.14em; text-transform:uppercase;
    color:var(--faint); font-weight:700; margin:0 0 12px;
  }
  .note { font-size:13px; color:var(--faint); margin:10px 0 0; }
  .bad { color:var(--danger); }
  .good { color:var(--green); }

  /* ── Surfaces ───────────────────────────────────────────────────────── */
  .card {
    border:1px solid var(--line); background:var(--surface);
    padding:16px; margin-bottom:12px;
  }

  .rows { display:grid; gap:1px; background:var(--line); border:1px solid var(--line); }
  .row {
    display:flex; align-items:center; justify-content:space-between; gap:14px;
    background:var(--surface); padding:11px 13px; font-size:14px;
  }
  .row .k { color:var(--muted); flex:none; }
  .row .v { text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .row .v.wrap { white-space:normal; word-break:break-all; }

  /* ── Controls ───────────────────────────────────────────────────────── */
  label.field { display:block; margin-bottom:14px; }
  label.field .cap {
    display:block; font-size:11px; letter-spacing:.12em; text-transform:uppercase;
    color:var(--faint); font-weight:700; margin-bottom:7px;
  }
  input, textarea {
    font:inherit; width:100%; color:var(--fg); background:var(--sunken);
    border:1px solid var(--line-strong); padding:11px 12px; border-radius:2px;
  }
  textarea { resize:vertical; min-height:88px; line-height:1.5; }
  input:focus, textarea:focus { outline:2px solid var(--orange); outline-offset:-2px; }
  input::placeholder, textarea::placeholder { color:var(--faint); }

  .choices { display:flex; flex-wrap:wrap; gap:7px; }
  .choices button {
    font:inherit; font-size:13.5px; cursor:pointer; padding:8px 13px;
    background:var(--sunken); color:var(--fg);
    border:1px solid var(--line-strong); border-radius:2px;
  }
  .choices button[aria-pressed="true"] {
    background:var(--orange); border-color:var(--orange); color:var(--on-orange);
    font-weight:700;
  }

  button.action {
    font:inherit; cursor:pointer; width:100%; padding:14px;
    border:1px solid var(--line-strong); background:var(--sunken); color:var(--fg);
    border-radius:2px; font-weight:600;
  }
  button.action.go {
    background:var(--orange); border-color:var(--orange); color:var(--on-orange);
  }
  button.action.money {
    background:var(--green); border-color:var(--green); color:var(--on-green);
  }
  button.action.quiet { color:var(--muted); font-weight:500; }
  button.action:disabled { opacity:.45; cursor:not-allowed; }
  button.action:hover:not(:disabled) { filter:brightness(1.07); }

  .actions { display:grid; gap:8px; margin-top:14px; }

  /* ── Wallet list ────────────────────────────────────────────────────── */
  .wallets { display:grid; gap:8px; }
  .wallet {
    display:flex; align-items:center; gap:12px; text-align:left; width:100%;
    font:inherit; cursor:pointer; padding:11px 13px; border-radius:2px;
    background:var(--sunken); color:var(--fg); border:1px solid var(--line-strong);
  }
  .wallet:hover { border-color:var(--fg); }
  .wallet img { width:26px; height:26px; flex:none; }
  .wallet .fallback {
    width:26px; height:26px; flex:none; background:var(--line);
    display:grid; place-items:center; font-size:12px; color:var(--muted);
  }
  .wallet .label { flex:1; min-width:0; }
  .wallet .label b { display:block; font-weight:600; }
  .wallet .label span { display:block; font-size:12px; color:var(--faint); }
  .wallet.static {
    border:1px dashed var(--line-strong); background:transparent; cursor:default;
  }
  .wallet.static:hover { border-color:var(--line-strong); }
  .wallet.static .label b { color:var(--muted); }
  .sub {
    font-size:11px; letter-spacing:.14em; text-transform:uppercase;
    color:var(--faint); margin:18px 0 10px; font-weight:700;
  }

  /* ── Job list ───────────────────────────────────────────────────────── */
  .jobs { display:grid; gap:10px; }
  .job {
    border:1px solid var(--line); background:var(--surface); padding:13px;
    /* The category stripe: the one place colour is allowed to be decorative,
       and even here it is a code rather than a flourish. */
    border-left:3px solid var(--faint);
  }
  .job .top { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
  .job .bounty { color:var(--green); font-weight:700; font-size:16px; flex:none; }
  .job .q { margin:0 0 7px; font-size:15px; line-height:1.45; }
  .job .meta { font-size:12.5px; color:var(--faint); display:flex; gap:12px; flex-wrap:wrap; }
  .job .meta .where { color:var(--muted); }

  .empty {
    border:1px dashed var(--line-strong); padding:26px 16px; text-align:center;
    color:var(--faint); font-size:14px;
  }

  @media (min-width:760px) {
    header { padding:15px 26px; }
    main { padding:26px 26px 60px; }
    h1 { font-size:30px; }
    /* A bottom bar is for thumbs. On a desktop the tabs fold under the
       masthead and stop pretending this is a phone. */
    nav.tabs {
      position:static; grid-template-columns:repeat(3,auto); justify-content:start;
      border-top:0; border-bottom:1px solid var(--line); padding:0 18px;
    }
    nav.tabs button { padding:13px 22px; grid-auto-flow:column; align-items:center; }
  }
`;

const SCRIPT = `
(function () {
  'use strict';

  var USDT = '${USDT_POLYGON}';
  var POLYGON = '${POLYGON_HEX}';
  var SESSION_KEY = 'confam.mini.session';

  /* ── Helpers ────────────────────────────────────────────────────────── */

  function el(id) { return document.getElementById(id); }
  function show(id, on) { el(id).hidden = !on; }
  function text(id, value) { el(id).textContent = value; }
  function clear(node) { node.textContent = ''; }

  function shorten(address) {
    return address.slice(0, 6) + '...' + address.slice(-4);
  }

  /** Kobo to something a person reads. The app speaks naira, so this does. */
  function naira(kobo) {
    return 'N' + Math.round(kobo / 100).toLocaleString('en-NG');
  }

  function leftFor(minutes) {
    if (minutes === null || minutes === undefined) return '';
    if (minutes <= 0) return 'expired';
    if (minutes < 60) return minutes + ' min left';
    if (minutes < 1440) return Math.round(minutes / 60) + 'h left';
    return Math.round(minutes / 1440) + 'd left';
  }

  var CATEGORY_COLOUR = {
    fuel: '#FFB000', food: '#00C46A', traffic: '#2E9BFF',
    shopping: '#C77DFF', safety: '#FF3B30', housing: '#FF7A45',
    other: '#6E7883'
  };

  var CHAIN_NAMES = {
    '0x1': 'Ethereum', '0x89': 'Polygon', '0xa4b1': 'Arbitrum',
    '0xa': 'Optimism', '0x2105': 'Base'
  };
  function chainName(id) { return CHAIN_NAMES[id] || ('Chain ' + id); }

  /* ── State ──────────────────────────────────────────────────────────── */

  var state = {
    wallet: null,
    address: '',
    chainId: '',
    session: null,
    tab: 'ask',
    busy: false,
    error: '',
    me: null,
    balance: null,
    jobs: null,      /* null = not fetched yet, [] = fetched and empty */
    jobsError: '',
    bounty: 500,
    deadline: 30,
    posted: ''
  };

  function loadSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.token || !parsed.expires) return null;
      if (parsed.expires < Date.now()) { localStorage.removeItem(SESSION_KEY); return null; }
      return parsed;
    } catch (err) { return null; }
  }

  function saveSession(session) {
    state.session = session;
    if (!session) { state.me = null; state.jobs = null; }
    try {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    } catch (err) {
      /* Private mode. The session still works for this page view. */
    }
  }

  function fail(message) {
    state.error = message;
    state.busy = false;
    render();
  }

  /**
   * What went wrong, in words.
   *
   * 4001 is somebody closing the wallet prompt, which is not an error worth
   * showing in red — they know what they did. Everything else keeps the
   * wallet's own message, because a bare "Request failed" helps nobody.
   */
  function readable(err, fallback) {
    if (!err) return fallback;
    if (err.code === 4001) return 'Cancelled in the wallet.';
    return err.message || fallback;
  }

  /* ── Talking to the server ──────────────────────────────────────────── */

  /**
   * Every authenticated call. The session token goes where Privy's would, so
   * the routes behind it are the same routes the phone app uses.
   */
  function api(path, options) {
    var opts = options || {};
    var headers = { 'authorization': 'Bearer ' + (state.session ? state.session.token : '') };
    if (opts.body) headers['content-type'] = 'application/json';

    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        /*
         * A 401 means the session is no longer good — expired, or the account
         * behind it is gone. Dropping it here means the page returns to the
         * sign-in screen by itself rather than sitting there failing every
         * call with no explanation.
         */
        if (res.status === 401) {
          saveSession(null);
          render();
          throw new Error('Signed out. Please sign in again.');
        }
        if (!res.ok) {
          throw new Error((data && (data.detail || data.error)) || 'That did not work.');
        }
        return data;
      });
    });
  }

  /* ── Discovery ──────────────────────────────────────────────────────── */

  /**
   * Everything that can sign, however it arrived.
   *
   * EIP-6963 is how a desktop extension says it exists: the page asks, each
   * wallet answers with an icon, a name and a provider. window.ethereum is the
   * older single-slot convention, and it is what a host like Nimiq Pay
   * injects. Both end up here as the same shape.
   */
  var wallets = [];
  var seen = {};

  function remember(entry) {
    var key = entry.rdns || entry.name;
    if (seen[key]) return false;
    seen[key] = true;
    entry.evm = null;
    wallets.push(entry);
    vet(entry);
    return true;
  }

  /**
   * Whether this provider can actually sign on an EVM chain.
   *
   * EIP-6963 is an Ethereum standard, but announcing on it has become how
   * every extension makes itself visible, so a browser with a normal spread of
   * wallets installed offers Cosmos, Solana, Polkadot, Hedera and Aptos
   * wallets alongside the ones that can work here. Listing all of them is not
   * generosity, it is nine chances to pick the one that cannot.
   *
   * eth_chainId settles it honestly: no permission, no prompt, and a wallet
   * that cannot speak EVM either rejects it or answers with nothing. A
   * functional test rather than a list of names, because a list of names is
   * wrong the moment somebody ships a new wallet.
   */
  function vet(entry) {
    /*
     * Never vetted away. If this page is open inside Nimiq Pay then its
     * provider is the entire point of being here, and a bridge that answered
     * this one call oddly would leave the app with an empty list and no way
     * in — far worse than showing a row that turns out not to work.
     */
    if (entry.rdns === 'com.nimiq.pay') { entry.evm = true; render(); return; }

    entry.provider.request({ method: 'eth_chainId' })
      .then(function (id) { entry.evm = typeof id === 'string' && id.slice(0, 2) === '0x'; })
      .catch(function () { entry.evm = false; })
      .then(render);
  }

  function usable() {
    return wallets.filter(function (w) { return w.evm === true; });
  }

  function inNimiqPay() { return typeof window.nimiqPay !== 'undefined'; }

  function discover(done) {
    window.addEventListener('eip6963:announceProvider', function (event) {
      var detail = event.detail || {};
      var info = detail.info || {};
      if (!detail.provider) return;
      remember({
        name: info.name || 'Wallet',
        rdns: info.rdns || '',
        /*
         * Only a data: image. This string comes from a browser extension, and
         * an http(s) icon would let one see every page load. Anything else is
         * dropped and the row draws initials instead.
         */
        icon: (info.icon || '').indexOf('data:image/') === 0 ? info.icon : '',
        provider: detail.provider
      });
    });

    window.dispatchEvent(new Event('eip6963:requestProvider'));

    /*
     * The single-slot provider, added once announcements have had a tick to
     * arrive. An extension supporting both would otherwise appear twice: once
     * properly named, once as a generic injected wallet.
     */
    setTimeout(function () {
      if (window.ethereum) {
        var host = inNimiqPay();
        var already = wallets.some(function (w) { return w.provider === window.ethereum; });
        if (!already) {
          remember({
            name: host ? 'Nimiq Pay' : 'Browser wallet',
            rdns: host ? 'com.nimiq.pay' : 'injected',
            icon: '',
            provider: window.ethereum
          });
        }
      }
      render();
      if (done) done();
    }, 120);
  }

  /* ── Wallet ─────────────────────────────────────────────────────────── */

  function request(method, params) {
    if (!state.wallet) return Promise.reject(new Error('No wallet selected'));
    return state.wallet.provider.request({ method: method, params: params || [] });
  }

  function watch(provider) {
    if (!provider.on || provider.confamWatched) return;
    provider.confamWatched = true;

    provider.on('accountsChanged', function (accounts) {
      var next = (accounts && accounts[0]) || '';
      /*
       * A different address is a different person. Keeping the session would
       * leave the page showing one account while the wallet signs as another,
       * which is the sort of mismatch that ends with money going somewhere
       * nobody chose.
       */
      if (state.session && next.toLowerCase() !== String(state.session.address).toLowerCase()) {
        saveSession(null);
      }
      state.address = next;
      if (!next) state.wallet = null;
      render();
    });

    provider.on('chainChanged', function (id) {
      state.chainId = id;
      render();
      refreshBalance();
    });
  }

  function choose(entry) {
    state.wallet = entry;
    state.error = '';
    state.busy = true;
    render();

    watch(entry.provider);

    entry.provider.request({ method: 'eth_requestAccounts' })
      .then(function (accounts) {
        state.address = (accounts && accounts[0]) || '';
        if (!state.address) throw new Error('That wallet returned no account.');
        return entry.provider.request({ method: 'eth_chainId' });
      })
      .then(function (id) {
        state.chainId = id;
        state.busy = false;
        render();
        refreshBalance();
      })
      .catch(function (err) {
        state.wallet = null;
        fail(readable(err, 'Could not connect to that wallet.'));
      });
  }

  /* ── Sign in ────────────────────────────────────────────────────────── */

  function signIn() {
    if (!state.address) return;
    state.busy = true;
    state.error = '';
    render();

    var address = state.address;

    fetch('/mini/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: address })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.message) throw new Error('The server would not issue a challenge.');
        /*
         * The message goes as a plain string rather than hex. Both are legal
         * and hex is the tidier answer, but the string form is the one already
         * proven through Nimiq Pay's bridge on a real device, and MetaMask has
         * always taken either. Nothing is gained by swapping something tested
         * for something merely standard.
         */
        return request('personal_sign', [data.message, address]);
      })
      .then(function (signature) {
        return fetch('/mini/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address: address, signature: signature })
        });
      })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.token) throw new Error(data.detail || 'That signature was not accepted.');
        saveSession({ token: data.token, expires: data.expires, address: address });
        state.busy = false;
        render();
        loadMe();
      })
      .catch(function (err) { fail(readable(err, 'Could not sign in.')); });
  }

  function signOut() {
    saveSession(null);
    state.tab = 'ask';
    render();
  }

  /* ── Chain ──────────────────────────────────────────────────────────── */

  function adopt(id) {
    state.chainId = id;
    state.busy = false;
    render();
    refreshBalance();
  }

  function switchToPolygon() {
    state.busy = true;
    state.error = '';
    render();

    request('wallet_switchEthereumChain', [{ chainId: POLYGON }])
      .then(function () { return request('eth_chainId'); })
      .then(adopt)
      .catch(function (err) {
        /*
         * 4902 means the wallet has never heard of the chain, which is a thing
         * to fix rather than a failure to report: offer the details and retry.
         */
        if (err && err.code === 4902) {
          request('wallet_addEthereumChain', [{
            chainId: POLYGON,
            chainName: 'Polygon',
            nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
            rpcUrls: ['https://polygon-rpc.com'],
            blockExplorerUrls: ['https://polygonscan.com']
          }])
            .then(function () { return request('eth_chainId'); })
            .then(adopt)
            .catch(function (e) { fail(readable(e, 'Could not add Polygon.')); });
          return;
        }
        fail(readable(err, 'Could not switch to Polygon.'));
      });
  }

  function refreshBalance() {
    state.balance = null;
    if (!state.wallet || !state.address || state.chainId !== POLYGON) { render(); return; }

    /* balanceOf(address): the selector, then the address padded to 32 bytes. */
    var data = '0x70a08231' + state.address.slice(2).toLowerCase().padStart(64, '0');

    request('eth_call', [{ to: USDT, data: data }, 'latest'])
      .then(function (hex) {
        var raw = BigInt(hex || '0x0');
        /* Six decimals, and this is display only, so integer maths is enough. */
        var whole = raw / 1000000n;
        var part = (raw % 1000000n).toString().padStart(6, '0').slice(0, 2);
        state.balance = whole.toString() + '.' + part;
        render();
      })
      .catch(function () { state.balance = 'unavailable'; render(); });
  }

  /* ── Data ───────────────────────────────────────────────────────────── */

  function loadMe() {
    api('/mini/me')
      .then(function (me) { state.me = me; render(); })
      .catch(function () { /* render() already ran if the session died */ });
  }

  function loadJobs() {
    state.jobsError = '';
    api('/questions/nearby')
      .then(function (data) { state.jobs = (data && data.jobs) || []; render(); })
      .catch(function (err) {
        state.jobs = [];
        state.jobsError = err.message || 'Could not load jobs.';
        render();
      });
  }

  function post() {
    var question = el('qText').value.trim();
    var place = el('qPlace').value.trim();

    if (question.length < 5) { fail('Say a little more about what you want to know.'); return; }
    if (!place) { fail('Where should somebody go?'); return; }

    state.busy = true;
    state.error = '';
    state.posted = '';
    render();

    api('/questions', {
      method: 'POST',
      body: {
        text: question,
        placeName: place,
        area: place,
        bounty: state.bounty,
        deadlineMinutes: state.deadline
      }
    })
      .then(function () {
        state.busy = false;
        state.posted = 'Asked. You will be told when somebody has been.';
        el('qText').value = '';
        el('qPlace').value = '';
        render();
      })
      .catch(function (err) { fail(err.message || 'Could not ask that.'); });
  }

  /* ── Drawing ────────────────────────────────────────────────────────── */

  function walletRow(node, entry, name, detail) {
    if (entry && entry.icon) {
      var img = document.createElement('img');
      img.src = entry.icon;
      img.alt = '';
      node.appendChild(img);
    } else {
      var mark = document.createElement('div');
      mark.className = 'fallback';
      mark.textContent = name.slice(0, 1).toUpperCase();
      node.appendChild(mark);
    }

    var label = document.createElement('div');
    label.className = 'label';
    var title = document.createElement('b');
    /* textContent, not innerHTML: these names come from browser extensions. */
    title.textContent = name;
    var sub = document.createElement('span');
    sub.textContent = detail;
    label.appendChild(title);
    label.appendChild(sub);
    node.appendChild(label);
    return node;
  }

  /**
   * Nimiq Pay, whether or not it is here.
   *
   * Mini apps run inside the Nimiq Pay app, so on a desktop there is nothing
   * to find and no amount of discovery will conjure one. Leaving the row out
   * would be accurate and useless: the page would simply not mention the
   * wallet it was built for, and somebody looking for it would conclude it was
   * unsupported. So the row is always drawn, and on a desktop it says where to
   * go instead.
   */
  function drawNimiq() {
    var slot = el('nimiqRow');
    var host = wallets.filter(function (w) { return w.rdns === 'com.nimiq.pay'; })[0];
    var want = host ? 'live' : 'absent';
    if (slot.dataset.state === want) return;
    slot.dataset.state = want;
    clear(slot);

    if (host) {
      var button = walletRow(document.createElement('button'), host, 'Nimiq Pay',
        'This app is running inside it');
      button.className = 'wallet';
      button.addEventListener('click', function () { choose(host); });
      slot.appendChild(button);
      return;
    }

    var row = walletRow(document.createElement('div'), null, 'Nimiq Pay',
      'A phone app. Open this page inside it to use it.');
    row.className = 'wallet static';
    slot.appendChild(row);
  }

  function drawWallets() {
    var list = el('wallets');
    var rows = usable().filter(function (w) { return w.rdns !== 'com.nimiq.pay'; });
    if (list.childElementCount === rows.length) return;
    clear(list);

    rows.forEach(function (entry) {
      var button = walletRow(document.createElement('button'), entry, entry.name,
        entry.rdns === 'injected' ? 'Injected into the page' : entry.rdns);
      button.className = 'wallet';
      button.addEventListener('click', function () { choose(entry); });
      list.appendChild(button);
    });
  }

  function drawJobs() {
    var list = el('jobs');
    clear(list);

    if (state.jobs === null) return;

    if (state.jobs.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = state.jobsError
        ? state.jobsError
        : 'Nothing to do nearby right now. Check back shortly.';
      list.appendChild(empty);
      return;
    }

    state.jobs.forEach(function (job) {
      var card = document.createElement('article');
      card.className = 'job';
      card.style.borderLeftColor = CATEGORY_COLOUR[job.category] || CATEGORY_COLOUR.other;

      var top = document.createElement('div');
      top.className = 'top';
      var q = document.createElement('p');
      q.className = 'q';
      q.textContent = job.text;
      var bounty = document.createElement('div');
      bounty.className = 'bounty';
      bounty.textContent = naira(job.bountyKobo);
      top.appendChild(q);
      top.appendChild(bounty);

      var meta = document.createElement('div');
      meta.className = 'meta';
      var where = document.createElement('span');
      where.className = 'where';
      where.textContent = job.placeName || job.area || 'somewhere nearby';
      meta.appendChild(where);

      var left = leftFor(job.minutesLeft);
      if (left) {
        var when = document.createElement('span');
        when.textContent = left;
        meta.appendChild(when);
      }

      card.appendChild(top);
      card.appendChild(meta);
      list.appendChild(card);
    });
  }

  function drawChoices(id, values, current, format, onPick) {
    var box = el(id);
    if (box.childElementCount !== values.length) {
      clear(box);
      values.forEach(function (value) {
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = format(value);
        button.addEventListener('click', function () { onPick(value); render(); });
        box.appendChild(button);
      });
    }
    Array.prototype.forEach.call(box.children, function (node, i) {
      node.setAttribute('aria-pressed', values[i] === current ? 'true' : 'false');
    });
  }

  /* ── Render ─────────────────────────────────────────────────────────── */

  var BOUNTIES = [150, 500, 1000, 2000];
  var DEADLINES = [10, 30, 60, 1440];

  function render() {
    var connected = !!(state.wallet && state.address);
    var signedIn = !!state.session;

    /* The gate. Nothing behind it is reachable without a wallet. */
    show('gate', !signedIn);
    show('app', signedIn);
    show('tabs', signedIn);

    show('error', !!state.error);
    text('error', state.error);

    if (!signedIn) {
      show('pickCard', !connected);
      show('signCard', connected);

      drawNimiq();
      drawWallets();
      var others = usable().filter(function (w) { return w.rdns !== 'com.nimiq.pay'; }).length;
      show('othersLabel', others > 0);
      show('wallets', others > 0);
      show('noWallets', others === 0 && !inNimiqPay());

      if (connected) {
        text('signWallet', state.wallet.name);
        text('signAddress', state.address);
      }
      el('signBtn').disabled = state.busy;
      text('signBtn', state.busy ? 'Waiting for the wallet...' : 'Sign in with this wallet');
      return;
    }

    /* Header chip. */
    el('chip').className = 'chip live';
    text('chipWho', shorten(state.session.address));

    /* Tabs. */
    ['ask', 'earn', 'you'].forEach(function (name) {
      el('tab-' + name).setAttribute('aria-selected', state.tab === name ? 'true' : 'false');
      show('panel-' + name, state.tab === name);
    });

    /* Ask. */
    drawChoices('bounties', BOUNTIES, state.bounty,
      function (v) { return naira(v * 100); },
      function (v) { state.bounty = v; });
    drawChoices('deadlines', DEADLINES, state.deadline,
      function (v) { return v < 60 ? v + ' min' : v < 1440 ? (v / 60) + ' hr' : (v / 1440) + ' day'; },
      function (v) { state.deadline = v; });

    el('askBtn').disabled = state.busy;
    text('askBtn', state.busy ? 'Asking...' : 'Ask for ' + naira(state.bounty * 100));
    show('posted', !!state.posted);
    text('posted', state.posted);

    /* Earn. */
    drawJobs();

    /* You. */
    text('youName', (state.me && (state.me.username || state.me.displayName)) || 'Signed in');
    text('youAddress', state.session.address);
    text('youWallet', state.wallet ? state.wallet.name : 'Reconnect to see');

    var onPolygon = state.chainId === POLYGON;
    text('youChain', state.chainId ? chainName(state.chainId) : 'unknown');
    el('youChain').className = onPolygon ? 'v good' : 'v';
    show('switchRow', !!state.wallet && !onPolygon);
    show('balanceRow', onPolygon);
    text('youBalance', state.balance === null ? 'reading...'
      : state.balance === 'unavailable' ? 'unavailable' : state.balance + ' USDT');
    el('switchBtn').disabled = state.busy;
  }

  function go(tab) {
    state.tab = tab;
    state.error = '';
    /* Fetched on arrival, not on load: nobody pays for a list they never open. */
    if (tab === 'earn' && state.jobs === null) loadJobs();
    render();
  }

  /* ── Start ──────────────────────────────────────────────────────────── */

  el('signBtn').addEventListener('click', signIn);
  el('askBtn').addEventListener('click', post);
  el('switchBtn').addEventListener('click', switchToPolygon);
  el('signOutBtn').addEventListener('click', signOut);
  el('refreshBtn').addEventListener('click', loadJobs);
  ['ask', 'earn', 'you'].forEach(function (name) {
    el('tab-' + name).addEventListener('click', function () { go(name); });
  });

  state.session = loadSession();

  discover(function () {
    /*
     * A stored session names an address, and the page is more useful if it
     * reconnects silently. eth_accounts asks what is already authorised
     * without raising a prompt, so this is only ever a reconnection.
     */
    if (!state.session) { render(); return; }

    loadMe();

    var target = String(state.session.address).toLowerCase();
    var pending = wallets.length;
    if (!pending) { render(); return; }

    wallets.forEach(function (entry) {
      entry.provider.request({ method: 'eth_accounts' })
        .then(function (accounts) {
          var match = (accounts || []).some(function (a) {
            return String(a).toLowerCase() === target;
          });
          if (match && !state.wallet) {
            state.wallet = entry;
            state.address = accounts[0];
            watch(entry.provider);
            return entry.provider.request({ method: 'eth_chainId' }).then(function (id) {
              state.chainId = id;
              refreshBalance();
            });
          }
          return null;
        })
        .catch(function () { /* A wallet that will not answer is simply not it. */ })
        .then(function () {
          pending -= 1;
          if (pending === 0) render();
        });
    });
  });

  render();
})();
`;

export const MINI_APP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Confam</title>
<meta name="description" content="Pay somebody nearby to go and look. Works in your wallet, and in your browser.">
<meta name="color-scheme" content="dark">
<link rel="icon" href="${LOGO_DATA_URI}">
<style>${STYLE}</style>
</head>
<body>

<header>
  <img src="${LOGO_DATA_URI}" alt="">
  <div class="name">Confam</div>
  <div class="spacer"></div>
  <div class="chip" id="chip"><span class="dot"></span><span class="who" id="chipWho">Not connected</span></div>
</header>

<nav class="tabs" id="tabs" hidden>
  <button id="tab-ask"  data-tint="ask"  aria-selected="true"><span class="glyph">&#9678;</span>Ask</button>
  <button id="tab-earn" data-tint="earn" aria-selected="false"><span class="glyph">&#9635;</span>Earn</button>
  <button id="tab-you"  data-tint="you"  aria-selected="false"><span class="glyph">&#9679;</span>You</button>
</nav>

<main>
  <p id="error" class="note bad" hidden></p>

  <!-- ── The gate ───────────────────────────────────────────────────── -->
  <div id="gate">
    <div class="lede">
      <h1>The physical world, on demand.</h1>
      <p>Pay somebody who is already there to go and look, and get back the
         photograph. Your wallet is your account, so there is nothing to sign
         up for.</p>
    </div>

    <div class="card" id="pickCard">
      <p class="eyebrow">Connect a wallet</p>
      <div id="nimiqRow"></div>
      <p class="sub" id="othersLabel" hidden>Or a browser wallet</p>
      <div class="wallets" id="wallets"></div>
      <p class="note" id="noWallets" hidden>
        No browser wallet found. Install one and reload this page, or open this
        page inside a wallet app on your phone.
      </p>
    </div>

    <div class="card" id="signCard" hidden>
      <p class="eyebrow">Sign in</p>
      <div class="rows">
        <div class="row"><span class="k">Wallet</span><span class="v" id="signWallet"></span></div>
        <div class="row"><span class="k">Address</span><span class="v mono wrap" id="signAddress"></span></div>
      </div>
      <div class="actions">
        <button class="action go" id="signBtn">Sign in with this wallet</button>
      </div>
      <p class="note">You will be asked to sign a sentence. It moves no funds and costs no gas.</p>
    </div>
  </div>

  <!-- ── The app ────────────────────────────────────────────────────── -->
  <div id="app" hidden>

    <section id="panel-ask">
      <div class="card">
        <p class="eyebrow">Ask about a place</p>
        <label class="field">
          <span class="cap">What do you want to know?</span>
          <textarea id="qText" placeholder="Is the filling station on Awolowo Road selling petrol right now?"></textarea>
        </label>
        <label class="field">
          <span class="cap">Where</span>
          <input id="qPlace" type="text" placeholder="Awolowo Road, Ikoyi">
        </label>
        <label class="field">
          <span class="cap">Bounty</span>
          <div class="choices" id="bounties"></div>
        </label>
        <label class="field">
          <span class="cap">Answer within</span>
          <div class="choices" id="deadlines"></div>
        </label>
        <div class="actions">
          <button class="action go" id="askBtn">Ask</button>
        </div>
        <p class="note good" id="posted" hidden></p>
        <p class="note">Asking costs nothing until somebody takes it. The bounty is
           locked in escrow the moment the job goes out.</p>
      </div>
    </section>

    <section id="panel-earn" hidden>
      <div class="card">
        <p class="eyebrow">Jobs near you</p>
        <div class="jobs" id="jobs"></div>
        <div class="actions">
          <button class="action quiet" id="refreshBtn">Refresh</button>
        </div>
      </div>
    </section>

    <section id="panel-you" hidden>
      <div class="card">
        <p class="eyebrow">You</p>
        <div class="rows">
          <div class="row"><span class="k">Name</span><span class="v" id="youName"></span></div>
          <div class="row"><span class="k">Address</span><span class="v mono wrap" id="youAddress"></span></div>
          <div class="row"><span class="k">Wallet</span><span class="v" id="youWallet"></span></div>
          <div class="row"><span class="k">Network</span><span class="v" id="youChain"></span></div>
          <div class="row" id="balanceRow" hidden><span class="k">USDT</span><span class="v mono" id="youBalance"></span></div>
        </div>
        <div class="actions" id="switchRow" hidden>
          <button class="action money" id="switchBtn">Switch to Polygon</button>
        </div>
        <div class="actions">
          <button class="action quiet" id="signOutBtn">Sign out</button>
        </div>
      </div>
    </section>

  </div>
</main>

<script>${SCRIPT}</script>
</body>
</html>`;
