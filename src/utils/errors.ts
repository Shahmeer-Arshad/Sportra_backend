/**
 * Base application error class.
 * All custom errors should extend this.
 */
const DEFAULT_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  500: 'INTERNAL_ERROR',
}
function defaultCode(status: number) {
  return DEFAULT_CODES[status] ?? 'ERROR'
}

export class AppError extends Error {
  public readonly statusCode: number
  public readonly isOperational: boolean
  /** Stable machine-readable code, e.g. SLOT_HELD, VALIDATION_ERROR. */
  public readonly code: string
  public readonly details?: unknown

  constructor(
    message: string,
    statusCode: number,
    isOperational = true,
    code?: string,
    details?: unknown,
  ) {
    super(message)
    this.statusCode = statusCode
    this.isOperational = isOperational
    this.code = code ?? defaultCode(statusCode)
    this.details = details
    Object.setPrototypeOf(this, new.target.prototype)
    Error.captureStackTrace(this)
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', code?: string, details?: unknown) {
    super(message, 400, true, code, details)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', code?: string, details?: unknown) {
    super(message, 401, true, code, details)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', code?: string, details?: unknown) {
    super(message, 403, true, code, details)
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', code?: string, details?: unknown) {
    super(message, 404, true, code, details)
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', code?: string, details?: unknown) {
    super(message, 409, true, code, details)
  }
}

export class InternalServerError extends AppError {
  constructor(message = 'Internal server error') {
    super(message, 500, false)
  }
}
