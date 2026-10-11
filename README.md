# Campus Canteen POS

Point of sale, inventory, and student/staff credit system for a school canteen.
**React + Vite (.jsx)** frontend. Login always uses **Firebase Authentication**. Data is stored in your choice of **Firebase Firestore** (default), **Supabase**, or **Google Sheets**, and you can switch in **Settings**.

---

## 1. Set up Firebase (one time)

1. Go to <https://console.firebase.google.com> and **create a project**.
2. **Authentication → Sign-in method** and enable:
   - **Email/Password**
   - **Google**
3. **Firestore Database → Create database**. Production mode is fine, because the rules below control access.
4. **Project settings → General → Your apps → Add app → Web (</>)**. Copy the `firebaseConfig` object.
5. Open **`src/firebase/config.js`** and paste your values over the `YOUR_...` placeholders.

## 2. Run it

```bash
npm install
npm run dev        # opens http://localhost:5173
```

## 3. Deploy the security rules (required)

Without these rules, Firestore blocks every read and write.

```bash
npm install -g firebase-tools
firebase login
firebase use --add          # pick your project
firebase deploy --only firestore:rules
```

## 4. First run: you become the admin automatically

1. Open the app and create an account (email or Google). **The very first account is automatically the owner/admin.**
2. You're asked for **your name and a 4–6 digit PIN**. This creates your admin staff profile.
3. The app opens. From now on, the counter shows a **"Who's working?"** screen: tap your name and enter your PIN.

## 5. Add your staff

Go to **Users & roles → Add staff**. Enter each person's **name**, **role** (admin, manager, cashier, or inventory), and a **PIN**. Give them the PIN privately.

- Staff unlock the counter by tapping their name and typing their PIN. Sales and stock changes are recorded under their name.
- Everyone can change their own PIN with **Change my PIN** in the sidebar.
- The admin can **reset** anyone's PIN, change roles, or disable a staff member (via **Edit / reset PIN** and **Disable**).
- **Lock / switch user** hands the counter to someone else. The counter also locks itself after 10 idle minutes (change `autoLockMinutes` in `src/config/app.js`).
- After 5 wrong PINs, that person is locked out for 60 seconds on that device.

**More counters or tablets:** sign the new device in with another email/Google account. It shows "Waiting for approval" until you approve it under **Users & roles → Sign-in accounts**. You must be on a device signed in with the owner account to approve it.

## 6. First-day setup inside the app

1. **Products → Categories**: add categories, e.g. Rice meals, Snacks, Drinks.
2. **Ingredients**: add raw materials with their unit, cost, and opening stock.
3. **Products**: add menu items. For cooked meals, add a **recipe**; for bottled drinks or packed snacks, tick **Track stock**.
4. **Credit accounts**: add students and staff who are allowed to buy on credit, with a limit for each.
5. Edit **`src/config/app.js`** to set the canteen name, address, and receipt footer.

## 7. Publish (optional)

```bash
npm run build
firebase deploy --only hosting
```

If you host on another domain, add that domain under **Authentication → Settings → Authorized domains**, or Google sign-in will fail.

## 8. Use Supabase or Google Sheets instead (optional)

Firestore is used until you change it. Every device picks up the choice automatically, because it's stored in Firestore at `settings/connection`. That's why you still need step 3 (deploy the rules) even when your data lives elsewhere.

**Supabase** (recommended alternative; also enables **product photos**)
1. Create a project at <https://supabase.com> (the free plan is fine).
2. **SQL Editor → New query →** paste all of `supabase/schema.sql` **→ Run.** You can safely run it again after updates.
3. **Authentication → Sign In / Providers → Third-party Auth → Add provider → Firebase**, then enter your Firebase **Project ID**.
4. **Project Settings → API Keys**: copy the **Project URL** and the **publishable key** (`sb_publishable_…`) or the legacy *anon public* key. **Never** use the secret/service_role key.

**Google Sheets** (simplest; slower, best for a small canteen)
1. Create a Google Sheet → **Extensions → Apps Script**, then paste all of `google-apps-script/Database.gs`.
2. Put your Firebase **Web API key** in `FIREBASE_API_KEY` at the top. Save.
3. Choose **authorize** in the toolbar → **Run** → allow the permissions.
4. **Deploy → New deployment → Web app**: *Execute as: Me*, *Who has access: Anyone*. Copy the URL ending in `/exec`.

**Switch:** sign in with the **owner account** and unlock with an admin PIN. Then go to **Settings → Change database**: pick the database, paste the details, and click **Test connection**. Choose what data to bring:
- **Copy everything from the current database** (recommended), or
- **Load an Excel backup file** (made under Backup & restore), or
- **Start empty**.

Click **Switch**. Your owner account and staff PINs come along, and every device moves over on its next reload.

---

## Features

| Area | What's included |
|---|---|
| **Login & staff** | First account becomes admin automatically; device sign-in with email/password or Google; staff profiles with name, role and PIN; PIN lock screen; change own PIN; admin PIN reset; auto-lock when idle; wrong-PIN lockout; approve extra devices |
| **Cashier (POS)** | Product tiles with search and category filters, live "N left" counts, cart quantity controls, % or ₱ discounts, cash with quick-amount buttons and change, GCash with reference no., credit purchases with limit check, printable receipt, mark sold out from the counter |
| **Sales history** | Filter by date, payment method, or receipt/cashier/account; reprint any receipt |
| **Products** | Add/edit/archive, SKU (unique), category, type (meal/snack/drink), unit, price, cost, low-stock level, sold-out toggle, recipes, category manager |
| **Ingredients** | Units, cost, stock value, "used in" list, archive (blocked while used in a recipe) |
| **Inventory** | Stock levels, low-stock list, receive stock, adjustments (reason required), waste (spoiled/expired/wasted), full movement history |
| **Purchase orders** | Suppliers list; POs with items, quantities, unit costs, expected date and notes; draft → ordered → partly received → received (or cancelled / closed short); a PO can arrive in several deliveries; receiving adds stock, records movements and can update item costs; "Order all low items"; **Order** buttons on products/ingredients; option to create a PO right after adding a product |
| **Received deliveries** | Every delivery gets its own record (DR-000001) with date, supplier, PO, supplier DR/invoice no., items, costs, notes and who received it; filter by date and supplier; printable receiving slip with signature lines; record deliveries that came without a PO; delivery totals in Reports → Inventory |
| **Product photos** | Optional photo per product, shown on cashier tiles and the product list. Resized in the browser and stored in Supabase Storage, so only available when the database is Supabase |
| **Database choice** | Settings page: Firebase Firestore, Supabase or Google Sheets; connection test; copy all data or load an Excel backup when switching |
| **Recipes** | Selling a meal automatically deducts its ingredients; checkout is blocked when there isn't enough |
| **Credit** | Balances by student/staff, limits, enable/disable, purchase + repayment history, repayments (cash/GCash), check that balance matches history, printable outstanding-balance list |
| **Dashboard** | Today's sales, transaction count, average sale, best sellers, payment mix, low stock, recent sales, credit outstanding |
| **Reports** | Any date range: daily trend, best sellers, by payment method, by cashier, discounts, gross profit; inventory consumption vs waste, stock levels, movements; outstanding credit |
| **Backup & restore** | Excel `.xlsx` export of every collection; restore with file validation, preview (new vs replaced), forced safety backup, typed confirmation, progress bar, audit entries |
| **Audit log** | Price changes, product/category edits, stock changes, credit changes, repayments, role changes, backups, restores |

### Added in this version

| Area | What's included |
|---|---|
| **Refunds & voids** | From **Sales history → Refund / void**. Refund some items or the whole sale; needs a manager or admin **PIN**; the discount is shared fairly; option to put items back into stock; credit sales lower the balance (any part already repaid goes back in cash); RF- numbers; reports show net sales |
| **Shifts & cash drawer** | Cashiers open a shift with starting cash (required before selling — `requireShift` in `src/config/app.js`); cash in / out during the shift; **blind count** by bills and coins at closing; expected vs counted with over/short; printable **X report** (mid-shift) and **Z report** (closing) |
| **Stock counts** | **Inventory → Stock counts**: start a count, enter what's on the shelf, save progress, post. Differences are applied to current stock (sales during the count are kept), valued, and logged |
| **Expiry dates** | Optional expiry date per item when receiving a delivery; **Inventory → Expiring** lists batches by days left; "Used up / discard" records expired waste |
| **Expenses** | Gas, electricity, wages, rent… by category; optionally paid from the cash drawer (counted in the shift); void with reason |
| **Supplier payments** | Payment terms per supplier (COD or N days) → due date on each delivery; **Purchase orders → Payables** shows what's owed and overdue; record payments (oldest due first, or pick deliveries); SP- numbers and history |
| **Add-ons & meal sets** | Add-ons per product ("Extra rice +₱10") with their own ingredient deduction; **Meal set** product type made of other products; prices always checked against the database |
| **Barcodes & ID scanning** | Barcode field on products; a USB/Bluetooth scanner works anywhere on the cashier screen; scanning a student/staff ID selects their credit account; camera scanning on Chrome/Edge (Android, ChromeOS, Windows); printable **ID QR cards** |
| **Receipt printing** | Settings → Receipt printer (per device): 58 or 80 mm, auto-print after each sale, kitchen order slip, larger text. For no print dialog, start Chrome with `--kiosk-printing` |
| **Installable & offline** | Install from the browser (⊕ in the address bar / "Add to Home screen"). If the internet drops, the cashier screen keeps working from the last loaded menu; sales are saved on the device with an OFF- number and sent automatically later. Problems found when sending (stock ran out, price changed, over credit limit) are recorded and flagged **Review** for a manager |
| **Credit statements & payroll** | Statement per account for any period (print, email to the student's guardian or the staff member, copy); guardian details; **Payroll deduction**: download the staff list for HR, then record deductions in one go |
| **Backups & Google Sheets copy** | Settings → Automatic daily backup (downloads when an admin first opens the app each day); Settings → Google Sheets copy (`google-apps-script/SheetsCopy.gs`) keeps a read-only copy for accounting, optionally daily |
| **Profit report** | Reports → Profit: sales − refunds − cost of goods − waste − stock-count differences − expenses = net profit |
| **Dashboard** | "Needs attention": no open shift, offline sales waiting, items expiring within 3 days, overdue supplier payments, sales to review, shifts left open |

### Accounting

| Area | What's included |
|---|---|
| **Accounting page** | Sidebar → **Accounting**. Pick any period (Today, 7 days, This month, Last month, This year, or your own dates) and group by **day or month** |
| **Compact summary** | One printable page with income (sales, discounts, refunds, net sales, cost of goods, gross profit, waste, each expense category, net profit), money in and out by method, receivables, payables and cash drawer over/short |
| **Sales book** | One row per day or month: receipts and receipt number range, discounts, refunds, net sales, cash / GCash / credit sales, credit collected, expenses, supplier payments, with totals |
| **Money in & out** | Real money by method (cash, GCash, bank, check): sales + credit repayments in; refunds, expenses and supplier payments out. Credit sales aren't counted as money until they're repaid |
| **Receivables & payables** | What students and staff owe (and how it changed in the period); what's owed to each supplier, with overdue amounts |
| **Cash drawer** | Each closed shift: expected, counted, over / short, with totals |
| **Journal** | Every sale, refund/void, credit repayment, expense and supplier payment in time order, with reference numbers |
| **Export Excel** | One workbook for the accountant: Summary, Daily (or Monthly) sales book, Money in & out, Receivables, Payables, Cash drawer, Journal |
| **Accountant role** | New **Accountant** role under Users & roles: sees Dashboard, Sales history (view only, no refunds), Reports and Accounting; can't sell, change stock, credit or settings |

### Scanning, import, export and stock warnings

| Area | What's included |
|---|---|
| **Scan to add** | Tap **Scan** on the cashier screen to use the phone/tablet/laptop camera; it keeps scanning and **every scan adds the item** to the order. USB/Bluetooth barcode and QR readers work anywhere on the cashier screen with no setup. Scanning a student/staff ID QR picks their credit account. |
| **Works on any device** | Uses the browser's built-in barcode reader when there is one (Chrome on Android, ChromeOS, Mac) and a bundled ZXing engine everywhere else (iPhone/iPad Safari, Firefox, Windows). Reads QR, EAN-13/8, UPC-A/E, Code 128/39/93, ITF, Codabar and Data Matrix. The camera needs the app's **https://** address (Firebase Hosting gives you one). |
| **Scan sounds** | Beep when an item is added, a double tone when it's low or out of stock, a buzz when the code isn't found (and a short vibration on phones). Switch off in Settings → Receipt printer & scanner. |
| **Excel product import** | Products → **Import from Excel** → download the template (headers with notes, examples, drop-downs, your categories, instructions) → fill → choose the file → preview (new / update / problems) → import. Matching SKU, barcode or name updates the existing product; new categories are created; opening stock is recorded. CSV also works. |
| **Inventory report export** | **Export PDF** / **Export Excel** on the Inventory page and Reports → Inventory: summary, stock levels with status and value, low & out of stock, expiring batches, consumption & waste, and every stock movement in the period. |
| **Stock alerts** | When an item reaches its low-stock alert, the cashier gets a warning as it's added. At 0 the item is tagged **Out of stock** (red striped tile) but can still be sold: a warning pop-up asks to confirm, the sale lists what was oversold, and stock goes below zero until the next delivery or stock count corrects it. Items manually marked **Sold out** stay blocked. |

**Updating an existing installation** (also needed before you can add an Accountant)**:** redeploy `firestore.rules`; if you use Supabase run `supabase/schema.sql` again; if you use Google Sheets paste the new `Database.gs` and deploy a new version.

### Who can do what

| Page | Admin | Manager | Cashier | Inventory | Accountant |
|---|:-:|:-:|:-:|:-:|:-:|
| Dashboard | ✓ | ✓ | ✓ | ✓ | ✓ |
| Shifts & cash, Expenses (add) | ✓ | ✓ | ✓ | |  |
| Refunds & voids (always approved with a manager/admin PIN) | ✓ | ✓ | ✓ | |  |
| Cashier (POS), Sales history | ✓ | ✓ | ✓ | | Sales history (view) |
| Products, Ingredients, Inventory (counts, expiry), Purchase orders, Payables | ✓ | ✓ | | ✓ |  |
| Credit accounts (view, repayments) | ✓ | ✓ | ✓ | |  |
| Credit limits, new accounts | ✓ | ✓ | | |  |
| Reports, Accounting | ✓ | ✓ | | | ✓ |
| Users & roles (staff, PINs), Backup & restore, Audit log, Settings | ✓ | | | |  |

Roles belong to the **staff member who unlocked the counter with their PIN**. The app hides pages that role can't use.

---

## How the important parts work

**One data layer (`src/db/`)** gives every page the same Firestore-style functions (`collection`, `doc`, `query`, `getDocs`, `runTransaction`, …).
- With **Firestore**, these calls go to the Firebase SDK.
- With **Supabase or Google Sheets**, they become small requests (`get`, `getMany`, `query`, `commit`) answered by `supabase/schema.sql` or `google-apps-script/Database.gs`. Both check the Firebase sign-in and apply the same rules as `firestore.rules`.
- Every record carries a version number, so transactions work the same way on all three. If two counters change the same record at once, one save is rejected and automatically retried with fresh data.

**Checkout (`src/services/sales.js`)** runs as one transaction. It:
- re-reads every product's **current price** from the database (prices from the browser are ignored)
- rejects archived or sold-out items and bad quantities
- checks product stock and recipe ingredient stock
- validates the payment (enough cash, GCash reference, credit limit)
- deducts stock, writes stock-movement records, updates the credit balance, assigns the next receipt number, and saves the sale

If any check fails, nothing is written. Each checkout attempt has a unique ID, so a double-click or a retry after a dropped connection **cannot record the same sale twice**.

**Sign-in and PINs:** there are two layers.
1. A **sign-in account** (email or Google) unlocks the *device*. The first one is the owner; any others need the owner's approval.
2. A **staff PIN** says *who* is at the counter. PINs are never stored. Only a salted PBKDF2 hash is kept in Firestore.

**Security rules (`firestore.rules`)** only let approved devices touch data. Sales, payments, stock history, and audit entries can't be edited or deleted. Stock and balances can't go negative. Only the owner account can approve devices or restore backups. Nobody can make another owner, and only the first account ever becomes the owner automatically.

**Restore (`src/services/backup.js`)** keeps original document IDs, so links between sales, products, ingredients, and accounts survive. Records in the file replace records with the same ID; other records are left alone. Your own user record is never overwritten, so a restore can't lock you out.

---

## Limits to know about

- **Staff roles are enforced by the app, not the database.** On a shared counter, the database sees the *device* account, not the staff member. Someone who knows browser developer tools could bypass the page limits for their role on an approved device. PINs are 4–6 digits, so anyone with that kind of access could also guess them offline from the stored hashes. For a school canteen, this is the usual trade-off for PIN switching. Making it strict needs per-staff Firebase logins plus Cloud Functions, which require the paid Blaze plan.
- **Offline mode needs the app opened online at least once** on that device (to save the menu, staff and your shift). Refunds, stock counts, purchasing and reports need a connection.
- **Supabase and Google Sheets refresh by polling.** Other counters see changes within about 8 seconds on Supabase and about 20 seconds on Sheets; your own changes appear immediately. Each Google Sheets save takes a second or two.
- **Camera scanning needs https://** (or `localhost` while testing). On an `http://` address, use a USB/Bluetooth scanner instead.
- **Validation runs in the browser, inside a transaction.** The rules block the obvious abuse, such as raising stock, editing sales, or changing roles. But someone who knows how to use browser developer tools *and* has a cashier account could still write a sale with a wrong total. For full server-side validation, move `processSale` into a **Cloud Function** (this needs Firebase's paid Blaze plan). The function can reuse `src/lib/checkout.js` unchanged.
- **Restores are written in batches of 400 records.** A very large restore that fails partway through is partly applied. This is why the app makes you download a safety backup first; restore that file to roll back.
- **Reports load the sales in the selected range into the browser.** That's fine for a canteen (thousands of sales a month). For years of data, add summary documents or a Cloud Function.
- `npm audit` reports issues in `@grpc/grpc-js` and `uuid`. These are Node/server-side code paths that never ship in the browser bundle.

---

## Tests

```bash
npm test
```

The backend tests run the real `Database.gs` against an in-memory Google Sheet, and the same rule and service tests as Supabase: owner setup, permissions, concurrent sales, purchase-order receiving, add-ons and meal sets, refunds and voids, shifts and cash count, stock counts, expiry batches, supplier payments, expenses, offline sales, and copying between databases.

To also test `supabase/schema.sql` against a real Postgres: `npm i -D pg`, create roles `anon` and `authenticated`, load the schema into databases `postgres`, `target` and `copydb`, then run `PG_TEST_HOST=localhost PG_TEST_PORT=5432 npm test`.

126 tests cover checkout math, discounts, cash/GCash/credit validation, credit limits, insufficient product and ingredient stock, archived and sold-out items, invalid quantities, report summaries, PIN rules, hashing and lockout, add-ons and meal sets, refund math, shift cash, stock-count variances, expiry, supplier payment allocation, credit statements, profit and loss, accounting (sales book, money in/out, receivables, payables, cash drawer, journal, Excel export, accountant access), the Sheets copy, product import (template round-trip and CSV), inventory report Excel/PDF, scan de-duplication, backup-file validation (wrong file, missing IDs, bad JSON, bad dates, duplicate IDs, no active admin), and a render check of every page.

## Project structure

```
src/
  firebase/config.js      ← paste your Firebase config here
  config/app.js           ← canteen name, address, receipt footer
  lib/checkout.js         ← pure checkout rules (tested)
  lib/reports.js          ← pure report math (tested)
  lib/accounting.js       ← sales book, money in/out, receivables, payables (tested)
  lib/backupFormat.js     ← pure backup validation (tested)
  lib/roles.js            ← role → page access
  db/                     ← data layer: index.js (one API), docs.js (Supabase/Sheets client),
                            connection.js + switch.js (database choice), storage.js (photos)
  services/               ← transactions: sales, inventory, credit, purchasing, backup
  pages/                  ← one file per screen
  components/             ← layout, receipt, modal, toasts, charts
firestore.rules           ← Firestore security (always deploy this)
supabase/schema.sql       ← Supabase database + rules + photo bucket
google-apps-script/Database.gs ← Google Sheets database + rules
```

## Ideas for next versions

Direct ESC/POS thermal printing over USB · multiple canteen branches · customer-facing order screen · pre-orders from students' phones · loyalty points.
#   L u n a G o c o M e d i c a l c e n t e r C a n t e e n  
 #   L u n a G o c o M e d i c a l c e n t e r C a n t e e n  
 