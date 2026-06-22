import axios from 'axios';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  JUPITER_API_KEY,
  JUPITER_SLIPPAGE_BPS,
  JUPITER_SWAP_BASE_URL,
  JSON_HEADERS,
  SOLANA_PRIVATE_KEY,
  SOLANA_RPC_URL,
} from './config.js';
import { logger } from './log.js';

const log = logger('live');

let liveWallet = null;
let solanaConnection = null;

const TOKEN_PROGRAM_IDS = [
  new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
];

function parseKeypair(secret) {
  const value = String(secret || '').trim();
  if (!value) return null;
  if (value.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(value)));
  return Keypair.fromSecretKey(bs58.decode(value));
}

export function initLiveExecution() {
  if (!SOLANA_PRIVATE_KEY) return;
  try {
    liveWallet = parseKeypair(SOLANA_PRIVATE_KEY);
    solanaConnection = new Connection(SOLANA_RPC_URL, 'confirmed');
    log.info(`wallet loaded ${liveWallet.publicKey.toBase58()}`);
  } catch (err) {
    liveWallet = null;
    solanaConnection = null;
    log.error(`wallet load failed: ${err.message}`);
  }
}

export function liveWalletPubkey() {
  return liveWallet?.publicKey?.toBase58() || null;
}

export async function fetchLiveTokenBalance(mint) {
  if (!liveWallet || !solanaConnection) return null;
  try {
    const accounts = await solanaConnection.getParsedTokenAccountsByOwner(
      liveWallet.publicKey,
      { mint: new PublicKey(mint) },
      'confirmed',
    );
    return accounts.value[0]?.account?.data?.parsed?.info?.tokenAmount?.amount || null;
  } catch (err) {
    log.warn(`token balance ${mint.slice(0, 8)}... ${err.message}`);
    return null;
  }
}

export function requireLiveExecution() {
  if (!liveWallet || !solanaConnection) throw new Error('SOLANA_PRIVATE_KEY is required for live execution.');
  if (!JUPITER_API_KEY) throw new Error('JUPITER_API_KEY is required for live execution.');
}

export async function liveWalletBalanceLamports() {
  requireLiveExecution();
  return solanaConnection.getBalance(liveWallet.publicKey, 'confirmed');
}

async function jupiterOrder({ inputMint, outputMint, amount }) {
  requireLiveExecution();
  const url = new URL(`${JUPITER_SWAP_BASE_URL.replace(/\/$/, '')}/order`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('taker', liveWallet.publicKey.toBase58());
  const res = await axios.get(url.toString(), {
    timeout: 20_000,
    headers: { ...JSON_HEADERS, 'x-api-key': JUPITER_API_KEY },
  });
  const order = res.data;
  if (order.errorCode || order.error) {
    throw new Error(`Jupiter order failed: ${order.errorMessage || order.error || order.errorCode}`);
  }
  return order;
}

function orderTransactionBase64(order) {
  return order?.transaction || order?.swapTransaction || null;
}

function signTransactionBase64(transactionBase64) {
  const tx = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'));
  tx.sign([liveWallet]);
  return Buffer.from(tx.serialize()).toString('base64');
}

async function jupiterExecute(order, signedTransaction) {
  requireLiveExecution();
  const body = {
    signedTransaction,
    requestId: order.requestId,
  };
  const res = await axios.post(`${JUPITER_SWAP_BASE_URL.replace(/\/$/, '')}/execute`, body, {
    timeout: 30_000,
    headers: { ...JSON_HEADERS, 'content-type': 'application/json', 'x-api-key': JUPITER_API_KEY },
  });
  return res.data;
}

export async function executeJupiterSwap({ inputMint, outputMint, amount }) {
  const order = await jupiterOrder({ inputMint, outputMint, amount });
  const transaction = orderTransactionBase64(order);
  if (!transaction) throw new Error('Jupiter order did not include a transaction.');
  const signedTransaction = signTransactionBase64(transaction);
  const executed = await jupiterExecute(order, signedTransaction);
  if (executed?.status && executed.status !== 'Success') {
    throw new Error(`Jupiter execute failed: ${executed.error || executed.code || executed.status}`);
  }
  const signature = executed?.signature || executed?.txid || executed?.transactionId || null;
  if (!signature) {
    throw new Error(`Jupiter execute returned no signature (status: ${executed?.status || 'unknown'})`);
  }
  return {
    order,
    executed,
    signature,
    inputAmount: String(amount),
    outputAmount: String(executed?.outputAmountResult || executed?.totalOutputAmount || order?.outAmount || ''),
  };
}

function closeAccountInstruction(programId, account, owner) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true }, // rent destination
      { pubkey: owner, isSigner: true, isWritable: false }, // close authority
    ],
    data: Buffer.from([9]), // SPL Token CloseAccount
  });
}

async function sendCloseBatch(instructions) {
  const { blockhash, lastValidBlockHeight } = await solanaConnection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: liveWallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([liveWallet]);
  const signature = await solanaConnection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  await solanaConnection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  return signature;
}

// After a full sell the position's token account is empty; close it to reclaim the ~0.002 SOL
// rent. Best-effort: never throws into the exit path, and only ever closes a zero-balance
// account (a partial sell leaves tokens behind, so it is skipped).
export async function closeEmptyTokenAccounts(mint) {
  if (!liveWallet || !solanaConnection) return 0;
  try {
    const accounts = await solanaConnection.getParsedTokenAccountsByOwner(
      liveWallet.publicKey,
      { mint: new PublicKey(mint) },
      'confirmed',
    );
    const instructions = [];
    for (const { pubkey, account } of accounts.value) {
      const amount = account.data?.parsed?.info?.tokenAmount?.amount;
      if (amount && amount !== '0') continue;
      instructions.push(closeAccountInstruction(account.owner, pubkey, liveWallet.publicKey));
    }
    if (!instructions.length) return 0;
    const signature = await sendCloseBatch(instructions);
    log.info(`reclaimed rent on ${instructions.length} empty account(s) for ${mint.slice(0, 8)}... (${signature.slice(0, 8)}...)`);
    return instructions.length;
  } catch (err) {
    log.warn(`close empty account ${mint.slice(0, 8)}... failed: ${err.message}`);
    return 0;
  }
}

// One-shot reclaim: scan the wallet and close every empty token account. Used by
// scripts/reclaim-rent.js. Throws if no wallet is loaded; does not need a Jupiter key.
export async function closeAllEmptyTokenAccounts({ dryRun = false } = {}) {
  if (!liveWallet || !solanaConnection) throw new Error('SOLANA_PRIVATE_KEY is required to reclaim rent.');
  const empty = [];
  for (const programId of TOKEN_PROGRAM_IDS) {
    const accounts = await solanaConnection.getParsedTokenAccountsByOwner(liveWallet.publicKey, { programId }, 'confirmed');
    for (const { pubkey, account } of accounts.value) {
      const amount = account.data?.parsed?.info?.tokenAmount?.amount;
      if (!amount || amount === '0') empty.push({ pubkey, programId });
    }
  }
  if (dryRun || !empty.length) return { found: empty.length, closed: 0, signatures: [] };
  const signatures = [];
  const BATCH = 10;
  for (let i = 0; i < empty.length; i += BATCH) {
    const instructions = empty.slice(i, i + BATCH).map(e => closeAccountInstruction(e.programId, e.pubkey, liveWallet.publicKey));
    signatures.push(await sendCloseBatch(instructions));
  }
  return { found: empty.length, closed: empty.length, signatures };
}
