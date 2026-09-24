import type { ApiError } from '@sp/shared';

/** Throw from routes/services; the app error handler turns it into an ApiError response. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
  toBody(): ApiError {
    return this.details === undefined ? { error: this.code, message: this.message } : { error: this.code, message: this.message, details: this.details };
  }
}

export const badRequest = (message: string, details?: unknown, code = 'bad_request') => new HttpError(400, code, message, details);
export const validationFailed = (message: string, details?: unknown) => new HttpError(400, 'validation_failed', message, details);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do this', code = 'forbidden') => new HttpError(403, code, message);
export const notFound = (message = 'Not found', code = 'not_found') => new HttpError(404, code, message);
export const conflict = (code: string, message: string, details?: unknown) => new HttpError(409, code, message, details);
export const invalidState = (message: string, details?: unknown) => new HttpError(409, 'invalid_state', message, details);
export const gone = (code: string, message: string) => new HttpError(410, code, message);
export const payloadTooLarge = (message: string) => new HttpError(413, 'payload_too_large', message);
export const unsupportedMedia = (message: string) => new HttpError(415, 'unsupported_media_type', message);
