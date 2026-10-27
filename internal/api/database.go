package api

import (
	"context"
	"database/sql"
	"fmt"
)

func InitializeDatabase(ctx context.Context, db *sql.DB) error {
	const schema = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    email TEXT
);
CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    image_data TEXT,
    observations TEXT,
    sale_price TEXT,
    market_value TEXT,
    currency TEXT NOT NULL,
    entry_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('stock', 'sold')),
    sale_date TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((status = 'sold' AND sale_date IS NOT NULL) OR (status = 'stock' AND sale_date IS NULL))
);
CREATE INDEX IF NOT EXISTS products_user_status ON products(user_id, status);
CREATE TABLE IF NOT EXISTS costs (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    price TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS costs_product ON costs(product_id);
CREATE TABLE IF NOT EXISTS product_creations (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mutation_id TEXT NOT NULL,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, mutation_id)
);
CREATE TABLE IF NOT EXISTS supported_currencies (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exchange_rates (
    currency TEXT PRIMARY KEY,
    to_brl TEXT NOT NULL,
    rate_date TEXT NOT NULL
);
`
	if _, err := db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("initialize database: %w", err)
	}
	return nil
}
