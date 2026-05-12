import { setDefaultResultOrder } from 'node:dns';
import { APP_NAME, SIGNAL_SERVER_URL, SIGNAL_POLL_MS, GRADUATED_POLL_MS, TRENDING_POLL_MS, POSITION_CHECK_MS, validateConfig } from './config.js';
import { initDb } from './db/connection.js';
import { initLiveExecution } from './liveExecutor.js';
import { setupTelegram } from './telegram/commands.js';
import { monitorPositions } from './execution/positions.js';
import { processCandidateFromSignals, maybeProcessDegenCandidate } from './pipeline/orchestrator.js';
import { sendTelegram } from './telegram/send.js';
import { makeFailureTracker } from './utils.js';
import { startPostgresSync } from './sync/postgresSink.js';
import { machineId } from './db/machineId.js';
import { logger } from './log.js';

const botLog = logger('bot');
const serverLog = logger('server');
const graduatedLog = logger('graduated');
const trendingLog = logger('trending');

setDefaultResultOrder('ipv4first');
validateConfig();

export async function startCharon() {
  initDb();
  botLog.info(`machine_id ${machineId()}`);
  startPostgresSync();
  initLiveExecution();
  setupTelegram();

  if (SIGNAL_SERVER_URL) {
    // ── Server mode: fetch signals from signal server ──────────────────────
    const { fetchServerSignals, setCandidateHandler, setDegenHandler } = await import('./signals/serverClient.js');

    setCandidateHandler(processCandidateFromSignals);
    setDegenHandler(maybeProcessDegenCandidate);

    const alert = (msg) => sendTelegram(msg);
    const trackServer = makeFailureTracker('server signals', alert);
    const trackDip = makeFailureTracker('dip monitor', alert);

    await fetchServerSignals().catch(error => serverLog.warn(`initial fetch failed: ${error.message}`));
    setInterval(() => trackServer(() => fetchServerSignals()), SIGNAL_POLL_MS);

    // Price monitor for dip buy strategy
    const { monitorPriceAlerts, cleanupAlerts } = await import('./signals/priceMonitor.js');
    const { setCandidateHandler: setAlertHandler } = await import('./signals/priceMonitor.js');
    setAlertHandler(processCandidateFromSignals);
    setInterval(() => trackDip(() => monitorPriceAlerts()), 10_000);
    setInterval(() => cleanupAlerts(), 60 * 60 * 1000);

    botLog.info(`${APP_NAME} started (server mode: ${SIGNAL_SERVER_URL})`);
  } else {
    // ── Standalone mode: direct polling (legacy) ───────────────────────────
    const { fetchGraduatedCoins } = await import('./signals/graduated.js');
    const { fetchGmgnTrending, setDegenHandler } = await import('./signals/trending.js');
    const { startWebsocket, setCandidateHandler } = await import('./signals/feeClaim.js');

    setDegenHandler(maybeProcessDegenCandidate);
    setCandidateHandler(processCandidateFromSignals);

    await fetchGraduatedCoins().catch(error => graduatedLog.warn(`initial fetch failed: ${error.message}`));
    await fetchGmgnTrending().catch(error => trendingLog.warn(`initial fetch failed: ${error.message}`));

    setInterval(() => fetchGraduatedCoins().catch(error => graduatedLog.warn(error.message)), GRADUATED_POLL_MS);
    setInterval(() => fetchGmgnTrending().catch(error => trendingLog.warn(error.message)), TRENDING_POLL_MS);
    startWebsocket();

    botLog.info(`${APP_NAME} started (standalone mode)`);
  }

  // Position monitoring runs in both modes
  const trackPositions = makeFailureTracker('position monitor', (msg) => sendTelegram(msg));
  setInterval(() => trackPositions(() => monitorPositions()), POSITION_CHECK_MS);
}
