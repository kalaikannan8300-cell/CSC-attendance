# Production security checklist

- [ ] Use a unique Neon production database and a least-privilege database role; enable backups and test recovery.
- [ ] Store `DATABASE_URL`, admin bootstrap credentials, Cloudinary secrets, and Google private key only in server/deployment secret settings. Never use `VITE_*` variables for secrets.
- [ ] Rotate any admin credential that was printed, pasted, committed, or otherwise exposed; bootstrap never changes an existing admin password.
- [ ] Use HTTPS in production. The admin session is an eight-hour random server-side token stored hashed in PostgreSQL and sent in an HttpOnly, SameSite=Strict, Secure cookie.
- [ ] Review admin account access regularly. Set `admins.is_active=FALSE` in PostgreSQL to disable an admin and revoke their sessions.
- [ ] Restrict Sheets API scope and share each monthly spreadsheet only with the service account. Keep its private key server-side.
- [ ] Restrict Cloudinary credentials to the required account; upload endpoints validate MIME type, image signatures, and an 8 MB size limit.
- [ ] Keep the PostgreSQL integration test URL pointed at a dedicated database whose name includes `test`. Never run tests or imports against production accidentally.
- [ ] Back up SQLite before import; the importer opens it read-only and does not delete or rewrite source rows.
- [ ] Review server/provider logs and failed `attendance_sync_outbox` entries. Logs must not include passwords, session tokens, private keys, or full database URLs.
- [ ] Keep dependencies updated and review security advisories before each production release.
- [ ] Run `npm test` and `npm run build` before deployment and verify `/api/health` after release.
