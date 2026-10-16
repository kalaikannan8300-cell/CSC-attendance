# CSC Class Attendance Management System

The existing React, TypeScript, Vite, and custom CSS interface is connected to a Node.js API backed by PostgreSQL. The application is designed for one CSC training-center branch: students enter only their Register Number; administrators manage student records, attendance, exit approvals, promotional images, and monthly Sheets destinations.

## Quick start

1. Install Node.js 22.13+ and npm.
2. Copy `.env.example` to `.env` and configure PostgreSQL and the initial admin account.
3. Run:

   ```powershell
   npm ci
   npm run db:setup
   npm run dev
   ```

See [PostgreSQL and production setup](./POSTGRES_SETUP.md) for Neon, migrations/imports, Cloudinary, Google Sheets, and deployment.

## Main commands

| Command | Purpose |
|---|---|
| `npm run dev` | PostgreSQL API and Vite development servers |
| `npm run db:setup` | Idempotently initialize schema and provision the first admin |
| `npm run db:import:sqlite -- --path "C:\path\attendance.sqlite"` | Repeatable, read-only-source SQLite import |
| `npm start` | Production-style PostgreSQL API and built frontend |
| `npm test` | Existing SQLite tests and opt-in PostgreSQL integration tests |
| `npm run build` | Production frontend build |
| `npm run dev:sqlite` | Optional legacy SQLite demo only |

The PostgreSQL API health check is `/api/health`. Do not use the SQLite demo as production storage.

## Documentation

- [PostgreSQL setup, Neon, integrations, and deployment](./POSTGRES_SETUP.md)
- [API route reference](./docs/api.md)
- [Security checklist](./docs/security-checklist.md)
- [Student management notes](./docs/student-management.md)
