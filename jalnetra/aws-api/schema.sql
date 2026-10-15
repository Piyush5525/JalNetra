CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS jn_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner text NOT NULL,
  role text NOT NULL CHECK (role IN ('reporter', 'operator')),
  key_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jn_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_type text NOT NULL CHECK (incident_type IN ('river_flood', 'waterlogging', 'pothole', 'leak')),
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  status text NOT NULL DEFAULT 'detected' CHECK (status IN ('detected', 'approved', 'ticketed', 'fixed_claimed', 'reopened', 'escalated', 'rejected', 'verified', 'contacted', 'evacuating')),
  confidence double precision NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  observed_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('satellite', 'forecast', 'cctv', 'dashcam', 'app', 'whatsapp', 'sms', 'call', 'sensor')),
  language text NOT NULL DEFAULT 'hi',
  title text,
  evidence_url text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  reported_by text NOT NULL,
  reports integer NOT NULL DEFAULT 1 CHECK (reports > 0),
  sla_due timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jn_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES jn_incidents(id) ON DELETE CASCADE,
  action text NOT NULL,
  actor text NOT NULL,
  note text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jn_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('sarpanch', 'asha', 'ngo', 'official', 'volunteer')),
  phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  place_name text NOT NULL,
  district text,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  language text NOT NULL DEFAULT 'hi',
  added_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jn_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES jn_incidents(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES jn_contacts(id) ON DELETE SET NULL,
  channel text NOT NULL CHECK (channel IN ('call', 'sms')),
  message text NOT NULL,
  status text NOT NULL CHECK (status IN ('sent', 'failed', 'not_configured')),
  provider_ref text,
  error text,
  sent_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Kept for compatibility with the Supabase schema. Provider credentials are
-- intentionally read from Lambda environment variables, not this table.
CREATE TABLE IF NOT EXISTS jn_config (
  key text PRIMARY KEY,
  value text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jn_incidents_created_at_idx ON jn_incidents (created_at DESC);
CREATE INDEX IF NOT EXISTS jn_incidents_dedup_idx ON jn_incidents (incident_type, status, updated_at);
CREATE INDEX IF NOT EXISTS jn_incidents_bbox_idx ON jn_incidents (lat, lng);
CREATE INDEX IF NOT EXISTS jn_events_incident_idx ON jn_events (incident_id, created_at);
CREATE INDEX IF NOT EXISTS jn_alerts_incident_idx ON jn_alerts (incident_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jn_contacts_location_idx ON jn_contacts (lat, lng);

-- ===== Conduct Demo (exercise alerts) =====
-- Isolated from jn_incidents, jn_alerts and jn_contacts on purpose. Idempotent.
-- Rollback: see DEMO.md (drop the four jn_demo_* tables, nothing else references them).
CREATE TABLE IF NOT EXISTS jn_demo_operators (
  owner text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jn_demo_sessions (
  id uuid PRIMARY KEY,
  owner text NOT NULL,
  request_id text NOT NULL,
  scenario_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner, request_id)
);

CREATE TABLE IF NOT EXISTS jn_demo_alerts (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES jn_demo_sessions(id) ON DELETE CASCADE,
  ord integer NOT NULL CHECK (ord BETWEEN 1 AND 5),
  scenario_id text NOT NULL,
  approval_status text NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved')),
  approved_at timestamptz,
  approved_by text,
  approve_request_id text,
  horizon_hours integer CHECK (horizon_hours IS NULL OR horizon_hours IN (0, 3, 6, 12, 24)),
  prediction_digest text,
  prediction_ref jsonb,
  call_status text NOT NULL DEFAULT 'not_requested' CHECK (call_status IN ('not_requested', 'dispatching', 'dispatched', 'failed', 'not_configured', 'unknown')),
  call_attempts integer NOT NULL DEFAULT 0 CHECK (call_attempts IN (0, 1)),
  call_updated_at timestamptz,
  provider_ref text,
  UNIQUE (session_id, ord),
  UNIQUE (session_id, scenario_id)
);

-- One row per reserved call. UNIQUE (alert_id) is the database-level guarantee of at most one call per alert.
CREATE TABLE IF NOT EXISTS jn_demo_call_ledger (
  id bigserial PRIMARY KEY,
  owner text NOT NULL,
  session_id uuid NOT NULL REFERENCES jn_demo_sessions(id) ON DELETE CASCADE,
  alert_id uuid NOT NULL UNIQUE REFERENCES jn_demo_alerts(id) ON DELETE CASCADE,
  reserved_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jn_demo_ledger_owner_idx ON jn_demo_call_ledger (owner, reserved_at DESC);
CREATE INDEX IF NOT EXISTS jn_demo_alerts_session_idx ON jn_demo_alerts (session_id, ord);
