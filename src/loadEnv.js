import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load .env from the repo root (one level up from src/) regardless of the process CWD, so the
// helper scripts in scripts/ work when invoked from any directory — not only from the repo root.
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env') });
