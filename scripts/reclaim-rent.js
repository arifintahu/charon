#!/usr/bin/env node
// One-shot: close empty SPL token accounts in the live wallet to reclaim locked rent.
// Run on the box holding the live wallet's SOLANA_PRIVATE_KEY.
//   node scripts/reclaim-rent.js --dry   # count only, send nothing
//   node scripts/reclaim-rent.js         # close them

import { initLiveExecution, liveWalletPubkey, closeAllEmptyTokenAccounts } from '../src/liveExecutor.js';

const RENT_PER_ACCT = 0.00203928;

initLiveExecution();
const wallet = liveWalletPubkey();
if (!wallet) {
  console.error('No live wallet — set SOLANA_PRIVATE_KEY for the wallet you want to reclaim.');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry');
try {
  const { found, closed, signatures } = await closeAllEmptyTokenAccounts({ dryRun });
  console.log(`wallet ${wallet}`);
  if (dryRun) {
    console.log(`${found} empty token account(s) — would reclaim ~${(found * RENT_PER_ACCT).toFixed(4)} SOL (dry run, nothing sent)`);
  } else {
    console.log(`closed ${closed}/${found} empty account(s) in ${signatures.length} tx — reclaimed ~${(closed * RENT_PER_ACCT).toFixed(4)} SOL`);
    for (const s of signatures) console.log(`  ${s}`);
  }
} catch (err) {
  console.error(`reclaim failed: ${err.message}`);
  process.exit(1);
}
