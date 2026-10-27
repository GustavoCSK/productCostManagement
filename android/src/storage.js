import * as SQLite from "expo-sqlite";

let database;

export async function getDatabase() {
  if (!database) {
    database = await SQLite.openDatabaseAsync("product-costs.db");
    await database.execAsync(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS products (
        account_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        pending INTEGER NOT NULL DEFAULT 0,
        conflict TEXT,
        PRIMARY KEY (account_id, product_id)
      );
      CREATE TABLE IF NOT EXISTS pending_changes (
        account_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        base_version INTEGER NOT NULL DEFAULT 0,
        payload TEXT,
        PRIMARY KEY (account_id, product_id)
      );
      CREATE TABLE IF NOT EXISTS exchange_rates (
        account_id TEXT NOT NULL,
        currency TEXT NOT NULL,
        to_brl TEXT NOT NULL,
        rate_date TEXT NOT NULL,
        PRIMARY KEY (account_id, currency)
      );
      CREATE TABLE IF NOT EXISTS currencies (
        account_id TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (account_id, code)
      );
    `);
  }
  return database;
}

export async function readProducts(accountID) {
  const db = await getDatabase();
  const rows = await db.getAllAsync(
    `SELECT products.product_id, products.payload, products.pending, products.conflict, pending_changes.operation
     FROM products LEFT JOIN pending_changes
       ON products.account_id = pending_changes.account_id AND products.product_id = pending_changes.product_id
     WHERE products.account_id = ? ORDER BY json_extract(products.payload, '$.name') COLLATE NOCASE`,
    accountID,
  );
  return rows.map((row) => ({
    ...JSON.parse(row.payload),
    localKey: row.product_id,
    isPending: Boolean(row.pending),
    isDeletePending: row.operation === "delete",
    conflict: row.conflict ? JSON.parse(row.conflict) : null,
  }));
}

export async function saveLocalProduct(accountID, product, previous = null) {
  const db = await getDatabase();
  const localKey = previous?.localKey ?? (product.id ? String(product.id) : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const baseVersion = previous ? previous.version : 0;
  const payload = { ...product, version: baseVersion };
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT INTO products (account_id, product_id, payload, version, pending, conflict) VALUES (?, ?, ?, ?, 1, NULL)
       ON CONFLICT(account_id, product_id) DO UPDATE SET payload = excluded.payload, pending = 1, conflict = NULL`,
      accountID, localKey, JSON.stringify(payload), baseVersion,
    );
    const operation = localKey.startsWith("local-") ? "create" : "upsert";
    await db.runAsync(
      `INSERT INTO pending_changes (account_id, product_id, operation, base_version, payload) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id, product_id) DO UPDATE SET operation = excluded.operation, payload = excluded.payload`,
      accountID, localKey, operation, baseVersion, JSON.stringify(payload),
    );
  });
  return { ...payload, localKey, isPending: true, conflict: null };
}

export async function queueDelete(accountID, product) {
  const db = await getDatabase();
  if (product.localKey.startsWith("local-")) {
    await db.runAsync("DELETE FROM products WHERE account_id = ? AND product_id = ?", accountID, product.localKey);
    await db.runAsync("DELETE FROM pending_changes WHERE account_id = ? AND product_id = ?", accountID, product.localKey);
    return;
  }
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      "UPDATE products SET pending = 1, conflict = NULL WHERE account_id = ? AND product_id = ?",
      accountID, product.localKey,
    );
    await db.runAsync(
      `INSERT INTO pending_changes (account_id, product_id, operation, base_version, payload) VALUES (?, ?, 'delete', ?, ?)
       ON CONFLICT(account_id, product_id) DO UPDATE SET operation = 'delete', base_version = excluded.base_version, payload = excluded.payload`,
      accountID, product.localKey, product.version, JSON.stringify(product),
    );
  });
}

export async function readPending(accountID) {
  const db = await getDatabase();
  const rows = await db.getAllAsync("SELECT product_id, operation, base_version, payload FROM pending_changes WHERE account_id = ? ORDER BY rowid", accountID);
  return rows.map((row) => ({ ...row, payload: row.payload ? JSON.parse(row.payload) : null }));
}

export async function saveServerProduct(accountID, product, localKey = String(product.id)) {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO products (account_id, product_id, payload, version, pending, conflict) VALUES (?, ?, ?, ?, 0, NULL)
     ON CONFLICT(account_id, product_id) DO UPDATE SET payload = excluded.payload, version = excluded.version, pending = 0, conflict = NULL`,
    accountID, localKey, JSON.stringify(product), product.version,
  );
  await db.runAsync("DELETE FROM pending_changes WHERE account_id = ? AND product_id = ?", accountID, localKey);
}

export async function migrateCreatedProduct(accountID, oldKey, product) {
  const db = await getDatabase();
  const newKey = String(product.id);
  await db.withTransactionAsync(async () => {
    await db.runAsync("DELETE FROM products WHERE account_id = ? AND product_id = ?", accountID, oldKey);
    await db.runAsync("DELETE FROM pending_changes WHERE account_id = ? AND product_id = ?", accountID, oldKey);
    await db.runAsync(
      `INSERT INTO products (account_id, product_id, payload, version, pending, conflict) VALUES (?, ?, ?, ?, 0, NULL)
       ON CONFLICT(account_id, product_id) DO UPDATE SET payload = excluded.payload, version = excluded.version, pending = 0, conflict = NULL`,
      accountID, newKey, JSON.stringify(product), product.version,
    );
  });
}

export async function removeServerProduct(accountID, productID) {
  const db = await getDatabase();
  await db.runAsync("DELETE FROM products WHERE account_id = ? AND product_id = ?", accountID, productID);
  await db.runAsync("DELETE FROM pending_changes WHERE account_id = ? AND product_id = ?", accountID, productID);
}

export async function saveConflict(accountID, productID, conflict) {
  const db = await getDatabase();
  await db.runAsync(
    "UPDATE products SET conflict = ?, pending = 1 WHERE account_id = ? AND product_id = ?",
    JSON.stringify(conflict), accountID, productID,
  );
}

export async function resolveServerVersion(accountID, productID, product) {
  await saveServerProduct(accountID, product, productID);
}

export async function saveRates(accountID, rates) {
  const db = await getDatabase();
  await db.withTransactionAsync(async () => {
    for (const [currency, rate] of Object.entries(rates ?? {})) {
      await db.runAsync(
        `INSERT INTO exchange_rates (account_id, currency, to_brl, rate_date) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, currency) DO UPDATE SET to_brl = excluded.to_brl, rate_date = excluded.rate_date`,
        accountID, currency, rate.toBRL, rate.date,
      );
    }
  });
}

export async function readRates(accountID) {
  const db = await getDatabase();
  const rows = await db.getAllAsync("SELECT currency, to_brl, rate_date FROM exchange_rates WHERE account_id = ?", accountID);
  return Object.fromEntries(rows.map((row) => [row.currency, { toBRL: row.to_brl, date: row.rate_date }]));
}

export async function saveCurrencies(accountID, values) {
  const db = await getDatabase();
  await db.withTransactionAsync(async () => {
    for (const [code, name] of Object.entries(values ?? {})) {
      await db.runAsync(
        `INSERT INTO currencies (account_id, code, name) VALUES (?, ?, ?)
         ON CONFLICT(account_id, code) DO UPDATE SET name = excluded.name`,
        accountID, code, name,
      );
    }
  });
}

export async function readCurrencies(accountID) {
  const db = await getDatabase();
  const rows = await db.getAllAsync("SELECT code, name FROM currencies WHERE account_id = ?", accountID);
  return Object.fromEntries(rows.map((row) => [row.code, row.name]));
}

export async function clearPending(accountID, productID) {
  const db = await getDatabase();
  await db.runAsync("DELETE FROM pending_changes WHERE account_id = ? AND product_id = ?", accountID, productID);
  await db.runAsync("UPDATE products SET pending = 0, conflict = NULL WHERE account_id = ? AND product_id = ?", accountID, productID);
}
