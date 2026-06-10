/**
 * Logger estructurado simple
 */
'use strict';

const config = require('../config');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[config.log.level] || LEVELS.info;

function format(level, msg, meta) {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  if (meta && Object.keys(meta).length) {
    try {
      return base + ' ' + JSON.stringify(meta);
    } catch (e) {
      return base + ' [unserializable meta]';
    }
  }
  return base;
}

const logger = {
  debug(msg, meta) {
    if (currentLevel <= LEVELS.debug) console.log(format('debug', msg, meta));
  },
  info(msg, meta) {
    if (currentLevel <= LEVELS.info) console.log(format('info', msg, meta));
  },
  warn(msg, meta) {
    if (currentLevel <= LEVELS.warn) console.warn(format('warn', msg, meta));
  },
  error(msg, meta) {
    if (currentLevel <= LEVELS.error) console.error(format('error', msg, meta));
  },
};

module.exports = logger;
