/**
 * ==========================================================
 * Campus Canteen POS — GOOGLE SHEETS COPY (for reports / accounting)
 * ==========================================================
 * A read-only copy of the canteen's data in a Google Sheet: one tab per list
 * (Sales, Products, Deliveries…), replaced on every sync. Works whichever
 * database the canteen uses. This is NOT the Google Sheets database
 * (that is Database.gs); use a separate Google Sheet for this.
 *
 * SETUP (3 minutes)
 *  1. Create a new Google Sheet → Extensions → Apps Script → paste this file.
 *  2. Change SYNC_KEY below to a long random password. Save.
 *  3. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → Deploy.
 *  4. In the app: Settings → Google Sheets copy → paste the Web app URL and the same key → Test → Save.
 * After editing: Deploy → Manage deployments → Edit → Version: New version → Deploy.
 */

const SYNC_KEY = 'CHANGE-ME-to-a-long-random-password';

function doGet() {
  return out({ ok: true, app: 'campus-canteen-pos-copy', message: 'Google Sheets copy is running.' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return out({ ok: false, error: 'Bad request.' });
  }
  if (/^CHANGE-ME/.test(SYNC_KEY)) return out({ ok: false, error: 'Set SYNC_KEY at the top of SheetsCopy.gs, save, and deploy a new version.' });
  if (body.key !== SYNC_KEY) return out({ ok: false, error: 'Wrong sync key.' });
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (body.action === 'test') return out({ ok: true, app: 'campus-canteen-pos-copy', name: ss.getName(), url: ss.getUrl() });
  if (body.action !== 'sync') return out({ ok: false, error: 'Unknown action.' });

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const counts = {};
    (body.tables || []).forEach(function (t) {
      let sheet = ss.getSheetByName(t.name);
      if (!sheet) sheet = ss.insertSheet(t.name);
      sheet.clearContents();
      const width = Math.max(1, t.headers.length);
      sheet.getRange(1, 1, 1, width).setValues([t.headers]).setFontWeight('bold');
      if (t.rows.length) sheet.getRange(2, 1, t.rows.length, width).setValues(t.rows);
      sheet.setFrozenRows(1);
      counts[t.name] = t.rows.length;
    });
    let about = ss.getSheetByName('About');
    if (!about) about = ss.insertSheet('About', 0);
    about.clearContents();
    about.getRange(1, 1, 4, 2).setValues([
      ['Canteen', body.canteen || ''],
      ['Last synced', body.syncedAt || new Date().toString()],
      ['Synced by', body.syncedBy || ''],
      ['Note', 'Read-only copy. Changes made here are overwritten on the next sync.'],
    ]);
    return out({ ok: true, counts: counts, url: ss.getUrl() });
  } finally {
    lock.releaseLock();
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
