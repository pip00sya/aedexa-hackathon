// Parsing for data we can't take at face value: request bodies and model responses

export type UnknownRecord = Record<string, unknown>;

export function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}

/** A single-line string with collapsed whitespace, no longer than maxLength */
export function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, maxLength) : "";
}
