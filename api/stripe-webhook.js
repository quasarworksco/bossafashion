// POST /api/stripe-webhook
//
// Receives Stripe events, verifies the signature (prevents spoofing),
// and updates Firestore order status accordingly.
//
// IMPORTANT: bodyParser must be disabled so we receive the raw body
// needed for Stripe signature verification.
//
// Env vars:
//   STRIPE_SECRET_KEY      — sk_live_...
//   STRIPE_WEBHOOK_SECRET  — whsec_... (from Stripe Dashboard → Webhooks)
//   FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY

const Stripe = require("stripe");
const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

// ── Disable Vercel body parser — Stripe needs the raw bytes to verify ──
// This must be a named export on the handler function (CommonJS compatible)
const handler = async function (req, res) {
  if (req.method !== "POST") return res.status(405).end();

  // Init Firebase Admin once per runtime
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

  // ── Read raw body from stream ──
  const rawBody = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

  // ── Verify Stripe signature (security: proves event is from Stripe) ──
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    // Invalid signature — reject immediately
    console.error("Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ── Handle events ──
  const session = event.data.object;
  const orderNum = session.metadata?.orderNum;

  if (event.type === "checkout.session.completed") {
    if (!orderNum) {
      console.warn("checkout.session.completed received without orderNum metadata");
      return res.status(200).json({ received: true });
    }

    const shipping = session.shipping_details?.address;
    const shippingStr = shipping
      ? [shipping.line1, shipping.line2, shipping.city, shipping.state, shipping.postal_code]
          .filter(Boolean).join(", ")
      : null;

    await db.collection("orders").doc(orderNum).set(
      {
        estado: "pagado",
        pago: "Stripe",
        stripePaymentIntent: session.payment_intent || null,
        stripeSessionId: session.id,
        stripeCustomerEmail: session.customer_details?.email || null,
        stripeCustomerPhone: session.customer_details?.phone || null,
        stripeShipping: shippingStr,
        nombre: session.customer_details?.name || null,
        paidAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    console.log(`✅ Order ${orderNum} marked as pagado`);
  }

  if (event.type === "checkout.session.expired") {
    if (orderNum) {
      await db.collection("orders").doc(orderNum).set(
        { estado: "expirado", expiredAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
      console.log(`⏰ Order ${orderNum} expired`);
    }
  }

  if (event.type === "payment_intent.payment_failed") {
    // payment_intent.metadata doesn't have orderNum, look it up via session
    console.warn("Payment failed for intent:", session.id);
  }

  return res.status(200).json({ received: true });
};

// Tell Vercel NOT to parse the body — must be set before module.exports
handler.config = { api: { bodyParser: false } };

module.exports = handler;
