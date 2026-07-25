// Vercel Serverless Function — POST /api/create-checkout-session
//
// Creates a Stripe Hosted Checkout session and returns the redirect URL.
// The Stripe secret key lives only here (server-side), never exposed to the browser.
//
// Environment variables to set in Vercel dashboard:
//   STRIPE_SECRET_KEY   — sk_live_... (or sk_test_... for testing)
//   SITE_URL            — https://bossafashion.dgp-link.com (no trailing slash)

const Stripe = require("stripe");

module.exports = async function handler(req, res) {
  // CORS — allow requests from your own domain
  res.setHeader("Access-Control-Allow-Origin", process.env.SITE_URL || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { items, orderNum, customerEmail } = req.body;

  if (!items?.length || !orderNum) {
    return res.status(400).json({ error: "items y orderNum son requeridos" });
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const siteUrl = process.env.SITE_URL || "https://bossafashion.dgp-link.com";

  // Build Stripe line_items from the cart
  const lineItems = items.map((item) => {
    const unitPrice = Number(item.precioOferta || item.precio || 0);
    const description = [
      item.talla && `Talla: ${item.talla}`,
      item.color && `Color: ${item.color}`,
    ]
      .filter(Boolean)
      .join(" · ");

    return {
      price_data: {
        currency: "usd",
        product_data: {
          name: item.nombre,
          ...(description && { description }),
          ...(item.imagen && { images: [item.imagen] }),
        },
        unit_amount: Math.round(unitPrice * 100), // Stripe uses cents
      },
      quantity: item.qty || 1,
    };
  });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card", "link"], // link = Stripe Link (saved cards)
      line_items: lineItems,
      mode: "payment",
      locale: "es",
      ...(customerEmail && { customer_email: customerEmail }),
      metadata: { orderNum }, // passed back in webhook
      shipping_address_collection: { allowed_countries: ["US"] },
      phone_number_collection: { enabled: true },
      success_url: `${siteUrl}?pago=ok&order=${orderNum}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${siteUrl}?pago=cancelado`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("Stripe createCheckoutSession error:", err);
    return res.status(500).json({ error: err.message });
  }
};
