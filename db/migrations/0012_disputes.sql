-- Up Migration
-- =====================================================================================================
-- 0012_disputes — Stage 6, slice 4: a business can say "this lead is bad", and staff decide, with the money following the decision.
--
--   disputes   one per lead per business (a withdrawn one may be raised again); the business raises or withdraws it, a named member of
--              staff upholds or rejects it. Upholding ends the assignment as `refunded`, and migration 0009's trigger gives the money back.
--
-- What a business writes in a dispute is free text and can name the consumer, so erasing a lead clears it (privacy module). The decision
-- is a CODE from a closed list, never free text. Roll-forward only.
-- =====================================================================================================

CREATE TYPE dispute_reason     AS ENUM ('wrong_number', 'not_homeowner', 'out_of_area', 'duplicate', 'spam', 'not_as_described', 'other');
CREATE TYPE dispute_status     AS ENUM ('open', 'under_review', 'upheld', 'rejected', 'withdrawn');
CREATE TYPE dispute_resolution AS ENUM ('credit_refund', 'replacement_lead');

CREATE TABLE disputes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id   uuid NOT NULL REFERENCES lead_assignments (id),
  client_id       uuid NOT NULL REFERENCES clients (id),
  reason          dispute_reason NOT NULL,
  description     text CHECK (char_length(description) <= 2000),
  status          dispute_status NOT NULL DEFAULT 'open',
  resolution      dispute_resolution,
  raised_by       uuid NOT NULL REFERENCES client_users (id),
  decided_by      uuid REFERENCES operators (id),
  decided_at      timestamptz,
  -- A code from a closed list, never free text.
  decision_reason text CHECK (decision_reason ~ '^[a-z_]{1,40}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT disputes_decision_chk CHECK ((status IN ('upheld', 'rejected')) = (decided_at IS NOT NULL)),
  CONSTRAINT disputes_decider_chk CHECK ((status IN ('upheld', 'rejected')) = (decided_by IS NOT NULL AND decision_reason IS NOT NULL)),
  CONSTRAINT disputes_upheld_has_resolution_chk CHECK ((status = 'upheld') = (resolution IS NOT NULL))
);
-- One dispute per assignment, ever, unless it was withdrawn: a decided one is final (no raising it again and again).
CREATE UNIQUE INDEX disputes_one_per_assignment ON disputes (assignment_id) WHERE status <> 'withdrawn';
CREATE INDEX disputes_open_idx ON disputes (created_at) WHERE status IN ('open', 'under_review');
CREATE INDEX disputes_client_idx ON disputes (client_id, created_at DESC);
CREATE TRIGGER disputes_set_updated_at BEFORE UPDATE ON disputes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Who may change a dispute, and how. Not editable: what was claimed, by whom, about what. Decided and withdrawn are final.
-- Only a named member of staff decides (the context the history triggers already read); only the business withdraws. The one other
-- edit allowed is clearing the description when the person it is about is erased.
CREATE FUNCTION guard_dispute_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_actor text := coalesce(current_setting('app.actor_type', true), '');
  v_id    text := nullif(current_setting('app.actor_id', true), '');
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a dispute cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.assignment_id <> OLD.assignment_id OR NEW.client_id <> OLD.client_id OR NEW.reason <> OLD.reason
     OR NEW.raised_by <> OLD.raised_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'what was claimed in a dispute cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.description IS DISTINCT FROM OLD.description AND NEW.description IS NOT NULL THEN
    RAISE EXCEPTION 'a dispute''s description can only be cleared' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status IN ('upheld', 'rejected', 'withdrawn') THEN
      RAISE EXCEPTION 'a decided or withdrawn dispute is final' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IN ('upheld', 'rejected') AND NOT (v_actor = 'staff_user' AND v_id IS NOT NULL AND v_id::uuid = NEW.decided_by) THEN
      RAISE EXCEPTION 'only a named member of staff can decide a dispute' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'withdrawn' AND NOT (v_actor = 'client_user' AND v_id IS NOT NULL) THEN
      RAISE EXCEPTION 'only the business can withdraw a dispute' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'under_review' AND OLD.status <> 'open' THEN
      RAISE EXCEPTION 'only an open dispute can go under review' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.resolution IS DISTINCT FROM OLD.resolution OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
        OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason THEN
    RAISE EXCEPTION 'a decision cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER disputes_guard BEFORE UPDATE OR DELETE ON disputes FOR EACH ROW EXECUTE FUNCTION guard_dispute_change();

-- A business sees and raises only its own.
ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;
CREATE POLICY disputes_tenant ON disputes USING (app_client_id() IS NULL OR client_id = app_client_id());

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadgen_app') THEN
    GRANT SELECT, INSERT, UPDATE ON disputes TO leadgen_app;
  END IF;
END
$grants$;
