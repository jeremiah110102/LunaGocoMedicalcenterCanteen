import { vi } from 'vitest';
vi.mock('../../src/firebase/index.js', () => ({
  auth: { currentUser: { uid: 'DEV', email: 'dev@x', getIdToken: async () => '' } },
  homeDb: { type: 'firestore-placeholder' },
  isConfigured: false,
  googleProvider: {},
  app: {},
}));
// Runs the real google-apps-script/Database.gs in Node with an in-memory Google Sheet.
import { beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import vm from 'node:vm';
import fs from 'node:fs';
import crypto from 'node:crypto';
import * as D from '../../src/db/docs.js';
import { contract, counter, token } from './contract.js';
import { servicesSuite } from './services.js';

class Sheet {
  constructor(name) { this.name = name; this.rows = []; }
  getLastRow() { return this.rows.length; }
  getDataRange() {
    const w = Math.max(0, ...this.rows.map((r) => r.length));
    return { getValues: () => this.rows.map((r) => Array.from({ length: w }, (_, i) => (r[i] === undefined ? '' : r[i]))) };
  }
  getRange(row, col, nr, nc) {
    return {
      setValues: (vals) => {
        if (vals.length !== nr || vals.some((v) => v.length !== nc)) throw new Error('setValues size mismatch');
        for (let i = 0; i < nr; i++) {
          const r = this.rows[row - 1 + i] || (this.rows[row - 1 + i] = []);
          for (let j = 0; j < nc; j++) r[col - 1 + j] = vals[i][j];
        }
      },
    };
  }
  deleteRow(r) { this.rows.splice(r - 1, 1); }
  setFrozenRows() {}
  hideColumns() {}
}
function makeContext(book) {
const cache = new Map();
return vm.createContext({
  SpreadsheetApp: { getActiveSpreadsheet: () => ({
    getName: () => 'Canteen DB',
    getSheetByName: (n) => book.sheets.get(n) || null,
    insertSheet: (n) => { const s = new Sheet(n); book.sheets.set(n, s); return s; },
  }) },
  UrlFetchApp: { fetch: (url, opts) => {
    const idToken = JSON.parse(opts.payload).idToken;
    let claims = {};
    try { claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString()); } catch {}
    const ok = claims.iss === 'https://securetoken.google.com/canteen-test' && url.includes('key=test-key');
    return { getResponseCode: () => (ok ? 200 : 400), getContentText: () => JSON.stringify(ok ? { users: [{ localId: claims.sub }] } : { error: { message: 'INVALID_ID_TOKEN' } }) };
  } },
  CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' },
    computeDigest: (_a, s) => [...crypto.createHash('sha256').update(s).digest()],
    base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64url'),
  },
});
}
export const book = { sheets: new Map() };
const book2 = { sheets: new Map() };
const context = makeContext(book);
const context2 = makeContext(book2);
const context3 = makeContext({ sheets: new Map() });
const code = fs.readFileSync(new URL('../../google-apps-script/Database.gs', import.meta.url), 'utf8').replace("'PASTE-your-Firebase-apiKey-here'", "'test-key'");
vm.runInContext(code, context);
vm.runInContext(code, context2);
vm.runInContext(code, context3);

let server;
let base;
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    counter.requests++;
    let body = '';
    for await (const c of req) body += c;
    const out = (req.url.startsWith('/svc') ? context2 : req.url.startsWith('/copy') ? context3 : context).doPost({ postData: { contents: body } });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(out.s);
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server.close());

contract('Google Sheets', (uid) => D.createDocsDb({ kind: 'sheets', url: base, getToken: async () => (uid ? token(uid) : null) }));

import { it, expect } from 'vitest';
it('stores readable columns and never lets data run as a formula', () => {
  const products = book.sheets.get('products');
  const [header, row] = products.rows;
  expect(header.slice(0, 3)).toEqual(['_id', '_v', '_json']);
  expect(header).toContain('name');
  expect(JSON.parse(row[2]).name).toBe('Coke');
  const ctx = {};
  vm.runInContext("var __cell = cellOf('=IMPORTXML(1)')", context);
  expect(context.__cell).toBe("'=IMPORTXML(1)");
});

const mk = (uid, slot) => D.createDocsDb({ kind: 'sheets', url: slot ? `${base}/${slot}` : base, getToken: async () => (uid ? token(uid) : null) });
servicesSuite('Google Sheets', mk, token);
