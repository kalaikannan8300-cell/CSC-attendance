# Student Management

Student Management is part of the existing admin dashboard. Student records, attendance, calendar closures, and approved student leave are stored in Neon PostgreSQL; deactivation changes a status flag and never deletes the student or attendance rows.

## Local setup

Use the PostgreSQL configuration documented in `POSTGRES_SETUP.md`.

1. Configure the private server-side `.env` values and run `npm run dev`.
2. The command starts the PostgreSQL API and existing Vite app together. The Vite proxy forwards `/api` requests to the API.

Keep `.env` private and do not commit it. Cloudinary uploads additionally require `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`; the official Cloudinary Node SDK uses these only in the backend. Admins can store up to five active JPEG, PNG, or WebP promotions (maximum 8 MB each); PostgreSQL stores metadata while Cloudinary stores the image files.

## Behavior

- Admin login is checked by the API; the session cookie is HTTP-only and SameSite strict.
- Student create, list, edit, activation, and deactivation endpoints all require an admin session.
- Register numbers are normalized to uppercase and protected by a case-insensitive PostgreSQL unique constraint.
- Course and class timing use additive, non-null columns with empty-string defaults so existing student rows are preserved.
- The monthly summary counts unique attendance dates as present even when no exit time exists. Expected absences are configured working weekdays (default Monday-Friday) from the student's enrollment date through today in Asia/Kolkata, minus full-day attendance closures and approved student leave. Future dates, non-working weekdays, partial-day events, and dates before enrollment are not counted absent.
- Full-day calendar events only affect absences when the admin explicitly marks them as attendance closures. Partial-day events display their time range but do not exclude a day. Attendance records are never changed by closure creation.
- The logo remains in the promotional/branding panel on the left; the Register Number form remains on the right on desktop. Mobile layout stacks the promotional panel above the form.
- Student rows are never deleted by the management interface, and the attendance table uses a restrictive foreign key.

## Checks

Run `npm test` for API tests covering authorization, validation, duplicate registration, persistence after restart, and inactive-student attendance blocking. Run `npm run build` to validate the frontend.

For an already deployed frontend, configure the hosting environment to route same-origin `/api` requests to the Node API and set the PostgreSQL, admin, and (if uploads are needed) Cloudinary environment variables server-side. The static Vite preview alone does not run the API.
