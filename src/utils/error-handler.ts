import { Request, Response, NextFunction } from 'express';
import { createLogger } from './logger';

const logger = createLogger('error-handler');

export interface ProxyError extends Error {
  statusCode?: number;
  code?: string;
  retryable?: boolean;
}

export function createProxyError(
  message: string,
  statusCode: number = 500,
  code: string = 'PROXY_ERROR',
  retryable: boolean = false
): ProxyError {
  const err: ProxyError = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  err.retryable = retryable;
  return err;
}

export function errorHandler(
  err: ProxyError,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';

  logger.error(`Error ${statusCode}: ${err.message}`, {
    code,
    stack: err.stack,
  });

  res.status(statusCode).json({
    error: {
      message: err.message,
      type: code,
      code: statusCode,
      retryable: err.retryable || false,
    },
  });
}
