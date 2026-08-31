import type { SqlAggregateDescriptor } from '@internal/sql-relational-core/aggregate-descriptor-registry';
import { buildSqlAggregateDescriptorRegistry } from '@internal/sql-relational-core/aggregate-descriptor-registry';
import { AggregateExpr, FunctionCallExpr } from '@internal/sql-relational-core/ast';
import type { ExecutionContext } from '@internal/sql-relational-core/query-lane-context';
import { describe, expect, it } from 'vitest';
import { Collection, reservedCollectionMemberNames } from '../src/collection';
import { orm } from '../src/orm';
import { createMockRuntime, getTestContext, type TestContract } from './helpers';

const countAny: SqlAggregateDescriptor = {
  operation: 'count',
  input: { kind: 'any' },
  output: { kind: 'codec', codecId: 'pg/int8@1' },
  nullable: false,
  emptyResultJson: '0',
};

const medianOverNumeric: SqlAggregateDescriptor = {
  operation: 'median',
  input: { kind: 'trait', trait: 'numeric' },
  output: { kind: 'codec', codecId: 'pg/float8@1' },
  nullable: true,
  lower: ({ expr }) => FunctionCallExpr.of('median', expr === undefined ? [] : [expr]),
};

const headcountAny: SqlAggregateDescriptor = {
  operation: 'headcount',
  input: { kind: 'any' },
  output: { kind: 'codec', codecId: 'pg/int8number@1' },
  nullable: false,
  emptyResultJson: 0,
  lower: ({ expr }) => new AggregateExpr('count', expr),
};

function contextWith(descriptors: readonly unknown[]): ExecutionContext<TestContract> {
  const base = getTestContext();
  return {
    ...base,
    aggregateDescriptors: buildSqlAggregateDescriptorRegistry(descriptors, base.codecDescriptors),
  };
}

type Reducers = Record<string, ((field?: string) => unknown) | undefined>;

function ormPosts(context: ExecutionContext<TestContract>): object {
  const client = orm({ runtime: createMockRuntime(), context }) as unknown as Record<
    string,
    Record<string, object>
  >;
  return client['public']!['Post']!;
}

describe('aggregate reducer installation', () => {
  it('exposes every contributed operation on an orm()-built collection', () => {
    const posts = ormPosts(contextWith([countAny, medianOverNumeric])) as Reducers;

    expect(typeof posts['count']).toBe('function');
    expect(typeof posts['median']).toBe('function');
  });

  it('carries reducers on the prototype chain, not as own properties', () => {
    const posts = ormPosts(contextWith([countAny, medianOverNumeric]));

    expect(Object.getOwnPropertyNames(posts)).not.toContain('median');
    expect('median' in posts).toBe(true);
  });

  it('keeps reducers across every chained clone', () => {
    const posts = ormPosts(contextWith([countAny, medianOverNumeric])) as Reducers & {
      where(arg: object): object;
      limit(n: number): object;
    };

    const chained = (posts.where({ views: 1 }) as { limit(n: number): object }).limit(
      5,
    ) as Reducers;

    expect(typeof chained['median']).toBe('function');
    expect(typeof chained['count']).toBe('function');
  });

  it('binds the reducer to the receiving clone, not the collection it was installed from', () => {
    const posts = ormPosts(contextWith([countAny, medianOverNumeric])) as {
      include(name: string, refine: (rel: Reducers) => unknown): unknown;
    };

    const refined = posts.include('comments', (rel) => rel['count']?.());

    expect(refined).toBeDefined();
  });

  it('does not leak one registry’s operations into another', () => {
    const withMedian = ormPosts(contextWith([countAny, medianOverNumeric])) as Reducers;
    const withHeadcount = ormPosts(contextWith([countAny, headcountAny])) as Reducers;

    expect(typeof withMedian['median']).toBe('function');
    expect(withMedian['headcount']).toBeUndefined();
    expect(typeof withHeadcount['headcount']).toBe('function');
    expect(withHeadcount['median']).toBeUndefined();
  });

  it('leaves the reserved member set unchanged', () => {
    const before = reservedCollectionMemberNames();
    ormPosts(contextWith([countAny, medianOverNumeric]));
    const after = reservedCollectionMemberNames();

    expect([...after].sort()).toEqual([...before].sort());
    expect(after).not.toContain('median');
  });

  it('still installs reducers on a directly constructed collection', () => {
    const context = contextWith([countAny, medianOverNumeric]);
    const posts = new Collection({ runtime: createMockRuntime(), context }, 'Post', {
      namespaceId: 'public',
      includeRefinementMode: true,
    }) as unknown as Reducers;

    expect(typeof posts['median']).toBe('function');
    expect(posts['median']?.('views')).toEqual(
      expect.objectContaining({ kind: 'includeScalar', fn: 'median', column: 'views' }),
    );
  });

  it('lets a custom collection member keep its name over a same-named operation', () => {
    class PostsWithMedian extends Collection<TestContract, 'Post'> {
      median(): string {
        return 'custom member';
      }
    }

    const context = contextWith([countAny, medianOverNumeric]);
    const client = orm({
      runtime: createMockRuntime(),
      context,
      collections: { Post: PostsWithMedian },
    }) as unknown as Record<string, Record<string, { median(): string }>>;

    expect(client['public']!['Post']!.median()).toBe('custom member');
  });
});
