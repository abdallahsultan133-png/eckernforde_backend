CREATE TABLE IF NOT EXISTS "password_reset_requests" (
    "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
    "user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
    "email" varchar(320) NOT NULL,
    "status" varchar(32) DEFAULT 'pending' NOT NULL,
    "requested_at" timestamp DEFAULT now() NOT NULL,
    "handled_at" timestamp,
    "handled_by" text REFERENCES "user"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "password_reset_requests_status_idx"
    ON "password_reset_requests" ("status");
CREATE INDEX IF NOT EXISTS "password_reset_requests_requested_at_idx"
    ON "password_reset_requests" ("requested_at");
CREATE INDEX IF NOT EXISTS "password_reset_requests_user_id_idx"
    ON "password_reset_requests" ("user_id");
