/**
 * Turns an index response body into match records (named groups → values). Pure, so the
 * tricky part of the `http` source is unit-testable without a server.
 *
 * Regex mode: every match of `regex` in the body; its named groups are the record.
 * jsonPath mode: every value selected by `jsonPath`. The record holds the scalar fields of the
 * selected object and of all enclosing objects (inner ones win), or `value` for a scalar.
 * If `regex` is also set, it runs on `field` (default `value`) and adds its groups.
 */

import { queryJsonPath } from '../util/jsonPath';
import type { HttpMatchConfig } from './httpConfig';

export interface MatchResult {
  records: Record<string, string>[];
  /** Why candidates were dropped, for "Test Source". */
  skipped: string[];
}

function scalarFields(value: unknown, into: Record<string, string>): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      into[k] = String(v);
    }
  }
}

function definedGroups(m: RegExpMatchArray): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.groups ?? {})) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function passesWhere(record: Record<string, string>, where: Record<string, string>): boolean {
  return Object.entries(where).every(([k, v]) => record[k] === v);
}

export function extractMatches(body: string, match: HttpMatchConfig): MatchResult {
  const records: Record<string, string>[] = [];
  const skipped: string[] = [];

  if (!match.jsonPath) {
    for (const m of body.matchAll(match.regex!)) {
      const record = definedGroups(m);
      if (passesWhere(record, match.where)) {
        records.push(record);
      } else {
        skipped.push(`"${m[0].slice(0, 80)}": filtered by "where"`);
      }
    }
    return { records, skipped };
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error('Response is not valid JSON, but "match.jsonPath" is set');
  }
  for (const { value, ancestors } of queryJsonPath(json, match.jsonPath)) {
    const record: Record<string, string> = {};
    for (const a of ancestors) {
      scalarFields(a, record);
    }
    if (value !== null && typeof value === 'object') {
      scalarFields(value, record);
    } else if (value !== undefined && value !== null) {
      record.value = String(value);
    }
    const shown = JSON.stringify(value)?.slice(0, 80) ?? String(value);
    if (!passesWhere(record, match.where)) {
      skipped.push(`${shown}: filtered by "where"`);
      continue;
    }
    if (match.regex) {
      const field = match.field ?? 'value';
      const text = record[field];
      if (text === undefined) {
        skipped.push(`${shown}: has no field "${field}"`);
        continue;
      }
      match.regex.lastIndex = 0;
      const m = match.regex.exec(text);
      if (!m) {
        skipped.push(`${shown}: "${field}" does not match the regex`);
        continue;
      }
      Object.assign(record, definedGroups(m));
    }
    records.push(record);
  }
  return { records, skipped };
}
