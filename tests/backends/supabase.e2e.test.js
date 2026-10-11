import { vi } from 'vitest';
vi.mock('../../src/firebase/index.js', () => ({
  auth: { currentUser: { uid: 'DEV', email: 'dev@x', getIdToken: async () => '' } },
  homeDb: { type: 'firestore-placeholder' },
  isConfigured: false,
  googleProvider: {},
  app: {},
}));
import { beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import pg from 'pg';
import * as D from '../../src/db/docs.js';
import { contract, counter } from './contract.js';

// Needs: npm i -D pg, a Postgres 15+ with roles anon/authenticated, and schema.sql loaded into
// databases postgres, target and copydb. Then: PG_TEST_HOST=/path/to/socket-or-host PG_TEST_PORT=5432 npm test
const PGHOST = process.env.PG_TEST_HOST;
const pool = new pg.Pool({ host: PGHOST, port: Number(process.env.PG_TEST_PORT || 5432), user: 'postgres', database: 'postgres', max: 8 });
const pool2 = new pg.Pool({ host: PGHOST, port: Number(process.env.PG_TEST_PORT || 5432), user: 'postgres', database: 'target', max: 8 });
let base2;
const pool3 = new pg.Pool({ host: PGHOST, port: Number(process.env.PG_TEST_PORT || 5432), user: 'postgres', database: 'copydb', max: 8 });
let server;
let base;

beforeAll(async () => {
  await pool.query('truncate pos.docs');
  await pool2.query('truncate pos.docs');
  await pool3.query('truncate pos.docs');
  server = http.createServer(async (req, res) => {
    counter.requests++;
    let body = '';
    for await (const c of req) body += c;
    const auth = req.headers.authorization || '';
    const claims = auth.startsWith('Bearer ') ? Buffer.from(auth.slice(7).split('.')[1], 'base64url').toString() : '';
    const client = await (req.url.startsWith('/svc/') ? pool2 : req.url.startsWith('/copy/') ? pool3 : pool).connect();
    try {
      await client.query('begin');
      await client.query('set local role anon');
      await client.query("select set_config('request.jwt.claims', $1, true)", [claims]);
      const r = await client.query('select public.pos_request($1::jsonb) as r', [JSON.parse(body).body]);
      await client.query('commit');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.rows[0].r));
    } catch (e) {
      await client.query('rollback');
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: e.message }));
    } finally {
      client.release();
    }
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  base2 = `${base}/t2`;
});
afterAll(async () => {
  server.close();
  await pool.end();
  await pool2.end();
  await pool3.end();
});

import { token } from './contract.js';
import { servicesSuite } from './services.js';
contract('Supabase', (uid) => D.createDocsDb({ kind: 'supabase', url: base, key: 'sb_publishable_test', getToken: async () => (uid ? token(uid) : null) }));

const mk = (uid, slot) => D.createDocsDb({ kind: 'supabase', url: slot ? `${base}/${slot}` : base, key: 'sb_publishable_test', getToken: async () => (uid ? token(uid) : null) });
servicesSuite('Supabase', mk, token);
