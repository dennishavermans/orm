import {
  checkAborted,
  raceAgainstAbort,
  runtimeError,
} from '@internal/framework-components/runtime';
import type {
  AnyQueryAst,
  Codec,
  ContractCodecRegistry,
  ProjectionItem,
  RawQueryAst,
  SqlCodecCallContext,
} from '@internal/sql-relational-core/ast';
import { blindCast } from '@internal/utils/casts';
import { isStructuredError } from '@internal/utils/structured-error';

type ColumnRef = { table: string; column: string };
type IncludeAggregateValue = object | string | number | boolean | null;

interface DecodeFieldPlan {
  readonly alias: string;
  readonly codec: Codec | undefined;
  readonly ref: ColumnRef | undefined;
  readonly callColumn: SqlCodecCallContext['column'];
  readonly include: boolean;
  readonly many: boolean;
}

interface CompiledRowDecoder {
  readonly createTasks: (
    row: Record<string, unknown>,
    rowCtx: SqlCodecCallContext,
  ) => Promise<unknown>[];
  readonly createResult: (
    row: Record<string, unknown>,
    settled: unknown[],
  ) => Record<string, unknown>;
}

export interface DecodeContext {
  readonly aliases: ReadonlyArray<string> | undefined;
  readonly fields: ReadonlyArray<DecodeFieldPlan> | undefined;
  readonly compiled?: CompiledRowDecoder;
  readonly codecs: ReadonlyMap<string, Codec>;
  readonly columnRefs: ReadonlyMap<string, ColumnRef>;
  readonly includeAliases: ReadonlySet<string>;
  readonly manyAliases: ReadonlySet<string>;
  /**
   * Where {@link DecodeContext.aliases} came from, which decides how a row
   * that lacks one of them reads: a projection the builder wrote is the
   * runtime's own doing, while a row spec is the author's declaration about a
   * statement the runtime never inspected.
   */
  readonly aliasSource: 'projection' | 'row-spec';
}

const WIRE_PREVIEW_LIMIT = 100;
const EMPTY_INCLUDE_ALIASES: ReadonlySet<string> = new Set<string>();

function projectionListFromAst(ast: unknown): ReadonlyArray<ProjectionItem> | undefined {
  if (typeof ast !== 'object' || ast === null) {
    return undefined;
  }
  if ('kind' in ast && ast.kind === 'select') {
    if (!('projection' in ast) || !Array.isArray(ast.projection)) {
      return undefined;
    }
    return blindCast<
      ReadonlyArray<ProjectionItem>,
      'Array.isArray validates the projection list and the query AST validator guarantees its items'
    >(ast.projection);
  }
  if (!('returning' in ast) || ast.returning === undefined || !Array.isArray(ast.returning)) {
    return undefined;
  }
  return blindCast<
    ReadonlyArray<ProjectionItem>,
    'Array.isArray validates the returning list and the query AST validator guarantees its items'
  >(ast.returning);
}

function resolveProjectionCodec(
  item: ProjectionItem,
  contractCodecs: ContractCodecRegistry | undefined,
): Codec | undefined {
  if (item.codec && contractCodecs) {
    return contractCodecs.forCodecRef(item.codec);
  }
  return undefined;
}

const EMPTY_MANY_ALIASES: ReadonlySet<string> = new Set<string>();

function undecodedContext(): DecodeContext {
  return {
    aliases: undefined,
    fields: undefined,
    codecs: new Map(),
    columnRefs: new Map(),
    includeAliases: EMPTY_INCLUDE_ALIASES,
    manyAliases: EMPTY_MANY_ALIASES,
    aliasSource: 'projection',
  };
}

/**
 * Decode context for a raw statement: the columns come from the row spec its
 * author declared at the terminator, and each carries the codec that decodes
 * it. A statement that reports an affected-row count declares no columns, so
 * its single stats row passes through undecoded.
 *
 * The spec is the only description of the result — the runtime never parses
 * the SQL — so it is also what a mismatched result set is measured against.
 */
function rawQueryDecodeContext(
  ast: RawQueryAst,
  contractCodecs: ContractCodecRegistry | undefined,
): DecodeContext {
  if (ast.result.kind === 'affected-count') {
    return undecodedContext();
  }

  const aliases: string[] = [];
  const fields: DecodeFieldPlan[] = [];
  const codecs = new Map<string, Codec>();
  for (const [name, column] of Object.entries(ast.result.columns)) {
    aliases.push(name);
    if (typeof column !== 'object' || column === null || !('codecId' in column)) {
      throw new TypeError(`Raw query column "${name}" has no codecId`);
    }
    const codecId = column.codecId;
    if (typeof codecId !== 'string') {
      throw new TypeError(`Raw query column "${name}" has a non-string codecId`);
    }
    const codec = contractCodecs?.forCodecRef({ codecId });
    if (codec) {
      codecs.set(name, codec);
    }
    fields.push({
      alias: name,
      codec,
      ref: undefined,
      callColumn: undefined,
      include: false,
      many: false,
    });
  }

  return {
    aliases,
    fields,
    compiled: compileRowDecoder(fields),
    codecs,
    columnRefs: new Map(),
    includeAliases: EMPTY_INCLUDE_ALIASES,
    manyAliases: EMPTY_MANY_ALIASES,
    aliasSource: 'row-spec',
  };
}

export function buildDecodeContext(
  ast: AnyQueryAst,
  contractCodecs: ContractCodecRegistry | undefined,
): DecodeContext {
  if (ast.kind === 'raw-query') {
    return rawQueryDecodeContext(ast, contractCodecs);
  }

  const projection = projectionListFromAst(ast);
  if (!projection || projection.length === 0) {
    return undecodedContext();
  }

  const aliases: string[] = [];
  const fields: DecodeFieldPlan[] = [];
  const codecs = new Map<string, Codec>();
  const columnRefs = new Map<string, ColumnRef>();
  const includeAliases = new Set<string>();
  const manyAliases = new Set<string>();

  for (const item of projection) {
    aliases.push(item.alias);

    const codec = resolveProjectionCodec(item, contractCodecs);
    if (codec) {
      codecs.set(item.alias, codec);
    }

    const many = item.codec?.many === true;
    if (many) {
      manyAliases.add(item.alias);
    }

    let ref: ColumnRef | undefined;
    let include = false;
    if (item.expr.kind === 'column-ref') {
      ref = { table: item.expr.table, column: item.expr.column };
      columnRefs.set(item.alias, ref);
    } else if (item.expr.kind === 'subquery' || item.expr.kind === 'json-array-agg') {
      include = true;
      includeAliases.add(item.alias);
    }
    const callColumn = ref ? { table: ref.table, name: ref.column } : undefined;
    fields.push({ alias: item.alias, codec, ref, callColumn, include, many });
  }

  return {
    aliases,
    fields,
    compiled: compileRowDecoder(fields),
    codecs,
    columnRefs,
    includeAliases,
    manyAliases,
    aliasSource: 'projection',
  };
}

function previewWireValue(wireValue: unknown): string {
  if (typeof wireValue === 'string') {
    return wireValue.length > WIRE_PREVIEW_LIMIT
      ? `${wireValue.substring(0, WIRE_PREVIEW_LIMIT)}...`
      : wireValue;
  }
  return String(wireValue).substring(0, WIRE_PREVIEW_LIMIT);
}

function wrapDecodeFailure(
  error: unknown,
  alias: string,
  ref: ColumnRef | undefined,
  codec: Codec,
  wireValue: unknown,
): never {
  const message = error instanceof Error ? error.message : String(error);
  const target = ref ? `${ref.table}.${ref.column}` : alias;
  const wrapped = runtimeError(
    'RUNTIME.DECODE_FAILED',
    `Failed to decode column ${target} with codec '${codec.id}': ${message}`,
    {
      ...(ref ? { table: ref.table, column: ref.column } : { alias }),
      codec: codec.id,
      wirePreview: previewWireValue(wireValue),
    },
  );
  wrapped.cause = error;
  throw wrapped;
}

function wrapIncludeAggregateFailure(error: unknown, alias: string, wireValue: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = runtimeError(
    'RUNTIME.DECODE_FAILED',
    `Failed to parse JSON array for include alias '${alias}': ${message}`,
    {
      alias,
      wirePreview: previewWireValue(wireValue),
    },
  );
  wrapped.cause = error;
  throw wrapped;
}

function decodeIncludeAggregate(alias: string, wireValue: unknown): IncludeAggregateValue {
  if (wireValue === null || wireValue === undefined) {
    return [];
  }

  try {
    if (typeof wireValue === 'string') {
      return JSON.parse(wireValue);
    }
    if (typeof wireValue === 'object') {
      // Driver layer has already parsed the JSON wire value (pg returns
      // json / jsonb columns as JS values). Pass through unchanged —
      // both row include arrays (`json_agg`) and scalar / combine
      // include envelopes (`json_build_object`) flow through this path,
      // each with their own downstream shape decoder.
      return wireValue;
    }
    return JSON.parse(String(wireValue));
  } catch (error) {
    wrapIncludeAggregateFailure(error, alias, wireValue);
  }
}

/**
 * Decodes a single field. Single-armed: every cell takes the same path — `codec.decode → await → return plain value` — so sync- and async-authored codecs are indistinguishable to callers. JSON-Schema validation, when required, lives inside the resolved codec's `decode` body (e.g. `arktype-json` validates against its rehydrated schema and throws `RUNTIME.JSON_SCHEMA_VALIDATION_FAILED` from `decode` directly); there is
 * no separate validator-registry pass.
 *
 * The row-level `rowCtx` is repackaged into a per-cell `SqlCodecCallContext` whose `column = { table, name }` is a structural projection of the per-cell `ColumnRef = { table, column }` resolved from the AST-backed `DecodeContext` (the same resolution `wrapDecodeFailure` uses for envelope construction — one resolution per cell, two consumers). Cells the runtime cannot resolve to a single underlying column (aggregate
 * aliases, computed projections without a simple ref) get `column: undefined`, matching the spec contract that the runtime never silently defaults this field.
 *
 * For `many`-flagged aliases the driver has already parsed the wire form into a JS array; this function maps the element codec over that array element-by-element, passing `null` elements through unchanged. Element-level failures surface through the existing `RUNTIME.DECODE_FAILED` envelope with the column/codec context from the parent cell.
 */
async function decodeManyField(
  field: DecodeFieldPlan,
  wireValue: unknown,
  codec: Codec,
  cellCtx: SqlCodecCallContext,
): Promise<unknown> {
  const { alias, ref } = field;
  if (!Array.isArray(wireValue)) {
    wrapDecodeFailure(
      new TypeError(
        `expected an array from the driver for many-typed column, got ${typeof wireValue}`,
      ),
      alias,
      ref,
      codec,
      wireValue,
    );
  }
  const decoded: unknown[] = [];
  for (const elem of wireValue) {
    if (elem === null || elem === undefined) {
      decoded.push(null);
      continue;
    }
    try {
      decoded.push(await codec.decode(elem, cellCtx));
    } catch (error) {
      if (isStructuredError(error)) throw error;
      wrapDecodeFailure(error, alias, ref, codec, elem);
    }
  }
  return decoded;
}

function decodeField(
  field: DecodeFieldPlan,
  wireValue: unknown,
  rowCtx: SqlCodecCallContext,
): Promise<unknown> {
  if (wireValue === null) {
    return Promise.resolve(null);
  }

  const { alias, codec, ref, callColumn } = field;
  if (!codec) {
    return Promise.resolve(wireValue);
  }

  const signal = rowCtx.signal;
  let cellCtx: SqlCodecCallContext;
  if (callColumn) {
    cellCtx = signal === undefined ? { column: callColumn } : { signal, column: callColumn };
  } else {
    cellCtx = signal === undefined ? {} : { signal };
  }

  if (field.many) {
    return decodeManyField(field, wireValue, codec, cellCtx);
  }

  const wrapFailure = (error: unknown): never => {
    if (isStructuredError(error)) {
      throw error;
    }
    wrapDecodeFailure(error, alias, ref, codec, wireValue);
  };

  try {
    const decoded = codec.decode(wireValue, cellCtx);
    return decoded instanceof Promise
      ? decoded.catch(wrapFailure)
      : Promise.resolve(decoded).catch(wrapFailure);
  } catch (error) {
    return Promise.reject(error).catch(wrapFailure);
  }
}

function compileRowDecoder(fields: ReadonlyArray<DecodeFieldPlan>): CompiledRowDecoder {
  const taskExpressions = fields.map((field, index) =>
    field.include
      ? 'Promise.resolve(undefined)'
      : `decodeField(fields[${index}], row[${JSON.stringify(field.alias)}], rowCtx)`,
  );
  const resultProperties = fields.map((field, index) => {
    const alias = JSON.stringify(field.alias);
    const value = field.include
      ? `decodeIncludeAggregate(${alias}, row[${alias}])`
      : `settled[${index}]`;
    return `[${alias}]: ${value}`;
  });
  const create = new Function(
    'decodeField',
    'decodeIncludeAggregate',
    'fields',
    `"use strict";
return {
  createTasks(row, rowCtx) { return [${taskExpressions.join(',')}]; },
  createResult(row, settled) { return {${resultProperties.join(',')}}; }
};`,
  );
  return blindCast<
    CompiledRowDecoder,
    'new Function is generated exclusively from JSON-escaped aliases and numeric field indices'
  >(create(decodeField, decodeIncludeAggregate, fields));
}

/**
 * Decodes a row by dispatching all per-cell codec calls concurrently via `Promise.all`. Each cell follows the single-armed `decodeField` path. Structured envelopes thrown by codec bodies (anything passing `isStructuredError`) pass through unchanged; all other failures are wrapped in `RUNTIME.DECODE_FAILED` with `{ table, column, codec }` (or `{ alias, codec }` when no column ref is resolvable) and the original error attached on `cause`.
 *
 * When `rowCtx.signal` is provided:
 *
 * - **Already-aborted at entry** short-circuits with `RUNTIME.ABORTED` (`{ phase: 'decode' }`) before any `codec.decode` call is made.
 * - **Mid-flight aborts** race the per-cell `Promise.all` against the signal so the runtime returns promptly even when codec bodies ignore it. In-flight bodies that ignore the signal complete in the background (cooperative cancellation).
 * - Existing structured envelopes (any dotted-code error passing `isStructuredError`, e.g. `RUNTIME.DECODE_FAILED`) from codec bodies pass through unchanged (no double wrap).
 */
export async function decodeRow(
  row: Record<string, unknown>,
  decodeCtx: DecodeContext,
  rowCtx: SqlCodecCallContext,
): Promise<Record<string, unknown>> {
  checkAborted(rowCtx, 'decode');
  const signal = rowCtx.signal;

  const aliases = decodeCtx.aliases ?? Object.keys(row);

  if (decodeCtx.aliases !== undefined) {
    for (const alias of decodeCtx.aliases) {
      if (row[alias] === undefined && !Object.hasOwn(row, alias)) {
        throw decodeCtx.aliasSource === 'row-spec'
          ? runtimeError(
              'RUNTIME.RAW_ROW_COLUMN_MISSING',
              `Raw statement result has no column "${alias}", which its row spec declares`,
              {
                column: alias,
                declaredColumns: decodeCtx.aliases,
                resultColumns: Object.keys(row),
              },
            )
          : runtimeError('RUNTIME.DECODE_FAILED', `Row missing projection alias "${alias}"`, {
              alias,
              expectedAliases: decodeCtx.aliases,
              presentKeys: Object.keys(row),
            });
      }
    }
  }

  const compiled = decodeCtx.compiled;
  let tasks: Promise<unknown>[];
  const includeIndices: { index: number; alias: string; value: unknown }[] = [];

  if (compiled) {
    tasks = compiled.createTasks(row, rowCtx);
  } else {
    tasks = new Array<Promise<unknown>>(aliases.length);
    const fields = decodeCtx.fields;
    if (fields === undefined) {
      let index = 0;
      for (const alias of aliases) {
        tasks[index++] = Promise.resolve(row[alias]);
      }
    } else {
      let index = 0;
      for (const field of fields) {
        const wireValue = row[field.alias];
        if (field.include) {
          includeIndices.push({ index, alias: field.alias, value: wireValue });
          tasks[index++] = Promise.resolve(undefined);
          continue;
        }
        tasks[index++] = decodeField(field, wireValue, rowCtx);
      }
    }
  }

  const allTasks = Promise.all(tasks);
  const settled =
    signal === undefined ? await allTasks : await raceAgainstAbort(allTasks, signal, 'decode');

  if (compiled) {
    return compiled.createResult(row, settled);
  }

  for (const entry of includeIndices) {
    settled[entry.index] = decodeIncludeAggregate(entry.alias, entry.value);
  }

  const decoded: Record<string, unknown> = {};
  let index = 0;
  for (const alias of aliases) {
    decoded[alias] = settled[index++];
  }
  return decoded;
}
