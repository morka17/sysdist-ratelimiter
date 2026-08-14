/**
 * Minimal structured-logger interface the rest of the codebase depends on.
 * Keeping this as an interface (rather than importing a concrete logging
 * library's types elsewhere) means a user-supplied logger — Winston,
 * Bunyan, pino, a custom wrapper — can be injected anywhere a `Logger` is
 * expected without this package forcing a specific logging dependency on
 * consumers who already have their own.
 */
export interface Logger {
    debug(obj: Record<string, unknown>, msg?: string): void;
    info(obj: Record<string, unknown>, msg?: string): void;
    warn(obj: Record<string, unknown>, msg?: string): void;
    error(obj: Record<string, unknown>, msg?: string): void;
  }
  
  /**
   * Dependency-free default logger used when no `logger` is injected via
   * config. Emits structured (single-line JSON) records to stdout/stderr so
   * output remains machine-parseable in production without requiring a
   * logging library as a hard dependency of this package. Consumers who want
   * pino/Winston/etc. formatting, transports, or redaction should inject
   * their own `Logger`-shaped instance via `config.logger`.
   */
  export function createDefaultLogger(): Logger {
    const write = (
      stream: NodeJS.WriteStream,
      level: 'debug' | 'info' | 'warn' | 'error',
      obj: Record<string, unknown>,
      msg?: string,
    ): void => {
      const record = {
        level,
        time: new Date().toISOString(),
        ...(msg !== undefined ? { msg } : {}),
        ...obj,
      };
      stream.write(`${JSON.stringify(record)}\n`);
    };
  
    return {
      debug: (obj, msg) => write(process.stdout, 'debug', obj, msg),
      info: (obj, msg) => write(process.stdout, 'info', obj, msg),
      warn: (obj, msg) => write(process.stderr, 'warn', obj, msg),
      error: (obj, msg) => write(process.stderr, 'error', obj, msg),
    };
  }