// POST /api/create-checkout-session
//
// Creates a Stripe Hosted Checkout session server-side.
// Prices are NEVER trusted from the client — they are fetched from Firestore.
//
// Env vars (set in Vercel Dashboard → Settings → Environment Variables):
//   STRIPE_SECRET_KEY   — sk_live_... (or sk_test_... for testing)
//   SITE_URL            — https://bossafashion.dgp-link.com (no trailing slash)
//   FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY

const Stripe = require("stripe");
const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

// Init Firebase Admin once (Vercel reuses the runtime between invocations)
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}
const db = getFirestore();

// Strict CORS — only allow requests from your own domain
const ALLOWED_ORIGIN = process.env.SITE_URL || "";

function setCors(req, res) {
  const origin = req.headers.origin || "";
  // In production, block anything not from your domain
  if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  } else if (!ALLOWED_ORIGIN) {
    // Dev fallback — allow all only when SITE_URL is not set
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // ── Input validation ──
  const { items, orderNum, customerEmail } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items requerido" });
  }
  if (items.length > 50) {
    return res.status(400).json({ error: "Demasiados productos en el carrito" });
  }
  if (!orderNum || typeof orderNum !== "string" || !/^BF-\d{6}-\d{4}$/.test(orderNum)) {
    return res.status(400).json({ error: "orderNum inválido" });
  }
  if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    return res.status(400).json({ error: "Email inválido" });
  }

  // ── Fetch authoritative prices from Firestore (never trust client prices) ──
  let lineItems;
  try {
    const productIds = [...new Set(items.map((i) => i.id).filter(Boolean))];

    // Batch-fetch all referenced products
    const productDocs = await Promise.all(
      productIds.map((id) => db.collection("products").doc(id).get())
    );
    const productMap = {};
    productDocs.forEach((doc) => {
      if (doc.exists) productMap[doc.id] = doc.data();
    });

    lineItems = items.map((item) => {
      const qty = Math.max(1, Math.min(99, Math.floor(Number(item.qty) || 1)));
      const product = productMap[item.id];

      // If product found in Firestore, use server-side price; otherwise reject
      if (!product) {
        throw new Error(`Producto no encontrado: ${item.id}`);
      }
      if (product.estado !== "Activo") {
        throw new Error(`Producto no disponible: ${product.nombre}`);
      }

      const unitPrice = Number(product.precioOferta || product.precio || 0);
      if (unitPrice <= 0) {
        throw new Error(`Precio inválido para: ${product.nombre}`);
      }

      const talla = typeof item.talla === "string" ? item.talla.slice(0, 20) : null;
      const color = typeof item.color === "string" ? item.color.slice(0, 40) : null;
      const description = [talla && `Talla: ${talla}`, color && `Color: ${color}`]
        .filter(Boolean)
        .join(" · ") || undefined;

      return {
        price_data: {
          currency: "usd",
          product_data: {
            name: String(product.nombre).slice(0, 127),
            ...(description && { description }),
            ...(product.imagen && { images: [product.imagen] }),
          },
          unit_amount: Math.round(unitPrice * 100),
        },
        quantity: qty,
      };
    });
  } catch (err) {
    console.error("Price validation error:", err.message);
    return res.status(400).json({ error: err.message });
  }

  // ── Create Stripe Checkout Session ──
  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const siteUrl = process.env.SITE_URL || "https://bossafashion.dgp-link.com";

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card", "link"],
      line_items: lineItems,
      mode: "payment",
      locale: "es",
      ...(customerEmail && { customer_email: customerEmail }),
      metadata: { orderNum },
      shipping_address_collection: { allowed_countries: ["US"] },
      phone_number_collection: { enabled: true },
      // After payment, Stripe redirects here
      success_url: `${siteUrl}?pago=ok&order=${encodeURIComponent(orderNum)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${siteUrl}?pago=cancelado`,
      // Session expires in 30 minutes
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    });

    // Pre-create the Firestore order record so admin can see "pending" immediately
    const totalUsd = lineItems.reduce(
      (s, li) => s + (li.price_data.unit_amount / 100) * li.quantity, 0
    );
    await db.collection("orders").doc(orderNum).set({
      orderNum,
      estado: "pendiente_pago",
      productos: items.map((i) => ({
        id: i.id || "", nombre: i.nombre || "", qty: i.qty || 1,
        talla: i.talla || null, color: i.color || null,
      })),
      total: parseFloat(totalUsd.toFixed(2)),
      pago: "Stripe",
      stripeSessionId: session.id,
      createdAt: require("firebase-admin/firestore").FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("Stripe session error:", err);
    return res.status(500).json({ error: "Error al crear sesión de pago" });
  }
};
