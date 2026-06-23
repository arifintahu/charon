#!/usr/bin/env node
// One-off: reconcile recorded pnl_sol against actual on-chain wallet deltas for live trades.
// pnl_sol records only the swap leg (SOL out vs SOL in). The wallet also pays priority fee +
// Jito tip + base fee + net ATA rent per tx, which pnl_sol never sees. This samples N recent
// round trips, pulls both signatures from chain, and measures the real overhead.
//   node scripts/fee-audit.js [N]

import pg from 'pg';
import '../src/loadEnv.js';
import { Connection } from '@solana/web3.js';

const RPC = process.env.SOLANA_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const SIZE = 0.02;
const LAMPORTS = 1_000_000_000;
const N = Number(process.argv[2] || 24);

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });
const { rows } = await pool.query(
  `SELECT local_id, symbol, pnl_sol, entry_signature, exit_signature
     FROM dry_run_positions
    WHERE execution_mode='live' AND status='closed'
      AND entry_signature IS NOT NULL AND exit_signature IS NOT NULL
    ORDER BY closed_at_ms DESC LIMIT $1`,
  [N],
);
await pool.end();

const conn = new Connection(RPC, 'confirmed');
async function payer(sig) {
  const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
  if (!tx?.meta) return null;
  return { fee: tx.meta.fee, delta: tx.meta.preBalances[0] - tx.meta.postBalances[0] };
}

let sumOverhead = 0, sumFee = 0, n = 0;
console.log(`id     symbol        pnl_sol  walletNet  overhead  (baseFee+prio  tip+rent)`);
for (const r of rows) {
  const b = await payer(r.entry_signature);
  const s = await payer(r.exit_signature);
  if (!b || !s) { console.log(`#${r.local_id} ${r.symbol}: tx not found on RPC`); continue; }
  const roundTrip = (b.delta + s.delta) / LAMPORTS;     // net SOL out of wallet across both legs
  const pnl = Number(r.pnl_sol);
  const overhead = roundTrip + pnl;                      // fees + tips + net rent
  const walletNet = -roundTrip;                          // realized = pnl - overhead
  const fee = (b.fee + s.fee) / LAMPORTS;
  sumOverhead += overhead; sumFee += fee; n++;
  console.log(
    `${String(r.local_id).padEnd(6)} ${(r.symbol || '?').slice(0, 12).padEnd(12)} ` +
    `${pnl.toFixed(4).padStart(8)} ${walletNet.toFixed(4).padStart(9)} ${overhead.toFixed(4).padStart(9)}  ` +
    `(${fee.toFixed(4)}        ${(overhead - fee).toFixed(4)})`,
  );
}

console.log(`\nsample n=${n}  (size ${SIZE} SOL/trade)`);
console.log(`avg overhead / round-trip : ${(sumOverhead / n).toFixed(4)} SOL  = base+priority ${(sumFee / n).toFixed(4)} + tip/rent ${((sumOverhead - sumFee) / n).toFixed(4)}`);
console.log(`avg overhead as % of size : ${(sumOverhead / n / SIZE * 100).toFixed(1)}% per round-trip`);
console.log(`extrapolated to 116 trips : ${(sumOverhead / n * 116).toFixed(3)} SOL  (recorded gross +0.149, so net ~ ${(0.1486 - sumOverhead / n * 116).toFixed(3)})`);
