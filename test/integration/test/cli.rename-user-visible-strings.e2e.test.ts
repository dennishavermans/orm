import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ormCommandFamily } from '@internal/cli';
import { createTestCli } from '@prisma/cli-engine/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createIntegrationTestDir, ormEngineMount } from './utils/cli-test-helpers';

interface InitDocument {
  readonly filesWritten: readonly string[];
}

describe('user-visible strings after the Prisma 8 rename (orm/#30062)', () => {
  function harness() {
    const { commands, groups } = ormEngineMount();
    return createTestCli({ commandFamilies: [ormCommandFamily], commands, groups });
  }

  it('orm init --help does not say Prisma Next', async () => {
    const run = await harness().run(['orm', 'init', '--help']);

    expect(run.stdout + run.stderr).not.toContain('Prisma Next');
  });

  it('lsp --help does not say Prisma Next', async () => {
    const run = await harness().run(['lsp', '--help']);

    expect(run.stdout + run.stderr).not.toContain('Prisma Next');
  });

  describe('orm init scaffold', () => {
    let testDir: string;

    afterEach(() => {
      if (testDir !== undefined && existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('writes a quick-reference file that does not say Prisma Next', async () => {
      testDir = createIntegrationTestDir();

      const run = await harness().run(
        ['orm', 'init', '--target', 'postgres', '--authoring', 'psl', '--skip-install'],
        { cwd: testDir },
      );

      expect(run.exitCode, run.stderr).toBe(0);
      const quickReferencePath = join(testDir, 'prisma-next.md');
      expect(existsSync(quickReferencePath)).toBe(true);
      const quickReference = readFileSync(quickReferencePath, 'utf-8');
      expect(quickReference).not.toContain('Prisma Next');
    });

    it('writes every scaffolded file and next step without Prisma Next', async () => {
      testDir = createIntegrationTestDir();
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src/index.ts'), 'export {}\n', 'utf-8');

      const run = await harness().run(
        ['orm', 'init', '--target', 'postgres', '--authoring', 'psl', '--skip-install'],
        { cwd: testDir },
      );

      expect(run.exitCode, run.stderr).toBe(0);
      const document = run.presented?.data as InitDocument | undefined;
      expect(document?.filesWritten).toContain('prisma-next.md');
      expect(document?.filesWritten).toContain('README.md');

      for (const relPath of document?.filesWritten ?? []) {
        const content = readFileSync(join(testDir, relPath), 'utf-8');
        expect(content, relPath).not.toContain('Prisma Next');
      }

      expect(JSON.stringify(run.presented)).not.toContain('Prisma Next');
      expect(run.presented?.presentation.json).toBeDefined();
    });
  });
});
