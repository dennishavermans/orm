#!/usr/bin/env node

/**
 * Copies the user-facing `skills/prisma-orm-*` trees into the packages that
 * ship them, stamping each copy with the package it now belongs to.
 *
 * Usage: node scripts/sync-package-skills.ts [<package-name>...]
 *
 * Run from each shipping package's `prepack`, so the tarball always carries
 * the skill trees that match the code beside it. The copies are build
 * output: they are gitignored, and `files` carries them into the tarball.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stampSkillMetadata } from './set-version-utils.ts';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * The packages the skill ships in: the three targets an application depends
 * on directly. Shipping from the direct dependencies is what lets a consumer's
 * `prisma skills sync` resolve the skill by package name instead of searching
 * `node_modules` for skill files.
 */
export const SKILL_ANCHOR_PACKAGES: ReadonlyMap<string, string> = new Map([
  ['@prisma/orm-postgres', 'packages/9-public/@prisma/orm-postgres'],
  ['@prisma/orm-sqlite', 'packages/9-public/@prisma/orm-sqlite'],
  ['@prisma/orm-mongo', 'packages/9-public/@prisma/orm-mongo'],
]);

export const SKILL_NAMES = ['prisma-orm-core-concepts', 'prisma-orm-migrations'] as const;

export async function syncPackageSkills(packageName: string): Promise<readonly string[]> {
  const packageDir = SKILL_ANCHOR_PACKAGES.get(packageName);
  if (packageDir === undefined) {
    const shipping = [...SKILL_ANCHOR_PACKAGES.keys()].join(', ');
    throw new Error(`${packageName} does not ship the Prisma skills; expected ${shipping}`);
  }

  // Concurrent packs of the same package (tarball tests run in parallel and
  // each pack re-runs this prepack) must never observe a half-copied tree, so
  // the copies are staged in a temporary sibling and swapped in with a rename.
  const skillsDir = path.join(rootDir, packageDir, 'skills');
  const stagingDir = `${skillsDir}.staging-${process.pid}`;
  await fs.rm(stagingDir, { recursive: true, force: true });
  for (const skillName of SKILL_NAMES) {
    const source = path.join(rootDir, 'skills', skillName);
    const staged = path.join(stagingDir, skillName);
    await fs.cp(source, staged, { recursive: true });

    // The source tree names one canonical package; each copy names its own,
    // so a consumer reading the copy sees the package it resolved it from.
    const skillMd = path.join(staged, 'SKILL.md');
    await fs.writeFile(
      skillMd,
      stampSkillMetadata(await fs.readFile(skillMd, 'utf-8'), 'library', packageName),
    );
  }

  // The swap can still collide with a concurrent prepack: their rename can
  // repopulate the path mid-delete (ENOTEMPTY from rm) or land first (rename
  // refuses an existing destination). Every copy carries identical content,
  // so retrying the whole swap converges instead of failing the pack.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rm(skillsDir, { recursive: true, force: true });
      await fs.rename(stagingDir, skillsDir);
      break;
    } catch (error) {
      if (attempt >= 5) {
        await fs.rm(stagingDir, { recursive: true, force: true });
        throw error;
      }
    }
  }

  return SKILL_NAMES.map((skillName) => path.join(skillsDir, skillName));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const requested = process.argv.slice(2);
  const targets = requested.length > 0 ? requested : [...SKILL_ANCHOR_PACKAGES.keys()];
  for (const packageName of targets) {
    for (const destination of await syncPackageSkills(packageName)) {
      console.log(`Copied ${path.relative(rootDir, destination)}`);
    }
  }
}
