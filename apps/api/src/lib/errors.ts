export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, code = 'bad_request', details?: unknown) => new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required', code = 'unauthorized') => new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission to do that', code = 'forbidden') => new AppError(403, code, message);
export const notFound = (message = 'Not found', code = 'not_found') => new AppError(404, code, message);
export const conflict = (message: string, code = 'conflict') => new AppError(409, code, message);
export const unprocessable = (message: string, code = 'unprocessable') => new AppError(422, code, message);
