import fs from 'node:fs';
import path from 'node:path';
import { redactString, redactValue } from '../security/redact.js';

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  constructor({ level = 'info', logFile = null, toConsole = true } = {}) {
    this.minLevel = LEVELS[level] ?? LEVELS.info;
    this.logFile = logFile;
    this.toConsole = toConsole;
    if (this.logFile) {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    }
  }

  log(level, message, meta = {}) {
    const numeric = LEVELS[level] ?? LEVELS.info;
    if (numeric < this.minLevel) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message: redactString(String(message)),
      ...redactValue(meta),
    };

    const line = JSON.stringify(entry);
    if (this.toConsole) {
      // Write logs to stderr when running inside stdio MCP so stdout stays pure JSON-RPC
      process.stderr.write(`${line}\n`);
    }
    if (this.logFile) {
      try {
        fs.appendFileSync(this.logFile, `${line}\n`, 'utf8');
      } catch {
        // Ignore disk log errors so app keeps running
      }
    }
  }

  debug(msg, meta) {
    this.log('debug', msg, meta);
  }

  info(msg, meta) {
    this.log('info', msg, meta);
  }

  warn(msg, meta) {
    this.log('warn', msg, meta);
  }

  error(msg, meta) {
    this.log('error', msg, meta);
  }
}

