/** A task was rejected before dispatch; no native/user work was touched. */
export class RuntimeTaskRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeTaskRejectedError";
  }
}
