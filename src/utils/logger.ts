import winston from 'winston';

const logLevel = process.env.LOG_LEVEL || 'info';

const customFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, module: mod, ...meta }) => {
    const prefix = mod ? `[${mod}]` : '';
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level.toUpperCase().padEnd(5)} ${prefix} ${message}${metaStr}`;
  })
);

export function createLogger(module: string) {
  return winston.createLogger({
    level: logLevel,
    format: customFormat,
    defaultMeta: { module },
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize({ level: true }),
          customFormat
        ),
      }),
    ],
  });
}
