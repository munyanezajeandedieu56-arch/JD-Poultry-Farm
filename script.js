
"use strict";

// ==========================================
// JD POULTRY FARM - MAIN WEBSITE JAVASCRIPT
// ==========================================

const WHATSAPP_NUMBER = "250794548019";
const API_URL = "/api/products";
const LOGO_API_URL = "/api/site-settings/logo";

const DEFAULT_PRODUCT_IMAGE =
    "https://images.unsplash.com/photo-1548550023-2bdb3c5beed7?auto=format&fit=crop&w=700&q=80";

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function formatRWF(amount) {
    return Number(amount || 0).toLocaleString("en-US") + " RWF";
}

function getQuantity(input) {
    const quantity = Number.parseInt(input.value, 10);

    if (!Number.isFinite(quantity) || quantity < 1) return 1;

    const maximum = Number(input.max) || 1000;

    return Math.min(quantity, maximum);
}

function getImageUrl(product) {
    return product.image_url ||
        product.imageUrl ||
        DEFAULT_PRODUCT_IMAGE;
}

// ==========================================
// LOAD FARM LOGO
// ==========================================

async function loadFarmLogo() {
    const logo = document.getElementById("siteLogo");
    const fallback = document.getElementById("brandFallback");

    if (!logo) return;

    try {
        const response = await fetch(LOGO_API_URL, {
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error("Could not load farm logo.");
        }

        const data = await response.json();

        // Supports either a URL string or an object response.
        const logoUrl = typeof data === "string"
            ? data
            : data.logo_url || data.image_url || data.url || data.logo;

        if (!logoUrl) {
            logo.hidden = true;
            if (fallback) fallback.hidden = false;
            return;
        }

        logo.onload = () => {
            logo.hidden = false;
            if (fallback) fallback.hidden = true;
        };

        logo.onerror = () => {
            logo.hidden = true;
            if (fallback) fallback.hidden = false;
        };

        logo.src = logoUrl;

    } catch (error) {
        console.error("Farm logo loading error:", error);

        logo.hidden = true;
        if (fallback) fallback.hidden = false;
    }
}

// ==========================================
// LOAD PRODUCTS FROM DATABASE
// ==========================================

async function loadProducts() {
    const section = document.getElementById("products");

    if (!section) return;

    let container = document.getElementById("product-list");

    if (!container) {
        container = document.createElement("div");
        container.id = "product-list";
        container.className = "product-grid";
        section.appendChild(container);
    }

    container.textContent = "Loading products...";

    try {
        const response = await fetch(API_URL, {
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error("Could not load products.");
        }

        const products = await response.json();

        container.replaceChildren();

        if (!Array.isArray(products) || products.length === 0) {
            container.textContent =
                "No products available at the moment.";
            return;
        }

        products.forEach(product => {
            const card = document.createElement("div");
            card.className = "product-card";

            // PRODUCT IMAGE
            const image = document.createElement("img");
            image.className = "product-image";
            image.src = getImageUrl(product);
            image.alt = product.name
                ? product.name + " - JD Poultry Farm"
                : "JD Poultry Farm product";
            image.loading = "lazy";

            image.onerror = () => {
                image.onerror = null;
                image.src = DEFAULT_PRODUCT_IMAGE;
            };

            // PRODUCT NAME
            const name = document.createElement("h3");
            name.textContent = product.name || "Farm Product";

            // PRODUCT PRICE
            const price = document.createElement("p");
            price.className = "product-price";
            price.textContent = formatRWF(product.price);

            // STOCK
            const stock = document.createElement("p");
            stock.className = "product-stock";

            const availableStock = Math.max(
                0,
                Number(product.stock || 0)
            );

            stock.textContent = availableStock > 0
                ? "Available: " + availableStock
                : "Out of stock";

            // QUANTITY LABEL
            const quantityLabel = document.createElement("label");
            quantityLabel.textContent = "Quantity";

            // QUANTITY INPUT
            const quantity = document.createElement("input");
            quantity.type = "number";
            quantity.min = "1";
            quantity.max = String(availableStock);
            quantity.value = "1";
            quantity.className = "product-quantity";
            quantity.disabled = availableStock <= 0;

            // TOTAL PRICE
            const total = document.createElement("p");
            total.className = "product-total";
            total.textContent =
                "Total: " + formatRWF(product.price);

            quantity.addEventListener("input", () => {
                const qty = getQuantity(quantity);

                total.textContent =
                    "Total: " +
                    formatRWF(qty * Number(product.price));
            });

            quantity.addEventListener("change", () => {
                quantity.value = String(getQuantity(quantity));

                total.textContent =
                    "Total: " +
                    formatRWF(
                        getQuantity(quantity) * Number(product.price)
                    );
            });

            // WHATSAPP ORDER BUTTON
            const button = document.createElement("button");
            button.type = "button";
            button.className = "order-button";

            button.textContent = availableStock > 0
                ? "Order on WhatsApp"
                : "Out of Stock";

            button.disabled = availableStock <= 0;

            button.addEventListener("click", () => {
                orderProduct(product, quantity);
            });

            // BUILD PRODUCT CARD
            card.appendChild(image);
            card.appendChild(name);
            card.appendChild(price);
            card.appendChild(stock);
            card.appendChild(quantityLabel);
            card.appendChild(quantity);
            card.appendChild(total);
            card.appendChild(button);

            container.appendChild(card);
        });

    } catch (error) {
        container.textContent =
            "Unable to load products. Please try again later.";

        console.error("Product loading error:", error);
    }
}

// ==========================================
// WHATSAPP PRODUCT ORDER
// ==========================================

function orderProduct(product, input) {
    const quantity = getQuantity(input);
    const stock = Number(product.stock || 0);

    if (quantity > stock) {
        alert(
            "Sorry, the available stock is only " + stock + "."
        );
        return;
    }

    const price = Number(product.price);
    const total = price * quantity;

    const message = [
        "Hello JD Poultry Farm!",
        "",
        "I would like to place an order:",
        "Product: " + product.name,
        "Quantity: " + quantity,
        "Unit price: " + formatRWF(price),
        "Estimated total: " + formatRWF(total),
        "",
        "Please confirm availability. Thank you!"
    ].join("\n");

    const url =
        "https://wa.me/" +
        WHATSAPP_NUMBER +
        "?text=" +
        encodeURIComponent(message);

    window.open(url, "_blank", "noopener,noreferrer");
}

// ==========================================
// COPYRIGHT YEAR
// ==========================================

function updateCopyrightYear() {
    const yearElement = document.getElementById("year");

    if (yearElement) {
        yearElement.textContent =
            new Date().getFullYear();
    }
}

// ==========================================
// SECTION SWITCHING
// ==========================================

const views = {
    home: [
        document.querySelector(".hero"),
        document.querySelector(".benefits")
    ],

    products: [
        document.getElementById("products")
    ],

    about: [
        document.getElementById("about")
    ],

    contact: [
        document.getElementById("contact")
    ]
};

function showView(viewName, updateAddress = true) {
    if (!views[viewName]) {
        viewName = "home";
    }

    Object.values(views).flat().forEach(section => {
        if (!section) return;

        section.classList.remove("view-enter");
        section.classList.add("view-hidden");
    });

    views[viewName].forEach(section => {
        if (!section) return;

        section.classList.remove("view-hidden");

        void section.offsetWidth;

        section.classList.add("view-enter");
    });

    document.querySelectorAll(".navigation a").forEach(link => {
        const active =
            link.getAttribute("href") === "#" + viewName;

        link.classList.toggle("active", active);

        if (active) {
            link.setAttribute("aria-current", "page");
        } else {
            link.removeAttribute("aria-current");
        }
    });

    if (updateAddress) {
        history.pushState(
            { view: viewName },
            "",
            "#" + viewName
        );
    }

    window.scrollTo({
        top: 0,
        behavior: "instant"
    });
}

// ==========================================
// NAVIGATION LINKS
// ==========================================

document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener("click", event => {
        const viewName =
            link.getAttribute("href").substring(1);

        if (!views[viewName]) return;

        event.preventDefault();

        showView(viewName);
    });
});

// ==========================================
// BROWSER BACK AND FORWARD
// ==========================================

window.addEventListener("popstate", () => {
    const viewName =
        location.hash.substring(1) || "home";

    showView(viewName, false);
});

// ==========================================
// INITIALIZE WEBSITE
// ==========================================

document.addEventListener("DOMContentLoaded", async () => {
    const initialView =
        location.hash.substring(1) || "home";

    showView(initialView, false);

    updateCopyrightYear();

    await Promise.all([
        loadFarmLogo(),
        loadProducts()
    ]);

    console.log(
        "JD Poultry Farm website loaded successfully."
    );
});
