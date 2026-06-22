#!/usr/bin/env node
// One-off: reconcile the LIVE trading wallet (fee-payer of the live trades, on the other box).
// Read-only — derives the pubkey from a trade signature, no private key needed.
//   node scripts/live-wallet-state.js

import pg from 'pg';
import dotenv from 'dotenv';
import { Connection, PublicKey } from '@solana/web3.js';

dotenv.config();

const RPC = process.env.SOLANA_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const PROGRAMS = [
  new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
];

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });
const { rows } = await pool.query(
  "SELECT entry_signature FROM dry_run_positions WHERE execution_mode='live' AND entry_signature IS NOT NULL ORDER BY closed_at_ms DESC LIMIT 1",
);
await pool.end();

const conn = new Connection(RPC, 'confirmed');
const tx = await conn.getParsedTransaction(rows[0].entry_signature, { maxSupportedTransactionVersion: 0 });
const payer = tx.transaction.message.accountKeys[0].pubkey;
const pk = new PublicKey(payer.toString());

const native = await conn.getBalance(pk);
let accts = [];
for (const programId of PROGRAMS) {
  const res = await conn.getParsedTokenAccountsByOwner(pk, { programId });
  accts = accts.concat(res.value);
}
let rent = 0, empty = 0, nonEmpty = [];
for (const a of accts) {
  rent += a.account.lamports;
  const amt = a.account.data.parsed.info.tokenAmount.uiAmount;
  if (!amt) empty++; else nonEmpty.push({ mint: a.account.data.parsed.info.mint.slice(0, 8), amt });
}

const sol = n => (n / 1e9).toFixed(4);
console.log(`live wallet              : ${pk.toBase58()}`);
console.log(`native SOL (spendable)   : ${sol(native)}`);
console.log(`token accounts           : ${accts.length}  (empty ${empty}, holding tokens ${nonEmpty.length})`);
console.log(`SOL locked as rent       : ${sol(rent)}  — ~${sol(empty * 2039280)} recoverable by closing the ${empty} empty ones`);
console.log(`total wallet value       : ${sol(native + rent)}  (native + locked rent)`);
if (nonEmpty.length) console.log(`still holding tokens     :`, JSON.stringify(nonEmpty.slice(0, 25)));
