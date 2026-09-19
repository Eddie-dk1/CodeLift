export class AnalysisError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AnalysisError";
    this.code = code;
  }
}
