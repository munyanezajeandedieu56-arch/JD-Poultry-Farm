
const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");

const DB_PATH = path.join(__dirname, "jd-poultry.db");

let db;

// Get existing column names from a table
function getColumns(tableName) {
    const result = db.exec(`PRAGMA table_info(${tableName})`);

    if (!result.length) return [];

    return result[0].values.map(column => column[1]);
}

// Add a column only when it does not already exist
function addColumnIfMissing(tableName, columnName, definition) {
    const columns = getColumns(tableName);

    if (!columns.includes(columnName)) {
        db.run(
            `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`
        );
    }
}

// Initialize database
async function initializeDatabase() {
    const SQL = await initSqlJs();

    // Load existing database without deleting its data
    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
    } else {
        db = new SQL.Database();
    }

    db.run("PRAGMA foreign_keys = ON;");

    // PRODUCTS
    db.run(`
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            price REAL NOT NULL DEFAULT 0,
            stock INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            image_url TEXT,
            image_public_id TEXT
        )
    `);

    addColumnIfMissing("products", "is_active", "INTEGER DEFAULT 1");
    addColumnIfMissing("products", "image_url", "TEXT");
    addColumnIfMissing("products", "image_public_id", "TEXT");

    // WEBSITE SETTINGS
    db.run(`
        CREATE TABLE IF NOT EXISTS site_settings (
            setting_key TEXT PRIMARY KEY,
            setting_value TEXT
        )
    `);

    // HOMEPAGE SLIDESHOW
    db.run(`
        CREATE TABLE IF NOT EXISTS homepage_slides (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            image_url TEXT NOT NULL,
            image_public_id TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // ORDERS
    db.run(`
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_name TEXT NOT NULL,
            phone TEXT NOT NULL,
            address TEXT,
            product_id INTEGER,
            product_name TEXT,
            quantity INTEGER DEFAULT 0,
            unit_price REAL DEFAULT 0,
            total_price REAL DEFAULT 0,
            total REAL DEFAULT 0,
            notes TEXT,
            status TEXT DEFAULT 'Pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Add server-required columns to existing orders table
    addColumnIfMissing("orders", "product_id", "INTEGER");
    addColumnIfMissing("orders", "product_name", "TEXT");
    addColumnIfMissing("orders", "quantity", "INTEGER DEFAULT 0");
    addColumnIfMissing("orders", "unit_price", "REAL DEFAULT 0");
    addColumnIfMissing("orders", "total_price", "REAL DEFAULT 0");
    addColumnIfMissing("orders", "notes", "TEXT");

    // Preserve old order totals when migrating
    const orderColumns = getColumns("orders");

    if (orderColumns.includes("total")) {
        db.run(`
            UPDATE orders
            SET total_price = total
            WHERE total_price = 0 AND total IS NOT NULL
        `);
    }

    // ORDER ITEMS
    db.run(`
        CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            product_id INTEGER,
            product_name TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            price REAL NOT NULL DEFAULT 0,
            unit_price REAL DEFAULT 0,
            total_price REAL DEFAULT 0,
            FOREIGN KEY (order_id) REFERENCES orders(id),
            FOREIGN KEY (product_id) REFERENCES products(id)
        )
    `);

    // Add missing columns to existing order_items table
    addColumnIfMissing("order_items", "unit_price", "REAL DEFAULT 0");
    addColumnIfMissing("order_items", "total_price", "REAL DEFAULT 0");

    // Preserve old item prices
    const itemColumns = getColumns("order_items");

    if (itemColumns.includes("price")) {
        db.run(`
            UPDATE order_items
            SET unit_price = price
            WHERE unit_price = 0 AND price IS NOT NULL
        `);

        db.run(`
            UPDATE order_items
            SET total_price = price * quantity
            WHERE total_price = 0 AND price IS NOT NULL
        `);
    }

    // INDEXES
    db.run(`
        CREATE INDEX IF NOT EXISTS idx_orders_created_at
        ON orders(created_at)
    `);

    db.run(`
        CREATE INDEX IF NOT EXISTS idx_orders_status
        ON orders(status)
    `);

    db.run(`
        CREATE INDEX IF NOT EXISTS idx_order_items_order_id
        ON order_items(order_id)
    `);

    db.run(`
        CREATE INDEX IF NOT EXISTS idx_products_active
        ON products(is_active)
    `);

    // Save database after initialization
    saveDatabase();

    console.log("Database initialized successfully.");

    return db;
}

// Save database to file
function saveDatabase() {
    if (!db) {
        throw new Error("Database has not been initialized.");
    }

    const data = db.export();
    const buffer = Buffer.from(data);

    fs.writeFileSync(DB_PATH, buffer);
}

module.exports = {
    initializeDatabase,
    saveDatabase
};
