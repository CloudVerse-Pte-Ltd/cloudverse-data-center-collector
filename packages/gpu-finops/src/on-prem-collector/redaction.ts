export function redactCollectorError(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value);
  text = text.replace(/(authorization|proxy-authorization|token|password|secret|api[-_]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@');
  return text.slice(0, 1024);
}
