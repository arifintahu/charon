const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

function ts() {
  return new Date().toISOString();
}

function emit(level, tag, args) {
  if (LEVELS[level] < MIN) return;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  stream(`${ts()} ${level.toUpperCase().padEnd(5)} [${tag}]`, ...args);
}

export function logger(tag) {
  return {
    debug: (...a) => emit('debug', tag, a),
    info:  (...a) => emit('info',  tag, a),
    warn:  (...a) => emit('warn',  tag, a),
    error: (...a) => emit('error', tag, a),
  };
}
