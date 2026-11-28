import { open, unlink } from 'node:fs/promises';
import pg from 'pg';
import { csvCell } from '../src/http/csv.ts';

export { csvCell };

export async function exportSignups(client, output) {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query(`DECLARE signups NO SCROLL CURSOR FOR
      SELECT email, created_at, preferences->>'platform' AS platform,
        preferences->>'source' AS source, preferences->>'consent' AS consent,
        preferences->>'consentVersion' AS consent_version,
        preferences->>'consentRecordedAt' AS consent_recorded_at
      FROM early_access_signups ORDER BY created_at, email`);
    const columns = ['email', 'created_at', 'platform', 'source', 'consent', 'consent_version', 'consent_recorded_at'];
    await output.writeFile(columns.join(',') + '\r\n');
    let count = 0;
    for (;;) {
      const { rows } = await client.query('FETCH FORWARD 1000 FROM signups');
      if (!rows.length) break;
      await output.writeFile(rows.map(row => columns.map(key => csvCell(
        row[key] instanceof Date ? row[key].toISOString() : row[key],
      )).join(',')).join('\r\n') + '\r\n');
      count += rows.length;
    }
    await client.query('COMMIT');
    return count;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const path = process.argv[2];
  if (!path || !process.env.DATABASE_URL) {
    console.error('Usage: DATABASE_URL=<operator connection> npm run signups:export -- /private/path/signups.csv');
    process.exitCode = 1;
    return;
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 30000 });
  let file;
  let client;
  try {
    client = await pool.connect();
    file = await open(path, 'wx', 0o600);
    const count = await exportSignups(client, file);
    console.error(`Exported ${count} signups.`);
  } catch {
    if (file) await unlink(path).catch(() => {});
    console.error('Export failed. Check database access, table availability and a new writable output path.');
    process.exitCode = 1;
  } finally {
    await file?.close();
    client?.release();
    await pool.end();
  }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) await main();
