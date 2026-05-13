CREATE TABLE IF NOT EXISTS bots (
  machine_id UUID PRIMARY KEY,
  label TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS candidates (
  machine_id UUID NOT NULL,
  local_id BIGINT NOT NULL,
  mint TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  signature TEXT,
  signal_key TEXT,
  candidate JSONB NOT NULL,
  filter_result JSONB NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (machine_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_candidates_mint ON candidates (mint);
CREATE INDEX IF NOT EXISTS idx_candidates_created ON candidates (created_at_ms);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates (status);

CREATE TABLE IF NOT EXISTS llm_decisions (
  machine_id UUID NOT NULL,
  local_id BIGINT NOT NULL,
  candidate_local_id BIGINT NOT NULL,
  mint TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  verdict TEXT NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT,
  risks JSONB NOT NULL,
  raw JSONB NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (machine_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_llm_decisions_candidate ON llm_decisions (machine_id, candidate_local_id);
CREATE INDEX IF NOT EXISTS idx_llm_decisions_mint ON llm_decisions (mint);

CREATE TABLE IF NOT EXISTS llm_batches (
  machine_id UUID NOT NULL,
  local_id BIGINT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  trigger_candidate_local_id BIGINT,
  selected_candidate_local_id BIGINT,
  selected_mint TEXT,
  verdict TEXT NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT,
  risks JSONB NOT NULL,
  raw JSONB NOT NULL,
  candidate_local_ids JSONB NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (machine_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_llm_batches_created ON llm_batches (created_at_ms);

CREATE TABLE IF NOT EXISTS decision_logs (
  machine_id UUID NOT NULL,
  local_id BIGINT NOT NULL,
  at_ms BIGINT NOT NULL,
  batch_local_id BIGINT,
  trigger_candidate_local_id BIGINT,
  selected_candidate_local_id BIGINT,
  selected_mint TEXT,
  mode TEXT NOT NULL,
  action TEXT NOT NULL,
  verdict TEXT,
  confidence REAL,
  reason TEXT,
  guardrails JSONB NOT NULL,
  token JSONB NOT NULL,
  candidate JSONB NOT NULL,
  batch JSONB NOT NULL,
  execution JSONB NOT NULL,
  strategy_id TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (machine_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_decision_logs_at_ms ON decision_logs (at_ms);
CREATE INDEX IF NOT EXISTS idx_decision_logs_mint ON decision_logs (selected_mint);

CREATE TABLE IF NOT EXISTS dry_run_positions (
  machine_id UUID NOT NULL,
  local_id BIGINT NOT NULL,
  candidate_local_id BIGINT,
  mint TEXT NOT NULL,
  symbol TEXT,
  status TEXT NOT NULL,
  opened_at_ms BIGINT NOT NULL,
  closed_at_ms BIGINT,
  size_sol REAL NOT NULL,
  entry_price DOUBLE PRECISION,
  entry_mcap DOUBLE PRECISION,
  token_amount_est DOUBLE PRECISION,
  high_water_price DOUBLE PRECISION,
  high_water_mcap DOUBLE PRECISION,
  tp_percent REAL NOT NULL,
  sl_percent REAL NOT NULL,
  trailing_enabled INTEGER NOT NULL,
  trailing_percent REAL NOT NULL,
  trailing_armed INTEGER NOT NULL DEFAULT 0,
  exit_price DOUBLE PRECISION,
  exit_mcap DOUBLE PRECISION,
  exit_reason TEXT,
  pnl_percent REAL,
  pnl_sol REAL,
  llm_decision_local_id BIGINT,
  execution_mode TEXT,
  entry_signature TEXT,
  exit_signature TEXT,
  token_amount_raw TEXT,
  strategy_id TEXT,
  partial_tp_done INTEGER DEFAULT 0,
  snapshot JSONB NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (machine_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_positions_closed ON dry_run_positions (closed_at_ms);
CREATE INDEX IF NOT EXISTS idx_positions_status ON dry_run_positions (status);
CREATE INDEX IF NOT EXISTS idx_positions_mint ON dry_run_positions (mint);

CREATE TABLE IF NOT EXISTS dry_run_trades (
  machine_id UUID NOT NULL,
  local_id BIGINT NOT NULL,
  position_local_id BIGINT NOT NULL,
  mint TEXT NOT NULL,
  side TEXT NOT NULL,
  at_ms BIGINT NOT NULL,
  price DOUBLE PRECISION,
  mcap DOUBLE PRECISION,
  size_sol REAL,
  token_amount_est DOUBLE PRECISION,
  reason TEXT,
  payload JSONB NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (machine_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_trades_position ON dry_run_trades (machine_id, position_local_id);
CREATE INDEX IF NOT EXISTS idx_trades_at_ms ON dry_run_trades (at_ms);

CREATE TABLE IF NOT EXISTS learning_lessons (
  machine_id UUID NOT NULL,
  local_id BIGINT NOT NULL,
  run_local_id BIGINT,
  created_at_ms BIGINT NOT NULL,
  status TEXT NOT NULL,
  lesson TEXT NOT NULL,
  evidence JSONB,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (machine_id, local_id)
);

-- Shared across machines, populated by the backtester
CREATE TABLE IF NOT EXISTS historical_candles (
  mint TEXT NOT NULL,
  interval TEXT NOT NULL,
  time_sec BIGINT NOT NULL,
  open DOUBLE PRECISION NOT NULL,
  high DOUBLE PRECISION NOT NULL,
  low DOUBLE PRECISION NOT NULL,
  close DOUBLE PRECISION NOT NULL,
  volume DOUBLE PRECISION,
  quote TEXT NOT NULL DEFAULT 'native',
  fetched_at_ms BIGINT NOT NULL,
  PRIMARY KEY (mint, interval, time_sec, quote)
);
CREATE INDEX IF NOT EXISTS idx_hist_candles_mint_time ON historical_candles (mint, interval, time_sec);
