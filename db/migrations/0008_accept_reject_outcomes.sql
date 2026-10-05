-- Up Migration
-- =====================================================================================================
-- 0008_accept_reject_outcomes — Stage 6, slice 2: a business answers the leads it is given, and records what came of them.
--
--   enforce_assignment_end_actor   a signed-in business user may now END an assignment as `rejected` (declining a lead), with a reason;
--                                  `cancelled` (taking a lead back) stays staff/system only
--   clients.max_open_leads         the most leads a business may hold UNANSWERED at once (null = no limit); the router honours it
--   assignment_contact_attempts    what the business did with a lead it accepted (rang, no answer, won, lost...) and what the job was worth
--
-- The note a business writes about a call is the business's record but can mention the consumer, so erasing a lead clears it too
-- (privacy module). Roll-forward only.
-- =====================================================================================================

CREATE OR REPLACE FUNCTION enforce_assignment_end_actor() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_actor  text := coalesce(current_setting('app.actor_type', true), '');
  v_id     text := nullif(current_setting('app.actor_id', true), '');
  v_reason text := nullif(current_setting('app.reason', true), '');
BEGIN
  IF NEW.status IN ('cancelled', 'rejected') AND NEW.status IS DISTINCT FROM OLD.status THEN
    -- The system may end anything. Staff must be named and give a reason. A business user may only DECLINE, naming themselves and why.
    IF NOT (
         v_actor = 'system'
      OR (v_actor = 'staff_user' AND v_id IS NOT NULL AND v_reason IS NOT NULL)
      OR (v_actor = 'client_user' AND NEW.status = 'rejected' AND v_id IS NOT NULL AND v_reason IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'ending an assignment needs an actor and, for staff or a business, a reason'
        USING ERRCODE = 'check_violation',
              HINT = 'set app.actor_type, and for staff_user or client_user also app.actor_id and app.reason, in the transaction';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

ALTER TABLE clients ADD COLUMN max_open_leads smallint CHECK (max_open_leads > 0);

CREATE TYPE contact_outcome AS ENUM ('no_answer', 'left_voicemail', 'spoke', 'wrong_number', 'not_interested', 'quote_sent', 'won', 'lost');

CREATE TABLE assignment_contact_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id   uuid NOT NULL REFERENCES lead_assignments (id),
  outcome         contact_outcome NOT NULL,
  note            text CHECK (char_length(note) <= 1000),
  -- What the job was worth (a quote, or the price won), client-reported: it is how a business sees its return and how lead quality is judged.
  job_value_pence integer CHECK (job_value_pence >= 0 AND job_value_pence <= 100000000),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES client_users (id),
  CONSTRAINT contact_attempts_value_chk CHECK (job_value_pence IS NULL OR outcome IN ('quote_sent', 'won'))
);
CREATE INDEX contact_attempts_idx ON assignment_contact_attempts (assignment_id, occurred_at DESC);

ALTER TABLE assignment_contact_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY contact_attempts_tenant ON assignment_contact_attempts
  USING (app_client_id() IS NULL OR EXISTS (SELECT 1 FROM lead_assignments a WHERE a.id = assignment_contact_attempts.assignment_id AND a.client_id = app_client_id()));

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadgen_app') THEN
    -- Append-only for the application: a logged call is never edited or deleted (only its note is cleared when a person is erased).
    GRANT SELECT, INSERT ON assignment_contact_attempts TO leadgen_app;
    GRANT UPDATE (note) ON assignment_contact_attempts TO leadgen_app;
  END IF;
END
$grants$;
