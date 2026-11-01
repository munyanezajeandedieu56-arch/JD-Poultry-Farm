
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const path = require("path");

const {
    initializeDatabase,
    saveDatabase
} = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// =====================================
// ENVIRONMENT VALIDATION
// =====================================

const requiredSettings = [
    "SESSION_SECRET",
    "ADMIN_USERNAME",
    "ADMIN_PASSWORD",
    "CLOUDINARY_CLOUD_NAME",
    "CLOUDINARY_API_KEY",
    "CLOUDINARY_API_SECRET"
];

const missingSettings = requiredSettings.filter(
    key => !process.env[key]
);

if (missingSettings.length > 0) {
    throw new Error(
        `Missing environment settings: ${missingSettings.join(", ")}`
    );
}

if (process.env.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters.");
}

const adminPasswordHash = bcrypt.hashSync(
    process.env.ADMIN_PASSWORD,
    12
);

// =====================================
// CLOUDINARY
// =====================================

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// =====================================
// EXPRESS CONFIGURATION
// =====================================

if (IS_PRODUCTION) {
    app.set("trust proxy", 1);
}

app.disable("x-powered-by");

app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({
    extended: false,
    limit: "20kb"
}));

// =====================================
// SESSION
// =====================================

app.use(session({
    name: "jd_admin_session",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: "strict",
        secure: IS_PRODUCTION,
        maxAge: 30 * 60 * 1000
    }
}));

// =====================================
// IMAGE UPLOAD
// =====================================

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 1
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            "image/jpeg",
            "image/png",
            "image/webp"
        ];

        if (!allowedTypes.includes(file.mimetype)) {
            return cb(
                new Error("Only JPG, PNG and WEBP images are allowed.")
            );
        }

        cb(null, true);
    }
});

function uploadToCloudinary(file, folder) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder,
                resource_type: "image"
            },
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            }
        );

        stream.end(file.buffer);
    });
}

async function deleteCloudinaryImage(publicId) {
    if (!publicId) return;

    try {
        await cloudinary.uploader.destroy(publicId);
    } catch (error) {
        console.error("Cloudinary cleanup failed:", error.message);
    }
}

// =====================================
// DATABASE HELPERS
// =====================================

function getRows(db, sql, params = []) {
    const result = db.exec(sql, params);

    if (!result.length) return [];

    return result[0].values.map(row => {
        const item = {};

        result[0].columns.forEach((column, index) => {
            item[column] = row[index];
        });

        return item;
    });
}

function getLastInsertId(db) {
    const result = getRows(
        db,
        "SELECT last_insert_rowid() AS id"
    );

    return result.length ? result[0].id : null;
}

// =====================================
// ADMIN AUTHENTICATION
// =====================================

function requireAdmin(req, res, next) {
    if (req.session?.isAdmin === true) {
        return next();
    }

    if (req.path === "/admin.html") {
        return res.redirect("/login.html");
    }

    return res.status(401).json({
        success: false,
        message: "Please login as admin."
    });
}

const loginAttempts = new Map();

function loginRateLimit(req, res, next) {
    const ip = req.ip;
    const now = Date.now();
    const record = loginAttempts.get(ip);

    if (!record || now > record.resetAt) {
        loginAttempts.set(ip, {
            count: 0,
            resetAt: now + 15 * 60 * 1000
        });
    }

    const current = loginAttempts.get(ip);

    if (current.count >= 10) {
        return res.status(429).json({
            success: false,
            message: "Too many login attempts. Try again later."
        });
    }

    next();
}

function recordFailedLogin(ip) {
    const record = loginAttempts.get(ip);
    if (record) record.count += 1;
}

// =====================================
// START SERVER
// =====================================

async function startServer() {
    const db = await initializeDatabase();

    // =====================================
    // LOGIN
    // =====================================

    app.post("/api/login", loginRateLimit, (req, res, next) => {
        const { username, password } = req.body || {};

        if (
            typeof username !== "string" ||
            typeof password !== "string" ||
            username.length > 100 ||
            password.length > 200
        ) {
            return res.status(400).json({
                success: false,
                message: "Enter username and password."
            });
        }

        const validUsername =
            username === process.env.ADMIN_USERNAME;

        const validPassword =
            bcrypt.compareSync(password, adminPasswordHash);

        if (!validUsername || !validPassword) {
            recordFailedLogin(req.ip);

            return res.status(401).json({
                success: false,
                message: "Invalid username or password."
            });
        }

        loginAttempts.delete(req.ip);

        req.session.regenerate(error => {
            if (error) return next(error);

            req.session.isAdmin = true;

            req.session.save(error => {
                if (error) return next(error);

                res.json({
                    success: true,
                    message: "Login successful."
                });
            });
        });
    });

    // =====================================
    // SESSION CHECK
    // =====================================

    app.get("/api/me", (req, res) => {
        res.json({
            authenticated: req.session?.isAdmin === true
        });
    });

    // =====================================
    // LOGOUT
    // =====================================

    app.post("/api/logout", (req, res) => {
        req.session.destroy(error => {
            if (error) {
                return res.status(500).json({
                    success: false,
                    message: "Logout failed."
                });
            }

            res.clearCookie("jd_admin_session", {
                httpOnly: true,
                sameSite: "strict",
                secure: IS_PRODUCTION
            });

            res.json({
                success: true,
                message: "Logged out successfully."
            });
        });
    });

    // =====================================
    // HEALTH
    // =====================================

    app.get("/api/health", (req, res) => {
        res.json({
            success: true,
            message: "JD Poultry Farm backend is running!"
        });
    });

    // =====================================
    // HOMEPAGE SLIDESHOW
    // =====================================

    // Public: get slideshow images
    app.get("/api/slides", (req, res) => {
        const slides = getRows(
            db,
            `SELECT id, image_url, created_at
             FROM homepage_slides
             ORDER BY id DESC`
        );

        res.json(slides);
    });

    // Admin: upload slideshow image
    app.post(
        "/api/slides",
        requireAdmin,
        upload.single("image"),
        async (req, res) => {
            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: "Please select a slideshow image."
                });
            }

            let uploadedImage;

            try {
                uploadedImage = await uploadToCloudinary(
                    req.file,
                    "jd-poultry/slideshow"
                );

                db.run(
                    `INSERT INTO homepage_slides
                     (image_url, image_public_id)
                     VALUES (?, ?)`,
                    [
                        uploadedImage.secure_url,
                        uploadedImage.public_id
                    ]
                );

                saveDatabase();

                const slide = getRows(
                    db,
                    `SELECT id, image_url, created_at
                     FROM homepage_slides
                     WHERE id = last_insert_rowid()`
                )[0];

                res.status(201).json({
                    success: true,
                    message: "Slideshow image uploaded successfully.",
                    slide
                });

            } catch (error) {
                if (uploadedImage) {
                    await deleteCloudinaryImage(
                        uploadedImage.public_id
                    );
                }

                console.error("Slideshow upload error:", error);

                res.status(500).json({
                    success: false,
                    message: "Could not upload slideshow image."
                });
            }
        }
    );

    // Admin: delete slideshow image
    app.delete(
        "/api/slides/:id",
        requireAdmin,
        async (req, res) => {
            const id = Number(req.params.id);

            if (!Number.isSafeInteger(id) || id < 1) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid slide ID."
                });
            }

            const slides = getRows(
                db,
                `SELECT id, image_public_id
                 FROM homepage_slides
                 WHERE id = ?`,
                [id]
            );

            if (!slides.length) {
                return res.status(404).json({
                    success: false,
                    message: "Slideshow image not found."
                });
            }

            try {
                db.run(
                    "DELETE FROM homepage_slides WHERE id = ?",
                    [id]
                );

                saveDatabase();

                await deleteCloudinaryImage(
                    slides[0].image_public_id
                );

                res.json({
                    success: true,
                    message: "Slideshow image deleted."
                });

            } catch (error) {
                console.error("Slideshow delete error:", error);

                res.status(500).json({
                    success: false,
                    message: "Could not delete slideshow image."
                });
            }
        }
    );

    // =====================================
    // PRODUCTS
    // =====================================

    app.get("/api/products", (req, res) => {
        const isAdmin = req.session?.isAdmin === true;

        const products = getRows(
            db,
            isAdmin
                ? `SELECT id, name, price, stock, is_active, image_url
                   FROM products ORDER BY id`
                : `SELECT id, name, price, stock, image_url
                   FROM products
                   WHERE is_active = 1
                   ORDER BY id`
        );

        res.json(products);
    });

    // ADD PRODUCT
    app.post("/api/products", requireAdmin, (req, res) => {
        const { name, price, stock } = req.body || {};

        if (
            typeof name !== "string" ||
            name.trim().length < 2 ||
            name.trim().length > 100 ||
            !Number.isSafeInteger(price) ||
            price < 0 ||
            !Number.isSafeInteger(stock) ||
            stock < 0
        ) {
            return res.status(400).json({
                success: false,
                message: "Enter a valid name, price and stock."
            });
        }

        db.run(
            `INSERT INTO products (name, price, stock, is_active)
             VALUES (?, ?, ?, 1)`,
            [name.trim(), price, stock]
        );

        saveDatabase();

        const product = getRows(
            db,
            "SELECT * FROM products WHERE id = last_insert_rowid()"
        )[0];

        res.status(201).json({
            success: true,
            message: "Product added successfully.",
            product
        });
    });

    // UPDATE PRODUCT
    app.patch("/api/products/:id", requireAdmin, (req, res) => {
        const id = Number(req.params.id);
        const { name, price, stock } = req.body || {};

        if (
            !Number.isSafeInteger(id) ||
            id < 1 ||
            typeof name !== "string" ||
            name.trim().length < 2 ||
            name.trim().length > 100 ||
            !Number.isSafeInteger(price) ||
            price < 0 ||
            !Number.isSafeInteger(stock) ||
            stock < 0
        ) {
            return res.status(400).json({
                success: false,
                message: "Enter valid product details."
            });
        }

        const existing = getRows(
            db,
            "SELECT id FROM products WHERE id = ?",
            [id]
        );

        if (!existing.length) {
            return res.status(404).json({
                success: false,
                message: "Product not found."
            });
        }

        db.run(
            `UPDATE products
             SET name = ?, price = ?, stock = ?
             WHERE id = ?`,
            [name.trim(), price, stock, id]
        );

        saveDatabase();

        res.json({
            success: true,
            message: "Product updated successfully."
        });
    });

    // HIDE PRODUCT
    app.delete("/api/products/:id", requireAdmin, (req, res) => {
        const id = Number(req.params.id);

        if (!Number.isSafeInteger(id) || id < 1) {
            return res.status(400).json({
                success: false,
                message: "Invalid product ID."
            });
        }

        const existing = getRows(
            db,
            "SELECT id, is_active FROM products WHERE id = ?",
            [id]
        );

        if (!existing.length) {
            return res.status(404).json({
                success: false,
                message: "Product not found."
            });
        }

        if (existing[0].is_active === 0) {
            return res.status(400).json({
                success: false,
                message: "Product is already hidden."
            });
        }

        db.run(
            "UPDATE products SET is_active = 0 WHERE id = ?",
            [id]
        );

        saveDatabase();

        res.json({
            success: true,
            message: "Product hidden successfully."
        });
    });

    // RESTORE PRODUCT
    app.patch(
        "/api/products/:id/restore",
        requireAdmin,
        (req, res) => {
            const id = Number(req.params.id);

            if (!Number.isSafeInteger(id) || id < 1) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid product ID."
                });
            }

            const existing = getRows(
                db,
                "SELECT id FROM products WHERE id = ?",
                [id]
            );

            if (!existing.length) {
                return res.status(404).json({
                    success: false,
                    message: "Product not found."
                });
            }

            db.run(
                "UPDATE products SET is_active = 1 WHERE id = ?",
                [id]
            );

            saveDatabase();

            res.json({
                success: true,
                message: "Product restored successfully."
            });
        }
    );

    // UPDATE STOCK
    app.patch(
        "/api/products/:id/stock",
        requireAdmin,
        (req, res) => {
            const id = Number(req.params.id);
            const stock = req.body?.stock;

            if (
                !Number.isSafeInteger(id) ||
                id < 1 ||
                !Number.isSafeInteger(stock) ||
                stock < 0
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Enter a valid product ID and stock."
                });
            }

            const existing = getRows(
                db,
                "SELECT id FROM products WHERE id = ?",
                [id]
            );

            if (!existing.length) {
                return res.status(404).json({
                    success: false,
                    message: "Product not found."
                });
            }

            db.run(
                "UPDATE products SET stock = ? WHERE id = ?",
                [stock, id]
            );

            saveDatabase();

            res.json({
                success: true,
                message: "Stock updated successfully."
            });
        }
    );

    // UPLOAD PRODUCT IMAGE
    app.post(
        "/api/products/:id/image",
        requireAdmin,
        upload.single("image"),
        async (req, res) => {
            const id = Number(req.params.id);

            if (!Number.isSafeInteger(id) || id < 1) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid product ID."
                });
            }

            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: "Please select an image."
                });
            }

            const products = getRows(
                db,
                `SELECT id, image_public_id
                 FROM products WHERE id = ?`,
                [id]
            );

            if (!products.length) {
                return res.status(404).json({
                    success: false,
                    message: "Product not found."
                });
            }

            let uploadedImage;

            try {
                uploadedImage = await uploadToCloudinary(
                    req.file,
                    "jd-poultry/products"
                );

                db.run(
                    `UPDATE products
                     SET image_url = ?, image_public_id = ?
                     WHERE id = ?`,
                    [
                        uploadedImage.secure_url,
                        uploadedImage.public_id,
                        id
                    ]
                );

                saveDatabase();

                await deleteCloudinaryImage(
                    products[0].image_public_id
                );

                res.json({
                    success: true,
                    message: "Product image uploaded successfully.",
                    image_url: uploadedImage.secure_url
                });

            } catch (error) {
                if (uploadedImage) {
                    await deleteCloudinaryImage(
                        uploadedImage.public_id
                    );
                }

                console.error("Product image upload error:", error);

                res.status(500).json({
                    success: false,
                    message: "Could not upload product image."
                });
            }
        }
    );

    // REMOVE PRODUCT IMAGE
    app.delete(
        "/api/products/:id/image",
        requireAdmin,
        async (req, res) => {
            const id = Number(req.params.id);

            if (!Number.isSafeInteger(id) || id < 1) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid product ID."
                });
            }

            const products = getRows(
                db,
                `SELECT id, image_public_id
                 FROM products WHERE id = ?`,
                [id]
            );

            if (!products.length) {
                return res.status(404).json({
                    success: false,
                    message: "Product not found."
                });
            }

            try {
                db.run(
                    `UPDATE products
                     SET image_url = NULL, image_public_id = NULL
                     WHERE id = ?`,
                    [id]
                );

                saveDatabase();

                await deleteCloudinaryImage(
                    products[0].image_public_id
                );

                res.json({
                    success: true,
                    message: "Product image removed."
                });

            } catch (error) {
                console.error("Image removal error:", error);

                res.status(500).json({
                    success: false,
                    message: "Could not remove product image."
                });
            }
        }
    );

    // =====================================
    // WEBSITE LOGO
    // =====================================

    app.get("/api/site-settings/logo", (req, res) => {
        const result = getRows(
            db,
            `SELECT setting_value
             FROM site_settings
             WHERE setting_key = 'logo_url'`
        );

        res.json({
            success: true,
            logo_url: result.length
                ? result[0].setting_value
                : null
        });
    });

    // UPLOAD LOGO
    app.post(
        "/api/site-settings/logo",
        requireAdmin,
        upload.single("image"),
        async (req, res) => {
            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: "Please select a logo."
                });
            }

            let uploadedLogo;

            try {
                const oldLogo = getRows(
                    db,
                    `SELECT setting_value
                     FROM site_settings
                     WHERE setting_key = 'logo_public_id'`
                );

                uploadedLogo = await uploadToCloudinary(
                    req.file,
                    "jd-poultry/branding"
                );

                db.run(
                    `INSERT INTO site_settings
                     (setting_key, setting_value)
                     VALUES ('logo_url', ?)
                     ON CONFLICT(setting_key)
                     DO UPDATE SET setting_value = excluded.setting_value`,
                    [uploadedLogo.secure_url]
                );

                db.run(
                    `INSERT INTO site_settings
                     (setting_key, setting_value)
                     VALUES ('logo_public_id', ?)
                     ON CONFLICT(setting_key)
                     DO UPDATE SET setting_value = excluded.setting_value`,
                    [uploadedLogo.public_id]
                );

                saveDatabase();

                if (oldLogo.length) {
                    await deleteCloudinaryImage(
                        oldLogo[0].setting_value
                    );
                }

                res.json({
                    success: true,
                    message: "Website logo uploaded successfully.",
                    logo_url: uploadedLogo.secure_url
                });

            } catch (error) {
                if (uploadedLogo) {
                    await deleteCloudinaryImage(
                        uploadedLogo.public_id
                    );
                }

                console.error("Logo upload error:", error);

                res.status(500).json({
                    success: false,
                    message: "Could not upload website logo."
                });
            }
        }
    );

    // REMOVE LOGO
    app.delete(
        "/api/site-settings/logo",
        requireAdmin,
        async (req, res) => {
            try {
                const oldLogo = getRows(
                    db,
                    `SELECT setting_value
                     FROM site_settings
                     WHERE setting_key = 'logo_public_id'`
                );

                db.run(
                    `DELETE FROM site_settings
                     WHERE setting_key IN ('logo_url', 'logo_public_id')`
                );

                saveDatabase();

                if (oldLogo.length) {
                    await deleteCloudinaryImage(
                        oldLogo[0].setting_value
                    );
                }

                res.json({
                    success: true,
                    message: "Website logo removed."
                });

            } catch (error) {
                console.error("Logo removal error:", error);

                res.status(500).json({
                    success: false,
                    message: "Could not remove logo."
                });
            }
        }
    );

    // =====================================
    // CUSTOMER ORDERS
    // =====================================

    app.post("/api/orders", (req, res) => {
        const {
            customer_name,
            phone,
            notes,
            items
        } = req.body || {};

        if (
            typeof customer_name !== "string" ||
            customer_name.trim().length < 2 ||
            customer_name.trim().length > 100
        ) {
            return res.status(400).json({
                success: false,
                message: "Enter a valid customer name."
            });
        }

        if (
            typeof phone !== "string" ||
            !/^\+?[0-9\s-]{9,16}$/.test(phone.trim())
        ) {
            return res.status(400).json({
                success: false,
                message: "Enter a valid phone number."
            });
        }

        if (
            !Array.isArray(items) ||
            items.length < 1 ||
            items.length > 50
        ) {
            return res.status(400).json({
                success: false,
                message: "Select at least one product."
            });
        }

        if (
            notes !== undefined &&
            (typeof notes !== "string" || notes.length > 500)
        ) {
            return res.status(400).json({
                success: false,
                message: "Order notes are too long or invalid."
            });
        }

        const seenIds = new Set();
        const preparedItems = [];
        let grandTotal = 0;

        for (const item of items) {
            if (
                !item ||
                !Number.isSafeInteger(item.product_id) ||
                item.product_id < 1 ||
                !Number.isSafeInteger(item.quantity) ||
                item.quantity < 1 ||
                item.quantity > 10000 ||
                seenIds.has(item.product_id)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "One or more product selections are invalid."
                });
            }

            seenIds.add(item.product_id);

            const found = getRows(
                db,
                `SELECT id, name, price, stock
                 FROM products
                 WHERE id = ? AND is_active = 1`,
                [item.product_id]
            );

            if (!found.length) {
                return res.status(404).json({
                    success: false,
                    message: "Product not found or unavailable."
                });
            }

            const product = found[0];

            if (product.stock < item.quantity) {
                return res.status(400).json({
                    success: false,
                    message: `${product.name}: only ${product.stock} units are available.`
                });
            }

            const lineTotal = product.price * item.quantity;

            if (!Number.isSafeInteger(lineTotal)) {
                return res.status(400).json({
                    success: false,
                    message: "A product total is too large."
                });
            }

            grandTotal += lineTotal;

            if (!Number.isSafeInteger(grandTotal)) {
                return res.status(400).json({
                    success: false,
                    message: "Order total is too large."
                });
            }

            preparedItems.push({
                product_id: product.id,
                product_name: product.name,
                quantity: item.quantity,
                unit_price: product.price,
                total_price: lineTotal
            });
        }

        try {
            db.run("BEGIN TRANSACTION");

            const firstItem = preparedItems[0];

            // Write both total and total_price for compatibility
            // with the older database structure.
            db.run(
                `INSERT INTO orders
                 (customer_name, phone, product_id, product_name,
                  quantity, unit_price, total_price, total, notes, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending')`,
                [
                    customer_name.trim(),
                    phone.trim(),
                    firstItem.product_id,
                    firstItem.product_name,
                    firstItem.quantity,
                    firstItem.unit_price,
                    grandTotal,
                    grandTotal,
                    (notes || "").trim()
                ]
            );

            const orderId = getLastInsertId(db);

            for (const item of preparedItems) {
                // Write legacy price as well as the newer columns.
                db.run(
                    `INSERT INTO order_items
                     (order_id, product_id, product_name,
                      quantity, price, unit_price, total_price)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        orderId,
                        item.product_id,
                        item.product_name,
                        item.quantity,
                        item.unit_price,
                        item.unit_price,
                        item.total_price
                    ]
                );

                db.run(
                    `UPDATE products
                     SET stock = stock - ?
                     WHERE id = ?
                       AND stock >= ?
                       AND is_active = 1`,
                    [
                        item.quantity,
                        item.product_id,
                        item.quantity
                    ]
                );

                if (db.getRowsModified() !== 1) {
                    throw new Error(
                        `Stock changed for ${item.product_name}. Please try again.`
                    );
                }
            }

            db.run("COMMIT");
            saveDatabase();

            res.status(201).json({
                success: true,
                message: "Your order was received successfully.",
                order_id: orderId,
                items: preparedItems,
                total_price: grandTotal,
                status: "Pending"
            });

        } catch (error) {
            try {
                db.run("ROLLBACK");
            } catch (rollbackError) {
                console.error("Rollback error:", rollbackError);
            }

            console.error("Order error:", error);

            res.status(500).json({
                success: false,
                message: error.message.includes("Stock changed")
                    ? error.message
                    : "Could not save your order."
            });
        }
    });

    // =====================================
    // ADMIN VIEW ORDERS
    // =====================================

    app.get("/api/orders", requireAdmin, (req, res) => {
        const orders = getRows(
            db,
            `SELECT id, customer_name, phone, product_id,
                    product_name, quantity, unit_price,
                    total_price, notes, status, created_at
             FROM orders
             ORDER BY id DESC`
        );

        const result = orders.map(order => {
            let items = getRows(
                db,
                `SELECT product_id, product_name, quantity,
                        unit_price, total_price
                 FROM order_items
                 WHERE order_id = ?`,
                [order.id]
            );

            if (items.length === 0) {
                items = [{
                    product_id: order.product_id,
                    product_name: order.product_name,
                    quantity: order.quantity,
                    unit_price: order.unit_price,
                    total_price: order.total_price
                }];
            }

            return { ...order, items };
        });

        res.json(result);
    });

    // =====================================
    // SALES REPORT
    // =====================================

    app.get("/api/reports/sales", requireAdmin, (req, res) => {
        try {
            const orders = getRows(
                db,
                `SELECT id, total_price, status, created_at,
                        product_id, product_name, quantity
                 FROM orders ORDER BY id DESC`
            );

            const completedOrders = orders.filter(
                order => order.status === "Completed"
            );

            const pendingOrders = orders.filter(
                order => order.status === "Pending"
            );

            const confirmedOrders = orders.filter(
                order => order.status === "Confirmed"
            );

            const cancelledOrders = orders.filter(
                order => order.status === "Cancelled"
            );

            const totalSales = completedOrders.reduce(
                (sum, order) =>
                    sum + Number(order.total_price || 0),
                0
            );

            const dailySalesMap = {};
            const monthlySalesMap = {};
            const productSalesMap = {};

            for (const order of completedOrders) {
                const date = String(
                    order.created_at || ""
                ).slice(0, 10);

                const month = date.slice(0, 7);

                if (date.length === 10) {
                    dailySalesMap[date] =
                        (dailySalesMap[date] || 0) +
                        Number(order.total_price || 0);

                    monthlySalesMap[month] =
                        (monthlySalesMap[month] || 0) +
                        Number(order.total_price || 0);
                }

                let items = getRows(
                    db,
                    `SELECT product_id, product_name,
                            quantity, total_price
                     FROM order_items
                     WHERE order_id = ?`,
                    [order.id]
                );

                if (items.length === 0) {
                    items = [{
                        product_id: order.product_id,
                        product_name: order.product_name,
                        quantity: order.quantity,
                        total_price: order.total_price
                    }];
                }

                for (const item of items) {
                    const key =
                        item.product_id || item.product_name;

                    if (!productSalesMap[key]) {
                        productSalesMap[key] = {
                            product_id: item.product_id,
                            product_name: item.product_name,
                            quantity_sold: 0,
                            revenue: 0
                        };
                    }

                    productSalesMap[key].quantity_sold +=
                        Number(item.quantity || 0);

                    productSalesMap[key].revenue +=
                        Number(item.total_price || 0);
                }
            }

            const bestSellingProducts =
                Object.values(productSalesMap).sort(
                    (a, b) => b.quantity_sold - a.quantity_sold
                );

            const dailySales = Object.entries(dailySalesMap)
                .map(([date, sales]) => ({ date, sales }))
                .sort((a, b) => a.date.localeCompare(b.date));

            const monthlySales = Object.entries(monthlySalesMap)
                .map(([month, sales]) => ({ month, sales }))
                .sort((a, b) => a.month.localeCompare(b.month));

            res.json({
                success: true,
                summary: {
                    total_sales: totalSales,
                    total_orders: orders.length,
                    completed_orders: completedOrders.length,
                    pending_orders: pendingOrders.length,
                    confirmed_orders: confirmedOrders.length,
                    cancelled_orders: cancelledOrders.length
                },
                best_selling_products: bestSellingProducts,
                daily_sales: dailySales,
                monthly_sales: monthlySales
            });

        } catch (error) {
            console.error("Sales report error:", error);

            res.status(500).json({
                success: false,
                message: "Could not load sales report."
            });
        }
    });

    // =====================================
    // UPDATE ORDER STATUS
    // =====================================

    app.patch(
        "/api/orders/:id/status",
        requireAdmin,
        (req, res) => {
            const id = Number(req.params.id);
            const newStatus = req.body?.status;

            const allowedStatuses = [
                "Confirmed",
                "Completed",
                "Cancelled"
            ];

            if (
                !Number.isSafeInteger(id) ||
                id < 1 ||
                !allowedStatuses.includes(newStatus)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid order ID or status."
                });
            }

            const orders = getRows(
                db,
                "SELECT * FROM orders WHERE id = ?",
                [id]
            );

            if (!orders.length) {
                return res.status(404).json({
                    success: false,
                    message: "Order not found."
                });
            }

            const order = orders[0];

            const validTransition =
                (
                    order.status === "Pending" &&
                    ["Confirmed", "Cancelled"].includes(newStatus)
                ) ||
                (
                    order.status === "Confirmed" &&
                    ["Completed", "Cancelled"].includes(newStatus)
                );

            if (!validTransition) {
                return res.status(400).json({
                    success: false,
                    message: "This status change is not allowed."
                });
            }

            try {
                db.run("BEGIN TRANSACTION");

                if (newStatus === "Cancelled") {
                    let items = getRows(
                        db,
                        `SELECT product_id, quantity
                         FROM order_items
                         WHERE order_id = ?`,
                        [id]
                    );

                    if (items.length === 0) {
                        items = [{
                            product_id: order.product_id,
                            quantity: order.quantity
                        }];
                    }

                    for (const item of items) {
                        if (item.product_id) {
                            db.run(
                                `UPDATE products
                                 SET stock = stock + ?
                                 WHERE id = ?`,
                                [item.quantity, item.product_id]
                            );
                        }
                    }
                }

                db.run(
                    "UPDATE orders SET status = ? WHERE id = ?",
                    [newStatus, id]
                );

                db.run("COMMIT");
                saveDatabase();

                res.json({
                    success: true,
                    message: "Order status updated.",
                    status: newStatus
                });

            } catch (error) {
                try {
                    db.run("ROLLBACK");
                } catch (rollbackError) {
                    console.error("Rollback error:", rollbackError);
                }

                console.error("Order status error:", error);

                res.status(500).json({
                    success: false,
                    message: "Could not update order status."
                });
            }
        }
    );

    // =====================================
    // WEBSITE PAGES
    // =====================================

    app.get("/", (req, res) => {
        res.sendFile(path.join(__dirname, "index.html"));
    });

    app.get("/login.html", (req, res) => {
        res.sendFile(path.join(__dirname, "login.html"));
    });

    app.get("/order.html", (req, res) => {
        res.sendFile(path.join(__dirname, "order.html"));
    });

    app.get("/admin.html", requireAdmin, (req, res) => {
        res.sendFile(path.join(__dirname, "admin.html"));
    });

        // =====================================
    // FRONTEND ASSETS
    // =====================================

    app.get("/style.css", (req, res) => {
        res.sendFile(path.join(__dirname, "style.css"));
    });

    app.get("/script.js", (req, res) => {
        res.sendFile(path.join(__dirname, "script.js"));
    });

    // =====================================
    // PWA FILES
    // =====================================

    app.get("/manifest.json", (req, res) => {
        res.setHeader("Content-Type", "application/manifest+json");
        res.setHeader("Cache-Control", "no-cache");
        res.sendFile(path.join(__dirname, "manifest.json"));
    });

    app.get("/service-worker.js", (req, res) => {
        res.setHeader("Content-Type", "application/javascript");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Service-Worker-Allowed", "/");
        res.sendFile(path.join(__dirname, "service-worker.js"));
    });

    app.get("/icons/icon-512.png", (req, res) => {
        res.sendFile(
            path.join(__dirname, "icons", "icon-512.png")
        );
    });
    // =====================================
    // GLOBAL ERROR HANDLER
    // =====================================

    app.use((error, req, res, next) => {
        console.error("Server error:", error);

        if (res.headersSent) {
            return next(error);
        }

        if (error instanceof multer.MulterError) {
            return res.status(400).json({
                success: false,
                message: error.code === "LIMIT_FILE_SIZE"
                    ? "Image must be 5MB or smaller."
                    : "Image upload error."
            });
        }

        if (
            error.message &&
            error.message.startsWith("Only JPG")
        ) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }

        res.status(500).json({
            success: false,
            message: "An unexpected server error occurred."
        });
    });

    // =====================================
    // START LISTENING
    // =====================================

    app.listen(PORT, () => {
        console.log("------------------------------------");
        console.log("JD POULTRY FARM SERVER");
        console.log("------------------------------------");
        console.log(`Website: http://localhost:${PORT}`);
        console.log(`Admin:   http://localhost:${PORT}/admin.html`);
        console.log("Backend is ready.");
        console.log("------------------------------------");
    });
}

startServer().catch(error => {
    console.error("Could not start JD Poultry server:", error);
    process.exit(1);
});
