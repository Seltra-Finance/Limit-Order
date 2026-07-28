-- Seltra orderbook schema (revised spec 1.7), PostgreSQL.

CREATE TABLE IF NOT EXISTS orders (
    order_hash      TEXT PRIMARY KEY,
    maker           TEXT NOT NULL,
    receiver        TEXT NOT NULL,
    maker_asset     TEXT NOT NULL,
    taker_asset     TEXT NOT NULL,
    making_amount   NUMERIC(78, 0) NOT NULL,
    taking_amount   NUMERIC(78, 0) NOT NULL,
    salt            NUMERIC(78, 0) NOT NULL,
    epoch           NUMERIC(78, 0) NOT NULL,
    expiry          BIGINT NOT NULL,
    allowed_sender  TEXT NOT NULL,
    flags           SMALLINT NOT NULL DEFAULT 0,
    permit_nonce    NUMERIC(78, 0) NOT NULL,
    permit_deadline BIGINT NOT NULL,
    signature       TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'resting'
                    CHECK (status IN ('resting', 'fillable', 'filled', 'cancelled', 'expired')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_pair_status ON orders (maker_asset, taker_asset, status);
CREATE INDEX IF NOT EXISTS idx_orders_maker ON orders (maker);

CREATE TABLE IF NOT EXISTS fills (
    id                SERIAL PRIMARY KEY,
    -- Deliberately not a foreign key: the chain indexer must be able to
    -- reconcile fills submitted through another API instance or after a book
    -- database restore even when the original signed order row is absent.
    order_hash        TEXT NOT NULL,
    path              TEXT NOT NULL CHECK (path IN ('dex', 'p2p')),
    adapter_id        SMALLINT,
    keeper            TEXT NOT NULL,
    tx_hash           TEXT NOT NULL,
    amount_out        NUMERIC(78, 0) NOT NULL,
    maker_improvement NUMERIC(78, 0) NOT NULL,
    keeper_reward     NUMERIC(78, 0) NOT NULL,
    block_number      BIGINT NOT NULL,
    UNIQUE (order_hash, tx_hash, path)
);

-- Backward-compatible migration for databases created before venue attribution.
ALTER TABLE fills ADD COLUMN IF NOT EXISTS adapter_id SMALLINT;
ALTER TABLE fills DROP CONSTRAINT IF EXISTS fills_order_hash_fkey;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fills_event ON fills (order_hash, tx_hash, path);

CREATE TABLE IF NOT EXISTS maker_epochs (
    maker TEXT PRIMARY KEY,
    epoch NUMERIC(78, 0) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS indexer_state (
    name         TEXT PRIMARY KEY,
    block_number BIGINT NOT NULL CHECK (block_number >= 0),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quote_points (
    pair         TEXT NOT NULL,
    timestamp_ms BIGINT NOT NULL CHECK (timestamp_ms >= 0),
    price        DOUBLE PRECISION NOT NULL CHECK (price > 0),
    PRIMARY KEY (pair, timestamp_ms)
);

CREATE INDEX IF NOT EXISTS idx_quote_points_pair_time
    ON quote_points (pair, timestamp_ms DESC);

-- Per-venue executable reference prices. This is intentionally separate from
-- quote_points so existing best-price history remains backward compatible.
CREATE TABLE IF NOT EXISTS venue_quote_points (
    pair         TEXT NOT NULL,
    venue        TEXT NOT NULL,
    timestamp_ms BIGINT NOT NULL CHECK (timestamp_ms >= 0),
    price        DOUBLE PRECISION NOT NULL CHECK (price > 0),
    PRIMARY KEY (pair, venue, timestamp_ms)
);

CREATE INDEX IF NOT EXISTS idx_venue_quote_points_pair_time
    ON venue_quote_points (pair, timestamp_ms DESC);
