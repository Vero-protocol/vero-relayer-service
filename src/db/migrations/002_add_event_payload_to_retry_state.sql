ALTER TABLE retry_state
    ADD COLUMN IF NOT EXISTS event_payload JSONB;
