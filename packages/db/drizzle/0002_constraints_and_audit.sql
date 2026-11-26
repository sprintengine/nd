-- Rules drizzle-kit cannot express in the schema. Keep them in hand-written
-- migrations; drizzle-kit diffs only its snapshots, so it leaves them alone.

-- Bookings that hold a charger (SLOT_HOLDING_BOOKING_STATUSES in @nd/domain)
-- can never overlap on the same charger. Requested, cancelled and finished
-- bookings do not hold the slot.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_overlapping_slots"
  EXCLUDE USING gist ("charger_id" WITH =, "slot" WITH &&)
  WHERE ("status" IN ('confirmed', 'arrived', 'active'));
--> statement-breakpoint

-- ocpp_messages is the evidence file for disputes: rows are only ever
-- inserted. UPDATE, DELETE and TRUNCATE are rejected for every role, the
-- owner and superusers included. The one exception is purge_ocpp_messages(),
-- which runs as the table owner and flags its own transaction.
REVOKE UPDATE, DELETE, TRUNCATE ON "ocpp_messages" FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION "ocpp_messages_reject_change"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND current_setting('nd.ocpp_messages_purge', true) = 'on'
    AND current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID)
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'ocpp_messages is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Old rows are removed only by purge_ocpp_messages().';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ocpp_messages_append_only"
  BEFORE UPDATE OR DELETE ON "ocpp_messages"
  FOR EACH ROW EXECUTE FUNCTION "ocpp_messages_reject_change"();
--> statement-breakpoint
CREATE TRIGGER "ocpp_messages_no_truncate"
  BEFORE TRUNCATE ON "ocpp_messages"
  FOR EACH STATEMENT EXECUTE FUNCTION "ocpp_messages_reject_change"();
--> statement-breakpoint

-- Retention: deletes OCPP messages older than `older_than` and returns how
-- many went. The retention period is 24 months, so nothing younger can be
-- purged. Runs as its owner (the role that ran the migrations); the
-- application role cannot call it unless granted EXECUTE.
CREATE FUNCTION "purge_ocpp_messages"("older_than" interval DEFAULT interval '24 months')
  RETURNS bigint
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  deleted bigint;
BEGIN
  IF older_than IS NULL OR older_than < interval '24 months' THEN
    RAISE EXCEPTION 'OCPP messages are kept for at least 24 months, got %', older_than
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM set_config('nd.ocpp_messages_purge', 'on', true);
  DELETE FROM ocpp_messages WHERE ts < now() - older_than;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  PERFORM set_config('nd.ocpp_messages_purge', 'off', true);
  RETURN deleted;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "purge_ocpp_messages"(interval) FROM PUBLIC;
