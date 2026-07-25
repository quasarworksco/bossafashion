// Vercel Serverless Function — POST /api/stripe-webhook
//
// Receives Stripe events after payment. Verifies the signature (security),
// then updates the Firestore order to "pagado" or "expirado".
//
// Environment variables to set in Vercel dashboard:
//   STRIPE_SECRET_KEY      — sk_live_...
//   STRIPE_WEBHOOK_SECRET  — whsec_... (from Stripe dashboard → Webhooks)
//   FIREBASE_PROJECT_ID    — bossa-fashion
//   FIREBASE_CLIENT_EMAIL  — from Firebase service account JSON
//   FIREBASE_PRIVATE_KEY   — from Firebase service account JSON (keep \n escapes)

const Stripe = require("stripe");
const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

// Init Firebase Admin once (Vercel reuses the runtime between calls)
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

// Vercel must receive the raw body to verify the Stripe signature
export const config = {
  api: { bodyParser: false },
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const rawBody = await getRawBody(req);
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const session = event.data.object;
  const orderNum = session.metadata?.orderNum;

  if (event.type === "checkout.session.completed" && orderNum) {
    const shipping = session.shipping_details?.address;
    await db.collection("orders").doc(orderNum).set(
      {
        estado: "pagado",
        pago: "Stripe",
        stripePaymentIntent: session.payment_intent || null,
        stripeSessionId: session.id,
        stripeCustomerEmail: session.customer_details?.email || null,
        stripeCustomerPhone: session.customer_details?.phone || null,
        stripeShipping: shipping
          ? `${shipping.line1}${shipping.line2 ? ", " + shipping.line2 : ""}, ${shipping.city}, ${shipping.state} ${shipping.postal_code}`
          : null,
        paidAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    console.log(`✅ Order ${orderNum} marcado como pagado`);
  }

  if (event.type === "checkout.session.expired" && orderNum) {
    await db.collection("orders").doc(orderNum).set(
      { estado: "expirado" },
      { merge: true }
    );
    console.log(`⏰ Order ${orderNum} expirado`);
  }

  return res.status(200).json({ received: true });
};
