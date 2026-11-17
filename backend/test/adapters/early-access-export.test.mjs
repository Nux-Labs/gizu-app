import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csvCell, exportSignups } from '../../scripts/export-early-access.mjs';

test('CSV escapes quotes and prevents spreadsheet formula execution', () => {
  assert.equal(csvCell('a"b,c@example.com'), '"a""b,c@example.com"');
  assert.equal(csvCell('=1+1@example.com'), '"\'=1+1@example.com"');
  assert.equal(csvCell('  +123@example.com'), '"\'  +123@example.com"');
  assert.equal(csvCell(null), '""');
});

test('export uses a read-only snapshot and bounded batches', async () => {
  const queries = [];
  let fetched = false;
  const client = { async query(sql) {
    queries.push(sql);
    if (sql.startsWith('FETCH') && !fetched) {
      fetched = true;
      return { rows: [{ email: 'test@example.com', created_at: new Date('2026-11-17T00:00:00Z'), platform: 'ios', consent: 'true' }] };
    }
    return { rows: [] };
  } };
  let csv = '';
  assert.equal(await exportSignups(client, { async writeFile(chunk) { csv += chunk; } }), 1);
  assert.match(queries[0], /READ ONLY/);
  assert.equal(queries.at(-1), 'COMMIT');
  assert.match(csv, /"test@example.com","2026-11-17T00:00:00.000Z","ios","","true"/);
});

test('failed export rolls back instead of committing a partial snapshot', async () => {
  const queries = [];
  await assert.rejects(exportSignups({ async query(sql) { queries.push(sql); return { rows: [] }; } }, {
    async writeFile() { throw new Error('disk full'); },
  }), /disk full/);
  assert.equal(queries.at(-1), 'ROLLBACK');
});
