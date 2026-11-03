export type ErrorCode = 'not_found' | 'conflict' | 'validation' | 'forbidden';

const httpStatus: Record<ErrorCode, 400 | 403 | 404 | 409> = {
  not_found: 404,
  conflict: 409,
  validation: 400,
  forbidden: 403,
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

  get status(): 400 | 403 | 404 | 409 {
    return httpStatus[this.code];
  }
}

export const notFound = (what: string) => new AppError('not_found', `${what} not found`);
