export const STRATEGY_FIELDS = {
  entry_mode:                { type: 'string',  required: true, enum: ['immediate', 'wait_for_dip', 'after_confirmation'] },
  min_source_count:          { type: 'number',  required: true },
  require_fee_claim:         { type: 'boolean', required: true },
  token_age_max_ms:          { type: 'number',  required: true },
  min_mcap_usd:              { type: 'number',  required: true },
  max_mcap_usd:              { type: 'number',  required: true },
  min_fee_claim_sol:         { type: 'number',  required: true },
  min_gmgn_total_fee_sol:    { type: 'number',  required: true },
  min_holders:               { type: 'number',  required: true },
  max_top20_holder_percent:  { type: 'number',  required: true },
  min_saved_wallet_holders:  { type: 'number',  required: true },
  max_ath_distance_pct:      { type: 'number',  required: true },
  min_graduated_volume_usd:  { type: 'number',  required: true },
  trending_min_volume_usd:   { type: 'number',  required: true },
  trending_min_swaps:        { type: 'number',  required: true },
  trending_max_rug_ratio:    { type: 'number',  required: true },
  trending_max_bundler_rate: { type: 'number',  required: true },
  trending_min_smart_degen_count: { type: 'number', required: true },
  trending_min_hot_level:    { type: 'number',  required: true },
  trending_max_top_holder_rate: { type: 'number', required: true },
  min_liquidity_usd:         { type: 'number',  required: true },
  min_mcap_to_liquidity_ratio: { type: 'number', required: true },
  position_size_sol:         { type: 'number',  required: true },
  max_open_positions:        { type: 'number',  required: true },
  tp_percent:                { type: 'number',  required: true },
  sl_percent:                { type: 'number',  required: true },
  trailing_enabled:          { type: 'boolean', required: true },
  trailing_percent:          { type: 'number',  required: true },
  partial_tp:                { type: 'boolean', required: true },
  partial_tp_at_percent:     { type: 'number',  required: true },
  partial_tp_sell_percent:   { type: 'number',  required: true },
  max_hold_ms:               { type: 'number',  required: true },
  use_llm:                   { type: 'boolean', required: true },
  llm_min_confidence:        { type: 'number',  required: true },
};

export function validateStrategyConfig(config, label = 'strategy') {
  if (!config || typeof config !== 'object') {
    throw new Error(`${label}: config must be an object`);
  }
  const seen = new Set();
  for (const [key, spec] of Object.entries(STRATEGY_FIELDS)) {
    seen.add(key);
    const value = config[key];
    if (value === undefined || value === null) {
      if (spec.required) throw new Error(`${label}: missing required field "${key}"`);
      continue;
    }
    if (spec.type === 'number' && typeof value !== 'number') {
      throw new Error(`${label}: field "${key}" must be a number, got ${typeof value}`);
    }
    if (spec.type === 'boolean' && typeof value !== 'boolean') {
      throw new Error(`${label}: field "${key}" must be a boolean, got ${typeof value}`);
    }
    if (spec.type === 'string' && typeof value !== 'string') {
      throw new Error(`${label}: field "${key}" must be a string, got ${typeof value}`);
    }
    if (spec.enum && !spec.enum.includes(value)) {
      throw new Error(`${label}: field "${key}" must be one of [${spec.enum.join(', ')}], got "${value}"`);
    }
  }
  for (const key of Object.keys(config)) {
    if (!seen.has(key)) throw new Error(`${label}: unknown field "${key}"`);
  }
}
