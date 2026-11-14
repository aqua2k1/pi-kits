const SENSITIVE_NAME =
  /^(?:access[_-]?token|refresh[_-]?token|api[_-]?key|token|key|secret|password|credential|authorization|auth|signature|hmac|sig|policy|x-amz-[\w-]+|x-goog-[\w-]+)$/i;

export function decodeUrlComponent(value: string): string {
  for (let i = 0; i < 4; i++) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch {
      break;
    }
  }
  return value;
}

export function isSensitivePathName(value: string): boolean {
  return SENSITIVE_NAME.test(decodeUrlComponent(value));
}

/** Search and fetch share one credential query policy. */
export function isSensitiveQueryName(value: string): boolean {
  const name = decodeUrlComponent(value);
  return (
    SENSITIVE_NAME.test(name) ||
    /(?:token|key|secret|password|credential|authorization|signature)/i.test(
      name,
    )
  );
}
