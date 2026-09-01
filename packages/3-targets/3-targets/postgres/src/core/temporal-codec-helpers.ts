export const PG_DATE_NATIVE_TYPE = 'date';
export const PG_TIMESTAMP_NATIVE_TYPE = 'timestamp without time zone';
export const PG_TIMESTAMPTZ_NATIVE_TYPE = 'timestamp with time zone';
export const PG_TIME_NATIVE_TYPE = 'time';

import {
  PG_DATE_TEMPORAL_CODEC_ID,
  PG_TIME_TEMPORAL_CODEC_ID,
  PG_TIMESTAMP_TEMPORAL_CODEC_ID,
  PG_TIMESTAMPTZ_TEMPORAL_CODEC_ID,
} from './codec-ids';
import {
  errorTemporalNonIsoCalendar,
  errorTemporalUnavailable,
  errorTemporalUnrepresentable,
  errorTemporalWrongType,
} from './errors';

const POSTGRES_TEMPORAL_SENTINELS: ReadonlySet<string> = new Set(['infinity', '-infinity']);

const EXPANDED_YEAR_DIGITS = 6;
const ORDINARY_YEAR_DIGITS = 4;
const BC_SUFFIX = ' BC';

function adaptPostgresEra(text: string): string {
  const isBc = text.endsWith(BC_SUFFIX);
  const body = isBc ? text.slice(0, -BC_SUFFIX.length) : text;
  const yearEnd = body.indexOf('-');
  if (yearEnd <= 0) {
    return text;
  }
  const yearText = body.slice(0, yearEnd);
  if (!isBc && yearText.length <= ORDINARY_YEAR_DIGITS) {
    return text;
  }
  const year = Number(yearText);
  if (!Number.isInteger(year)) {
    return text;
  }
  const proleptic = isBc ? 1 - year : year;
  const sign = proleptic < 0 ? '-' : '+';
  const digits = String(Math.abs(proleptic)).padStart(EXPANDED_YEAR_DIGITS, '0');
  return `${sign}${digits}${body.slice(yearEnd)}`;
}

export function requireTemporal(codecId: string, operation: 'decode' | 'encode'): void {
  if (typeof Temporal === 'undefined') {
    throw errorTemporalUnavailable(codecId, operation);
  }
}

interface TemporalCodecIdentity {
  readonly codecId: string;
  readonly stringType: string;
  readonly temporalTag: string;
}

function decodeTemporalText<T>(
  identity: TemporalCodecIdentity,
  wire: string,
  parse: (text: string) => T,
  adapt: (text: string) => string,
): T {
  requireTemporal(identity.codecId, 'decode');
  if (POSTGRES_TEMPORAL_SENTINELS.has(wire)) {
    throw errorTemporalUnrepresentable({
      ...identity,
      operation: 'decode',
      value: wire,
      detail: `PostgreSQL's ${wire} is a sentinel with no position on the timeline, so no Temporal value denotes it`,
    });
  }
  try {
    return parse(adapt(wire));
  } catch (cause) {
    throw errorTemporalUnrepresentable({
      ...identity,
      operation: 'decode',
      value: wire,
      detail: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }
}

function encodeTemporalValue(
  identity: TemporalCodecIdentity,
  value: {
    readonly calendarId?: string;
    readonly [Symbol.toStringTag]?: string;
    toString: () => string;
  },
): string {
  requireTemporal(identity.codecId, 'encode');
  const tag: unknown =
    typeof value === 'object' && value !== null ? value[Symbol.toStringTag] : undefined;
  if (tag !== identity.temporalTag) {
    throw errorTemporalWrongType(
      identity.codecId,
      identity.temporalTag,
      identity.stringType,
      describeEncodeInput(value, tag),
    );
  }
  if (value.calendarId !== undefined && value.calendarId !== 'iso8601') {
    throw errorTemporalNonIsoCalendar(identity.codecId, value.calendarId);
  }
  return value.toString();
}

function describeEncodeInput(value: unknown, tag: unknown): string {
  if (typeof tag === 'string') {
    return `a ${tag}`;
  }
  if (value instanceof Date) {
    return 'a Date';
  }
  if (value === null) {
    return 'null';
  }
  return `a ${typeof value}`;
}

const DATE_TEMPORAL: TemporalCodecIdentity = {
  codecId: PG_DATE_TEMPORAL_CODEC_ID,
  stringType: 'DateString',
  temporalTag: 'Temporal.PlainDate',
};
const TIMESTAMP_TEMPORAL: TemporalCodecIdentity = {
  codecId: PG_TIMESTAMP_TEMPORAL_CODEC_ID,
  stringType: 'TimestampString(p)',
  temporalTag: 'Temporal.PlainDateTime',
};
const TIMESTAMPTZ_TEMPORAL: TemporalCodecIdentity = {
  codecId: PG_TIMESTAMPTZ_TEMPORAL_CODEC_ID,
  stringType: 'TimestamptzString(p)',
  temporalTag: 'Temporal.Instant',
};
const TIME_TEMPORAL: TemporalCodecIdentity = {
  codecId: PG_TIME_TEMPORAL_CODEC_ID,
  stringType: 'TimeString(p)',
  temporalTag: 'Temporal.PlainTime',
};

const unadapted = (text: string): string => text;

function parsePlainDate(text: string): Temporal.PlainDate {
  if (text.length === 10 && text.charCodeAt(4) === 45 && text.charCodeAt(7) === 45) {
    const year0 = text.charCodeAt(0) - 48;
    const year1 = text.charCodeAt(1) - 48;
    const year2 = text.charCodeAt(2) - 48;
    const year3 = text.charCodeAt(3) - 48;
    const month0 = text.charCodeAt(5) - 48;
    const month1 = text.charCodeAt(6) - 48;
    const day0 = text.charCodeAt(8) - 48;
    const day1 = text.charCodeAt(9) - 48;
    if (
      year0 >= 0 &&
      year0 <= 9 &&
      year1 >= 0 &&
      year1 <= 9 &&
      year2 >= 0 &&
      year2 <= 9 &&
      year3 >= 0 &&
      year3 <= 9 &&
      month0 >= 0 &&
      month0 <= 9 &&
      month1 >= 0 &&
      month1 <= 9 &&
      day0 >= 0 &&
      day0 <= 9 &&
      day1 >= 0 &&
      day1 <= 9
    ) {
      return new Temporal.PlainDate(
        year0 * 1000 + year1 * 100 + year2 * 10 + year3,
        month0 * 10 + month1,
        day0 * 10 + day1,
      );
    }
  }
  return Temporal.PlainDate.from(text);
}

export const pgDateTemporalDecode = (wire: string): Temporal.PlainDate =>
  decodeTemporalText(DATE_TEMPORAL, wire, parsePlainDate, adaptPostgresEra);

export const pgDateTemporalEncode = (value: Temporal.PlainDate): string =>
  encodeTemporalValue(DATE_TEMPORAL, value);

export const pgTimestampTemporalDecode = (wire: string): Temporal.PlainDateTime =>
  decodeTemporalText(
    TIMESTAMP_TEMPORAL,
    wire,
    (t) => Temporal.PlainDateTime.from(t),
    adaptPostgresEra,
  );

export const pgTimestampTemporalEncode = (value: Temporal.PlainDateTime): string =>
  encodeTemporalValue(TIMESTAMP_TEMPORAL, value);

export const pgTimestamptzTemporalDecode = (wire: string): Temporal.Instant =>
  decodeTemporalText(TIMESTAMPTZ_TEMPORAL, wire, (t) => Temporal.Instant.from(t), adaptPostgresEra);

export const pgTimestamptzTemporalEncode = (value: Temporal.Instant): string =>
  encodeTemporalValue(TIMESTAMPTZ_TEMPORAL, value);

export const pgTimeTemporalDecode = (wire: string): Temporal.PlainTime =>
  decodeTemporalText(TIME_TEMPORAL, wire, (t) => Temporal.PlainTime.from(t), unadapted);

export const pgTimeTemporalEncode = (value: Temporal.PlainTime): string =>
  encodeTemporalValue(TIME_TEMPORAL, value);
