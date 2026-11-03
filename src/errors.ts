export type ErrorCode = 'not_found' | 'conflict' | 'validation' | 'unauthorized' | 'forbidden' | 'unavailable';

type Status = 400 | 401 | 403 | 404 | 409 | 503;

const httpStatus: Record<ErrorCode, Status> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
};

/** An error that is safe to show to the caller, raised by the service layer. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  get status(): Status {
    return httpStatus[this.code];
  }
}

export const notFound = (what: string) => new AppError('not_found', `${what} not found`);
