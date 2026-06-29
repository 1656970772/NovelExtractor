import { redactSecrets, type RedactSecretsOptions } from "@novel-extractor/llm/redaction";

export type RunLogLevel = "debug" | "info" | "warn" | "error";

export interface RunLogEntry {
  level: RunLogLevel;
  message: string;
  details?: unknown;
  createdAt?: string;
}

export interface RunLoggerOptions extends RedactSecretsOptions {
  clock?: {
    now(): string;
  };
}

export interface RunLogger {
  formatEntry(entry: RunLogEntry): string;
  formatEntries(entries: readonly RunLogEntry[]): string;
}

function normalizeForJson(value: unknown, activeObjects: WeakSet<object> = new WeakSet<object>()): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "symbol") {
    return value.toString();
  }

  if (typeof value === "function") {
    return value.name ? `[Function: ${value.name}]` : "[Function]";
  }

  if (Array.isArray(value)) {
    if (activeObjects.has(value)) {
      return "[Circular]";
    }

    activeObjects.add(value);
    const normalized = value.map((item) => normalizeForJson(item, activeObjects));
    activeObjects.delete(value);

    return normalized;
  }

  if (value && typeof value === "object") {
    if (activeObjects.has(value)) {
      return "[Circular]";
    }

    activeObjects.add(value);
    const normalized = Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, normalizeForJson(nestedValue, activeObjects)])
    );
    activeObjects.delete(value);

    return normalized;
  }

  return value;
}

export function createRunLogger(options: RunLoggerOptions = {}): RunLogger {
  const clock = options.clock ?? { now: () => new Date().toISOString() };

  return {
    formatEntry(entry) {
      const safeEntry = redactSecrets(
        {
          createdAt: entry.createdAt ?? clock.now(),
          level: entry.level,
          message: entry.message,
          details: normalizeForJson(entry.details)
        },
        { knownSecrets: options.knownSecrets }
      );

      return JSON.stringify(safeEntry);
    },

    formatEntries(entries) {
      return entries.map((entry) => this.formatEntry(entry)).join("\n");
    }
  };
}
