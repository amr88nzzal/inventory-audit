// خطأ تطبيقي موحّد يُحوَّل إلى { error: { code, status, message, details, requestId } }.
// Unified application error, serialized as { error: { code, status, message, details, requestId } }.
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(code: string, status: number, message: string, details: unknown = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
