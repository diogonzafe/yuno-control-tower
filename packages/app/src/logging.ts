import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

// pino only runs stdSerializers.err on the `err` key, and every call site in
// this repo writes `logger.error({ error }, …)` — so in production every Error
// serialized to `{}`: message, stack and cause gone, exactly when they matter.
// Registering the serializer under `error` keeps the call sites reading the way
// they read and makes the next logger correct by default.
//
// packages/generator/src/logging.ts is a deliberate copy: the generator is a
// separate process that must not take a dependency on the app package.
export function createLogger(name: string, destination?: DestinationStream): Logger {
  const options: LoggerOptions = {
    name,
    // Silent under vitest so expected-error-path tests don't spam pristine test
    // output; LOG_LEVEL overrides either way.
    level: process.env.LOG_LEVEL ?? (process.env.VITEST ? "silent" : "info"),
    serializers: { error: pino.stdSerializers.err },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
