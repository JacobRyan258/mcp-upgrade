#!/usr/bin/env node
/**
 * Migration CLI. `npm run db:migrate`, `db:reset`, or `--workspace
 * @mcp-upgrade/database status`.
 */
import { closePool, getPool } from './pool.js';
import { migrate, reset, status } from './migrate.js';

async function main(): Promise<number> {
  const command = process.argv[2] ?? 'migrate';
  const pool = getPool();
  try {
    switch (command) {
      case 'migrate': {
        const result = await migrate({ pool });
        for (const name of result.applied) console.log(`applied  ${name}`);
        for (const name of result.skipped) console.log(`current  ${name}`);
        console.log(
          `\n${result.applied.length} applied, ${result.skipped.length} already current.`,
        );
        return 0;
      }
      case 'reset': {
        const result = await reset({ pool });
        console.log(`reset complete: ${result.applied.length} migrations applied.`);
        return 0;
      }
      case 'status': {
        const rows = await status({ pool });
        for (const row of rows) {
          const state = row.drifted ? 'DRIFTED' : row.applied ? 'applied' : 'pending';
          console.log(`${state.padEnd(8)} ${row.name}`);
        }
        return rows.some((row) => row.drifted) ? 1 : 0;
      }
      default:
        console.error(`Unknown command: ${command}. Use migrate, reset or status.`);
        return 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Migration failed.');
    return 1;
  } finally {
    await closePool();
  }
}

process.exitCode = await main();
