-- Newsletter ingestion schema.
--
-- emails: one row per fetched email (raw + processing state).
-- events: one row per event Claude extracted from an email.

CREATE TABLE IF NOT EXISTS emails (
    id              INTEGER PRIMARY KEY,
    source          TEXT    NOT NULL,
    message_id      TEXT    NOT NULL UNIQUE,   -- Gmail Message-ID header
    from_addr       TEXT,
    subject         TEXT,
    received_at     TEXT,                      -- ISO 8601, UTC
    raw_text        TEXT,                      -- plaintext body
    fetched_at      TEXT    NOT NULL,          -- ISO 8601, UTC
    parsed_at       TEXT,                      -- ISO 8601, UTC (NULL = not yet)
    parse_error     TEXT                       -- last error if parse failed
);
CREATE INDEX IF NOT EXISTS emails_unparsed ON emails(parsed_at) WHERE parsed_at IS NULL;
CREATE INDEX IF NOT EXISTS emails_source ON emails(source);

CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY,
    email_id        INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    source          TEXT    NOT NULL,
    name            TEXT    NOT NULL,
    date            TEXT,                      -- ISO YYYY-MM-DD or NULL
    end_date        TEXT,                      -- ISO YYYY-MM-DD or NULL
    time            TEXT,                      -- free-form (e.g. "8pm", "All day")
    location        TEXT,                      -- venue or address
    neighborhood    TEXT,                      -- e.g. "Williamsburg"
    price           TEXT,                      -- free-form (e.g. "Free", "$25")
    link            TEXT,
    blurb           TEXT,
    tags_json       TEXT,                      -- JSON array of strings
    extracted_at    TEXT    NOT NULL           -- ISO 8601, UTC
);
CREATE INDEX IF NOT EXISTS events_date ON events(date);
CREATE INDEX IF NOT EXISTS events_neighborhood ON events(neighborhood);
CREATE INDEX IF NOT EXISTS events_email ON events(email_id);
