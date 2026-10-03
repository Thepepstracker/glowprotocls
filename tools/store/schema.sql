-- Apply to a private PostgreSQL database BEFORE configuring the Netlify function.
-- Use a restricted server-only database user. Do not expose credentials in client code.
CREATE TABLE IF NOT EXISTS glow_store_records (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (kind, key)
);
-- This initial design serializes short mutations with an advisory transaction lock.
-- Scale-out work should separate orders, receipts and inventory into typed tables.
