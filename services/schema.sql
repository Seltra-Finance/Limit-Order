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
    order_hash        TEXT NOT NULL REFERENCES orders (order_hash),
    path              TEXT NOT NULL CHECK (path IN ('dex', 'p2p')),
    adapter_id        SMALLINT,
    keeper            TEXT NOT NULL,
    tx_hash           TEXT NOT NULL,
    amount_out        NUMERIC(78, 0) NOT NULL,
    maker_improvement NUMERIC(78, 0) NOT NULL,
    keeper_reward     NUMERIC(78, 0) NOT NULL,
    block_number      BIGINT NOT NULL
);

-- Backward-compatible migration for databases created before venue attribution.
ALTER TABLE fills ADD COLUMN IF NOT EXISTS adapter_id SMALLINT;

CREATE TABLE IF NOT EXISTS maker_epochs (
    maker TEXT PRIMARY KEY,
    epoch NUMERIC(78, 0) NOT NULL DEFAULT 0
);
