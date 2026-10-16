CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admins (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE admins ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_username_ci ON admins(lower(username));

CREATE TABLE IF NOT EXISTS students (
  id BIGSERIAL PRIMARY KEY,
  register_number TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  phone_number TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE students ALTER COLUMN name SET DEFAULT '';
ALTER TABLE students ALTER COLUMN phone_number SET DEFAULT '';
ALTER TABLE students ALTER COLUMN address SET DEFAULT '';
ALTER TABLE students ADD COLUMN IF NOT EXISTS course TEXT NOT NULL DEFAULT '';
ALTER TABLE students ADD COLUMN IF NOT EXISTS class_timing TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_register_number_ci ON students(lower(register_number));

CREATE TABLE IF NOT EXISTS attendance (
  id BIGSERIAL PRIMARY KEY,
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  attendance_date DATE NOT NULL,
  entry_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  exit_time TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, attendance_date),
  CHECK (exit_time IS NULL OR exit_time >= entry_time)
);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS entry_time TIMESTAMPTZ;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS exit_time TIMESTAMPTZ;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'present';
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'attendance' AND column_name = 'marked_at'
  ) THEN
    EXECUTE 'UPDATE attendance SET entry_time = marked_at WHERE entry_time IS NULL';
    ALTER TABLE attendance ALTER COLUMN marked_at SET DEFAULT NOW();
    ALTER TABLE attendance ALTER COLUMN marked_at DROP NOT NULL;
  END IF;
  UPDATE attendance SET entry_time = NOW() WHERE entry_time IS NULL;
  ALTER TABLE attendance ALTER COLUMN entry_time SET NOT NULL;
  ALTER TABLE attendance ALTER COLUMN entry_time SET DEFAULT NOW();
  UPDATE attendance
  SET status = CASE WHEN exit_time IS NULL THEN 'present' ELSE 'completed' END
  WHERE (exit_time IS NULL AND status <> 'present')
     OR (exit_time IS NOT NULL AND status <> 'completed');
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_exit_after_entry') THEN
    ALTER TABLE attendance ADD CONSTRAINT attendance_exit_after_entry CHECK (exit_time IS NULL OR exit_time >= entry_time);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_status_matches_exit') THEN
    ALTER TABLE attendance ADD CONSTRAINT attendance_status_matches_exit
      CHECK ((status = 'present' AND exit_time IS NULL) OR (status = 'completed' AND exit_time IS NOT NULL));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS login_requests (
  id BIGSERIAL PRIMARY KEY,
  attendance_id BIGINT NOT NULL REFERENCES attendance(id) ON DELETE RESTRICT,
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  processed_by BIGINT REFERENCES admins(id) ON DELETE SET NULL,
  processed_at TIMESTAMPTZ,
  CHECK ((status = 'pending' AND processed_at IS NULL) OR status <> 'pending')
);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(attendance_date DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_student_date ON attendance(student_id, attendance_date DESC);
CREATE INDEX IF NOT EXISTS idx_login_requests_pending ON login_requests(status, requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_request_per_attendance ON login_requests(attendance_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id BIGINT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS student_sessions (
  token_hash TEXT PRIMARY KEY,
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  attendance_id BIGINT NOT NULL REFERENCES attendance(id) ON DELETE RESTRICT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_student_sessions_expiry ON student_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_student_sessions_attendance ON student_sessions(attendance_id);

CREATE TABLE IF NOT EXISTS calendar_events (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('public_holiday', 'csc_closed', 'emergency_leave', 'event', 'other')),
  description TEXT NOT NULL DEFAULT '',
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  full_day BOOLEAN NOT NULL DEFAULT TRUE,
  start_time TIME,
  end_time TIME,
  affects_attendance BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date),
  CHECK (
    (full_day AND start_time IS NULL AND end_time IS NULL)
    OR (NOT full_day AND start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)
  )
);
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS leave_scope TEXT;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES admins(id) ON DELETE SET NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'calendar_events_leave_scope_check'
      AND conrelid = 'calendar_events'::regclass
  ) THEN
    ALTER TABLE calendar_events
      ADD CONSTRAINT calendar_events_leave_scope_check
      CHECK (leave_scope IS NULL OR leave_scope IN ('staff', 'class_closed'));
  END IF;
END;
$$;
CREATE INDEX IF NOT EXISTS idx_calendar_events_dates ON calendar_events(start_date, end_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_events_leave_date_scope
  ON calendar_events(start_date, leave_scope) WHERE leave_scope IS NOT NULL;
CREATE TABLE IF NOT EXISTS approved_student_leaves (
  id BIGSERIAL PRIMARY KEY,
  student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  leave_date DATE NOT NULL,
  approved_by BIGINT REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(student_id, leave_date)
);
CREATE INDEX IF NOT EXISTS idx_approved_student_leaves_date ON approved_student_leaves(leave_date);
CREATE TABLE IF NOT EXISTS attendance_calendar_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  working_days SMALLINT[] NOT NULL DEFAULT ARRAY[1,2,3,4,5]::SMALLINT[],
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (cardinality(working_days) BETWEEN 1 AND 7)
);
INSERT INTO attendance_calendar_settings(id) VALUES(1) ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS spreadsheet_config (
  id BIGSERIAL PRIMARY KEY,
  month_key TEXT NOT NULL UNIQUE CHECK (month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  spreadsheet_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS promotional_images (
  id BIGSERIAL PRIMARY KEY,
  image_url TEXT NOT NULL,
  cloudinary_public_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  display_order INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE promotional_images ADD COLUMN IF NOT EXISTS cloudinary_public_id TEXT;
CREATE INDEX IF NOT EXISTS idx_promotional_images_active_order ON promotional_images(enabled, display_order, id);

CREATE TABLE IF NOT EXISTS cloudinary_asset_cleanup (
  public_id TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cloudinary_asset_cleanup_due ON cloudinary_asset_cleanup(next_attempt_at);

CREATE TABLE IF NOT EXISTS attendance_sync_outbox (
  id BIGSERIAL PRIMARY KEY,
  attendance_id BIGINT NOT NULL UNIQUE REFERENCES attendance(id) ON DELETE RESTRICT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  last_error TEXT,
  synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE attendance_sync_outbox ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_attendance_sync_pending ON attendance_sync_outbox(next_attempt_at) WHERE synced_at IS NULL;
INSERT INTO attendance_sync_outbox(attendance_id)
SELECT a.id FROM attendance a
ON CONFLICT (attendance_id) DO NOTHING;

INSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations(version) VALUES (2) ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations(version) VALUES (3) ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations(version) VALUES (4) ON CONFLICT (version) DO NOTHING;
INSERT INTO schema_migrations(version) VALUES (5) ON CONFLICT (version) DO NOTHING;
