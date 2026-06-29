const SECRET_FIELD_NAMES = new Set([
  "authorization",
  "apikey",
  "api-key",
  "api_key",
  "token",
  "credential",
  "credentials",
  "secret"
]);

function isSecretFieldName(key: string): boolean {
  const lowerKey = key.toLowerCase();
  const compactKey = lowerKey.replace(/[_-]/g, "");

  return SECRET_FIELD_NAMES.has(lowerKey) || SECRET_FIELD_NAMES.has(compactKey);
}

const BEARER_TOKEN_PATTERN = /\b(Bearer)(\s+)(?!sk-\*\*\*|\*\*\*)([A-Za-z0-9._+\/=~-]+)/gi;
const STANDALONE_SK_PATTERN = /sk-[A-Za-z0-9._-]+/g;
const CONTEXTUAL_SECRET_PATTERN =
  /\b(api[\s_-]*key|apikey|token|secret|credentials?|credential)(\s*[:=]\s*|\s+)([A-Za-z0-9._+\/=~-]{8,})/gi;

export interface RedactSecretsOptions {
  knownSecrets?: readonly string[];
}

function normalizeKnownSecrets(options: RedactSecretsOptions): string[] {
  return [...new Set(options.knownSecrets?.filter((secret) => secret.length > 0) ?? [])].sort(
    (left, right) => right.length - left.length
  );
}

function redactKnownSecrets(value: string, options: RedactSecretsOptions): string {
  return normalizeKnownSecrets(options).reduce((redacted, secret) => {
    return redacted.split(secret).join("***");
  }, value);
}

function isLikelySensitiveToken(token: string): boolean {
  return token.length >= 16 || /[0-9._+\/=~-]/.test(token);
}

function redactString(value: string, options: RedactSecretsOptions): string {
  const redacted = value
    .replace(BEARER_TOKEN_PATTERN, (_match, scheme: string, spacing: string, token: string) => {
      return token.toLowerCase().startsWith("sk-")
        ? `${scheme}${spacing}sk-***`
        : `${scheme}${spacing}***`;
    })
    .replace(
      CONTEXTUAL_SECRET_PATTERN,
      (match: string, context: string, separator: string, token: string) => {
        return isLikelySensitiveToken(token) ? `${context}${separator}***` : match;
      }
    )
    .replace(STANDALONE_SK_PATTERN, "sk-***");

  return redactKnownSecrets(redacted, options);
}

function redactFieldValue(
  key: string,
  value: unknown,
  options: RedactSecretsOptions,
  activeObjects: WeakSet<object>
): unknown {
  if (!isSecretFieldName(key)) {
    return redactValue(value, options, activeObjects);
  }

  if (key.toLowerCase() === "authorization" && typeof value === "string") {
    return redactString(value, options);
  }

  return "***";
}

function redactValue(
  value: unknown,
  options: RedactSecretsOptions,
  activeObjects: WeakSet<object>
): unknown {
  if (typeof value === "string") {
    return redactString(value, options);
  }

  if (Array.isArray(value)) {
    if (activeObjects.has(value)) {
      return "[Circular]";
    }

    activeObjects.add(value);
    const redacted = value.map((item) => redactValue(item, options, activeObjects));
    activeObjects.delete(value);

    return redacted;
  }

  if (value && typeof value === "object") {
    if (activeObjects.has(value)) {
      return "[Circular]";
    }

    activeObjects.add(value);
    const redacted = Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        redactFieldValue(key, nestedValue, options, activeObjects)
      ])
    );
    activeObjects.delete(value);

    return redacted;
  }

  return value;
}

export function redactSecrets<T>(value: T, options: RedactSecretsOptions = {}): T {
  return redactValue(value, options, new WeakSet<object>()) as T;
}
