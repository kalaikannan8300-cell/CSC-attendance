# CSC Attendance Portal: PostgreSQL and production setup

This application now uses PostgreSQL as the source of truth. The existing React/Vite interface and the optional SQLite demo server remain available; `npm start` and `npm run dev` use PostgreSQL by default. The SQLite database is preserved and can be inspected/imported without deleting it.

## Requirements and environment

- Node.js 22.13 or newer and npm.
- A Neon PostgreSQL database (or a local PostgreSQL instance).
- Copy `.env.example` to `.env` and set `DATABASE_URL`, `ADMIN_USERNAME`, and a unique `ADMIN_PASSWORD` with at least 16 characters. Do not commit `.env`.
- Set Cloudinary credentials to enable admin image uploads.
- Set a Google service-account email and private key to enable spreadsheet sync.

No service credential is required by the frontend. Never create `VITE_*` secrets.

## Initialize and run locally

```powershell
npm ci
npm run db:setup
npm run dev
```

`db:setup` repeatably applies `server/postgres-schema.sql` and creates the initial admin only when that username does not already exist. It never resets the schema or changes an existing password. `npm run dev` starts the PostgreSQL API and Vite; the UI is available at the URL printed by Vite (normally `http://localhost:8443`). The API health check is `http://localhost:3001/api/health`.

To reset the password for the existing admin configured by `ADMIN_USERNAME`, run `npm run admin:password:reset` from the project folder in an interactive terminal. Enter and confirm a password of 16–500 characters at the hidden prompts. The command updates only that account's password hash inside a transaction, and fails if the configured account is missing, inactive, or ambiguous. It does not reset the Neon database password or change any other records. Application startup and `db:setup` do not reset an existing admin password. After success, sign in through the **Admin** section of the app with `ADMIN_USERNAME` and the new password, then log out.

Production-style server (serve the previously built frontend and API on one port):

```powershell
npm run build
npm start
```

The non-production SQLite demo is explicitly available as `npm run dev:sqlite` or `npm run start:sqlite`. It is not the production data store.

## Schema updates and SQLite import

The schema file is safe to run again and includes additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` steps for earlier PostgreSQL installations. The leave calendar schema update adds nullable scope/creator fields and a unique index to the existing calendar table; it does not create a parallel leave table or change historical rows. Back up the database before applying a schema change. Initialization does not drop tables or rows.

The checked-in local `data/attendance.sqlite` was inspected read-only: it contained zero student rows and zero attendance rows, so there is currently no local attendance data to migrate. To import another SQLite file, first back up both databases and set `DATABASE_URL` to the intended PostgreSQL database:

```powershell
npm run db:import:sqlite -- --path "C:\path\to\attendance.sqlite"
```

The importer opens SQLite read-only, preserves register numbers, active state, attendance dates, and entry timestamps, and uses conflict-safe inserts so it can be safely rerun. It verifies imported student and attendance matches and timestamp equality. It does not delete or alter the source file, and it does not overwrite existing PostgreSQL rows. Resolve and investigate any verification failure before switching traffic.

## Neon

1. Create a Neon project and database; use its pooled connection URL for the web service.
2. Put the URL in the private environment variable `DATABASE_URL` (including `sslmode=require` as provided).
3. Run `npm run db:setup` from a trusted workstation or let the application startup run the same idempotent initializer.
4. Keep database access limited to the application role. Rotate the Neon password if it has ever been exposed.

## Google Sheets

1. Enable Google Sheets API in the Google Cloud project for the service account.
2. Store the service-account email and private key in server-side `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`.
3. Share each monthly spreadsheet with the service-account email, with edit access.
4. In the admin dashboard, choose the month/year and save the spreadsheet ID from that spreadsheet's URL.
5. New attendance entries go first to PostgreSQL and an outbox row in the same transaction. A background worker retries Sheets failures with backoff; it does not roll back attendance. It checks the Attendance ID column before append/update to make a retry idempotent. Use **Retry spreadsheet sync** in the attendance dashboard to queue failed records again.

The first synchronization creates the header row. Keep columns A:G in this order: Attendance ID, Date, Register Number, Name, Entry Time, Exit Time, Status. When changing a month's spreadsheet, pending attendance outbox rows for that month are requeued.

## Promotional images

Configure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` on the server. Admin uploads accept valid JPEG, PNG, or WebP files up to 8 MB. Files are stored in Cloudinary; PostgreSQL stores their secure URLs and public IDs. The API enforces a maximum of five active images. If a Cloudinary deletion fails after a database update, the server keeps the unreferenced asset ID in a PostgreSQL cleanup queue and retries it; assets still referenced by an image record are never deleted. If storage is not configured, the admin UI shows the server error rather than pretending an upload succeeded.

## Staff/Admin leave calendar

The Leave Calendar reuses `calendar_events` and keeps existing holiday/event rows intact. New entries select either Staff/Admin Leave or Class Closed scope. Only a full-day Class Closed record affects student absence calculations; staff leave and partial-day leave do not rewrite attendance. Run `npm run db:setup` (or start the PostgreSQL backend) to apply the additive scope, creator, and uniqueness changes. Monthly Excel downloads remain the existing two worksheets and label full-day closures `LEAVE`, with partial leave range/duration in the leave-details field.

## Production deployment

`render.yaml` describes a Render Node web service that builds Vite and serves the frontend and PostgreSQL API from the same origin. Create the service from this blueprint, then enter the secret environment values in Render's dashboard. Set:

- `DATABASE_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` (at least 16 random characters)
- Cloudinary values to enable upload management
- Google service-account values to enable sync
- `NODE_ENV=production` (the blueprint sets it)

Render supplies `PORT`; the app enables the `Secure` admin cookie in production and exposes `/api/health` for its health check. Configure a custom domain and HTTPS, review Render's backups/availability plan, and test against a staging Neon database before production traffic. Never deploy with placeholder credentials. See [Security checklist](./docs/security-checklist.md).

## Tests and API

```powershell
npm test
npm run build
```

The PostgreSQL integration suite only runs when `TEST_DATABASE_URL` points at a dedicated database whose database name includes `test`. It creates a uniquely named isolated schema and drops only that schema at teardown; it refuses to run against a database with a different name. Do not point it at production.

Routes, request shapes, and status codes are documented in [API documentation](./docs/api.md). Google Sheets and Cloudinary require valid service credentials and a real shared sheet/storage account for end-to-end provider verification.
