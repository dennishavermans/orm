import 'temporal-polyfill/global';
import { pathToFileURL } from 'node:url';
import postgres from '@internal/postgres/runtime';
import { buildDecodeContext, decodeRow } from '@internal/sql-runtime/test/utils';
import { Bench, type TaskResult } from 'tinybench';
import contractJson from '../fixtures/northwind.json' with { type: 'json' };
import rowsJson from '../fixtures/rows.json' with { type: 'json' };
import { benchmarkPlans } from './queries';

const REQUEST_MIX = {
  orderWithDetails: 1e5,
  orderWithDetailsAndProducts: 1e5,
  productWithSupplier: 1e5,
  searchProduct: 5e4,
  supplierById: 3e4,
  customerById: 19999,
  ordersWithDetails: 1e4,
  searchCustomer: 5e3,
  employeeWithRecipient: 5e3,
  products: 3e3,
  customers: 2e3,
  suppliers: 1e3,
  employees: 1e3,
};
const MIX_RESPONSES = 200;
const rowCtx = {};

type Row = Record<string, unknown>;
type DecodeContext = Parameters<typeof decodeRow>[1];

export interface BenchmarkCase {
  readonly name: string;
  readonly rows: readonly Row[];
  readonly decodeCtx: DecodeContext;
}

export function createWeightedWorkload<T extends { readonly name: string }>(
  cases: readonly T[],
  requestMix: Readonly<Record<string, number>>,
  responseCount: number,
): T[] {
  const caseByName = new Map(cases.map((entry) => [entry.name, entry]));
  const mixTotal = Object.values(requestMix).reduce((sum, weight) => sum + weight, 0);

  return Object.entries(requestMix).flatMap(([name, weight]) => {
    const entry = caseByName.get(name);
    if (!entry) {
      throw new Error(`Request mix names unknown query "${name}"`);
    }

    const entryResponses = Math.round((weight / mixTotal) * responseCount);
    return Array.from({ length: entryResponses }, () => entry);
  });
}

function createBenchmarkCases(
  plans: ReturnType<typeof benchmarkPlans>,
  fixtures: Readonly<Record<string, readonly Row[]>>,
  contractCodecs: Parameters<typeof buildDecodeContext>[1],
): BenchmarkCase[] {
  return Object.entries(plans).map(([name, plan]) => {
    const rows = fixtures[name];
    if (!rows) {
      throw new Error(`No fixture rows for query "${name}"`);
    }
    return { name, rows, decodeCtx: buildDecodeContext(plan.ast, contractCodecs) };
  });
}

const db = postgres({ contractJson, url: 'postgres://bench@127.0.0.1:5432/bench' });
const plans = benchmarkPlans(db.sql);
export const benchmarkCases = createBenchmarkCases(plans, rowsJson, db.context.contractCodecs);
const caseByName = new Map(benchmarkCases.map((entry) => [entry.name, entry]));
export const benchmarkWorkload = createWeightedWorkload(
  benchmarkCases,
  REQUEST_MIX,
  MIX_RESPONSES,
);

export async function decodeResultSet(
  rows: readonly Row[],
  decodeCtx: DecodeContext,
): Promise<Row[]> {
  const decoded: Row[] = [];
  for (const row of rows) {
    decoded.push(await decodeRow(row, decodeCtx, rowCtx));
  }
  return decoded;
}

function columnCount(rows: readonly Row[]): number {
  return Object.keys(rows[0] ?? {}).length;
}

function format(value: number, digits: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function resultWithStatistics(result: TaskResult | undefined) {
  if (result?.state === 'completed' || result?.state === 'aborted-with-statistics') {
    return result;
  }
  return undefined;
}

async function verifyFixtures(): Promise<void> {
  for (const entry of benchmarkCases) {
    const decoded = await decodeResultSet(entry.rows, entry.decodeCtx);
    const first = decoded[0];
    if (first === undefined) {
      throw new Error(`Query "${entry.name}" decoded no rows`);
    }
    if (Object.keys(first).length !== columnCount(entry.rows)) {
      throw new Error(`Query "${entry.name}" decoded a row of unexpected width`);
    }
  }
}

async function main(): Promise<void> {
  await verifyFixtures();
  const rowBench = new Bench({ name: 'decodeRow — single row', time: 700, warmupTime: 200 });
  for (const entry of benchmarkCases) {
    const row = entry.rows[0];
    if (!row) continue;
    rowBench.add(entry.name, async () => {
      await decodeRow(row, entry.decodeCtx, rowCtx);
    });
  }
  const resultSetBench = new Bench({
    name: 'decodeRow — whole result set',
    time: 700,
    warmupTime: 200,
  });
  for (const entry of benchmarkCases) {
    resultSetBench.add(entry.name, async () => {
      await decodeResultSet(entry.rows, entry.decodeCtx);
    });
  }
  const mixRows = benchmarkWorkload.reduce((sum, entry) => sum + entry.rows.length, 0);
  const mixBench = new Bench({ name: 'decodeRow — northwind request mix', time: 1500 });
  mixBench.add(`${benchmarkWorkload.length} responses / ${mixRows} rows`, async () => {
    for (const entry of benchmarkWorkload) {
      await decodeResultSet(entry.rows, entry.decodeCtx);
    }
  });
  await rowBench.run();
  await resultSetBench.run();
  await mixBench.run();
  console.log(`\n${rowBench.name}`);
  console.table(
    rowBench.tasks.map((task) => {
      const entry = caseByName.get(task.name);
      const result = resultWithStatistics(task.result);
      const latency = result?.latency;
      return {
        query: task.name,
        cols: entry ? columnCount(entry.rows) : 0,
        'ns/row': latency ? format(latency.mean * 1e6, 0) : 'n/a',
        'rows/sec': result ? format(result.throughput.mean, 0) : 'n/a',
        'rme %': latency ? format(latency.rme, 2) : 'n/a',
      };
    }),
  );
  console.log(`\n${resultSetBench.name}`);
  console.table(
    resultSetBench.tasks.map((task) => {
      const entry = caseByName.get(task.name);
      const rows = entry ? entry.rows.length : 0;
      const result = resultWithStatistics(task.result);
      const latency = result?.latency;
      return {
        query: task.name,
        rows,
        cols: entry ? columnCount(entry.rows) : 0,
        'µs/response': latency ? format(latency.mean * 1e3, 1) : 'n/a',
        'ns/row': latency && rows ? format((latency.mean * 1e6) / rows, 0) : 'n/a',
        'responses/sec': result ? format(result.throughput.mean, 0) : 'n/a',
        'rme %': latency ? format(latency.rme, 2) : 'n/a',
      };
    }),
  );
  console.log(`\n${mixBench.name}`);
  console.table(
    mixBench.tasks.map((task) => {
      const latency = resultWithStatistics(task.result)?.latency;
      return {
        workload: task.name,
        'ms/batch': latency ? format(latency.mean, 2) : 'n/a',
        'rows/sec': latency ? format(mixRows / (latency.mean / 1e3), 0) : 'n/a',
        'responses/sec': latency
          ? format(benchmarkWorkload.length / (latency.mean / 1e3), 0)
          : 'n/a',
        'rme %': latency ? format(latency.rme, 2) : 'n/a',
      };
    }),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
