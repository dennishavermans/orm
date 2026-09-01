var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, 'name', { value, configurable: true });

import 'temporal-polyfill/global';
import postgres from '@internal/postgres/runtime';
import { buildDecodeContext, decodeRow } from '@internal/sql-runtime/test/utils';
import { Bench } from 'tinybench';
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
const db = postgres({ contractJson, url: 'postgres://bench@127.0.0.1:5432/bench' });
const plans = benchmarkPlans(db.sql);
const fixtures = rowsJson;
const rowCtx = {};
const cases = Object.entries(plans).map(([name, plan]) => {
  const rows = fixtures[name];
  if (!rows) {
    throw new Error(`No fixture rows for query "${name}"`);
  }
  return { name, rows, decodeCtx: buildDecodeContext(plan.ast, db.context.contractCodecs) };
});
const caseByName = new Map(cases.map((entry) => [entry.name, entry]));
const mixTotal = Object.values(REQUEST_MIX).reduce((sum, weight) => sum + weight, 0);
const mixedWorkload = Object.entries(REQUEST_MIX).flatMap(([name, weight]) => {
  const entry = caseByName.get(name);
  if (!entry) {
    throw new Error(`Request mix names unknown query "${name}"`);
  }
  return Array.from({ length: Math.round((weight / mixTotal) * MIX_RESPONSES) }, () => entry);
});
async function decodeResultSet(rows, decodeCtx) {
  const decoded = [];
  for (const row of rows) {
    decoded.push(await decodeRow(row, decodeCtx, rowCtx));
  }
  return decoded;
}
__name(decodeResultSet, 'decodeResultSet');
function columnCount(rows) {
  return Object.keys(rows[0] ?? {}).length;
}
__name(columnCount, 'columnCount');
function format(value, digits) {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
__name(format, 'format');
async function verifyFixtures() {
  for (const entry of cases) {
    const decoded = await decodeResultSet(entry.rows, entry.decodeCtx);
    const first = decoded[0];
    if (first === void 0) {
      throw new Error(`Query "${entry.name}" decoded no rows`);
    }
    if (Object.keys(first).length !== columnCount(entry.rows)) {
      throw new Error(`Query "${entry.name}" decoded a row of unexpected width`);
    }
  }
}
__name(verifyFixtures, 'verifyFixtures');
async function main() {
  await verifyFixtures();
  const rowBench = new Bench({ name: 'decodeRow \u2014 single row', time: 700, warmupTime: 200 });
  for (const entry of cases) {
    const row = entry.rows[0];
    if (!row) continue;
    rowBench.add(entry.name, async () => {
      await decodeRow(row, entry.decodeCtx, rowCtx);
    });
  }
  const resultSetBench = new Bench({
    name: 'decodeRow \u2014 whole result set',
    time: 700,
    warmupTime: 200,
  });
  for (const entry of cases) {
    resultSetBench.add(entry.name, async () => {
      await decodeResultSet(entry.rows, entry.decodeCtx);
    });
  }
  const mixRows = mixedWorkload.reduce((sum, entry) => sum + entry.rows.length, 0);
  const mixBench = new Bench({ name: 'decodeRow \u2014 northwind request mix', time: 1500 });
  mixBench.add(`${mixedWorkload.length} responses / ${mixRows} rows`, async () => {
    for (const entry of mixedWorkload) {
      await decodeResultSet(entry.rows, entry.decodeCtx);
    }
  });
  await rowBench.run();
  await resultSetBench.run();
  await mixBench.run();
  console.log(`
${rowBench.name}`);
  console.table(
    rowBench.tasks.map((task) => {
      const entry = caseByName.get(task.name);
      const latency = task.result?.latency;
      return {
        query: task.name,
        cols: entry ? columnCount(entry.rows) : 0,
        'ns/row': latency ? format(latency.mean * 1e6, 0) : 'n/a',
        'rows/sec': task.result ? format(task.result.throughput.mean, 0) : 'n/a',
        'rme %': latency ? format(latency.rme, 2) : 'n/a',
      };
    }),
  );
  console.log(`
${resultSetBench.name}`);
  console.table(
    resultSetBench.tasks.map((task) => {
      const entry = caseByName.get(task.name);
      const rows = entry ? entry.rows.length : 0;
      const latency = task.result?.latency;
      return {
        query: task.name,
        rows,
        cols: entry ? columnCount(entry.rows) : 0,
        '\xB5s/response': latency ? format(latency.mean * 1e3, 1) : 'n/a',
        'ns/row': latency && rows ? format((latency.mean * 1e6) / rows, 0) : 'n/a',
        'responses/sec': task.result ? format(task.result.throughput.mean, 0) : 'n/a',
        'rme %': latency ? format(latency.rme, 2) : 'n/a',
      };
    }),
  );
  console.log(`
${mixBench.name}`);
  console.table(
    mixBench.tasks.map((task) => {
      const latency = task.result?.latency;
      return {
        workload: task.name,
        'ms/batch': latency ? format(latency.mean, 2) : 'n/a',
        'rows/sec': latency ? format(mixRows / (latency.mean / 1e3), 0) : 'n/a',
        'responses/sec': latency ? format(mixedWorkload.length / (latency.mean / 1e3), 0) : 'n/a',
        'rme %': latency ? format(latency.rme, 2) : 'n/a',
      };
    }),
  );
}
__name(main, 'main');
await main();
