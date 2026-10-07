// Transport/auth-class failure detection (D2). These failures mean the request never
// reached a model, or the process/credential was unusable — retrying on another vendor is
// worthwhile. Content-level failures (a wrong answer, a file the agent misreported) are
// NOT, and must never be retried on someone else's dime.
//
// F8 (issue #2): a bare /auth/i also matched "author"/"authority", so a content-level
// failure like "the file author is missing" was treated as transport and silently retried
// on another vendor. \bauth\b cannot match "author": the word boundary fails before the
// trailing 'o'. Kept as its own module so it can be unit-tested without pulling in
// ControlPlane's heavier imports.
export const TRANSPORT_ERROR_RE =
  /timeout|timed out|exited|MODULE_NOT_FOUND|ENOENT|ECONN|ENOTFOUND|EACCES|EPERM|spawn|not found|\bauth\b|unauthor|credential|login|api[- ]?key/i;

export function isTransportError(err?: string): boolean {
  if (!err) return false;
  return TRANSPORT_ERROR_RE.test(err);
}
