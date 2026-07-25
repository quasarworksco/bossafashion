# Integración Stripe — Pasos para activar

## Costo total: $0 (solo pagas la comisión de Stripe por venta: 2.9% + $0.30)

---

## 1. Crear cuenta Stripe
- Ve a https://stripe.com → Sign up
- Completa la verificación de identidad y datos del negocio
- Tendrás acceso a **modo test** (tarjetas falsas) y **modo live** (real)

---

## 2. Obtener tus claves Stripe

En Stripe Dashboard → Developers → API Keys:

| Clave                | Dónde va            |
|----------------------|---------------------|
| `sk_live_...`        | Vercel (secret)     |
| `pk_live_...`        | No se usa aquí      |
| `whsec_...` (webhook)| Vercel (secret)     |

---

## 3. Obtener credenciales Firebase Admin

Para que el webhook pueda escribir en Firestore:

1. Firebase Console → Project Settings → Service Accounts
2. Click "Generate new private key" → descarga el JSON
3. Del JSON necesitas:
   - `project_id` → `FIREBASE_PROJECT_ID`
   - `client_email` → `FIREBASE_CLIENT_EMAIL`
   - `private_key` → `FIREBASE_PRIVATE_KEY`

---

## 4. Desplegar en Vercel (gratis)

```bash
# Instalar CLI de Vercel
npm i -g vercel

# Desde la carpeta del proyecto
cd /ruta/a/bossafashion
vercel

# Seguir las instrucciones, elegir el proyecto existente o crear uno nuevo
```

O conecta el repositorio de GitHub desde https://vercel.com/new

---

## 5. Configurar variables de entorno en Vercel

En Vercel Dashboard → tu proyecto → Settings → Environment Variables:

```
STRIPE_SECRET_KEY      = sk_live_TU_CLAVE_AQUI
STRIPE_WEBHOOK_SECRET  = whsec_TU_SECRET_AQUI
FIREBASE_PROJECT_ID    = bossa-fashion
FIREBASE_CLIENT_EMAIL  = firebase-adminsdk-xxx@bossa-fashion.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY   = -----BEGIN RSA PRIVATE KEY-----\n...
SITE_URL               = https://bossafashion.dgp-link.com
```

> ⚠️ `FIREBASE_PRIVATE_KEY`: copia exactamente como aparece en el JSON, con los `\n` literales.

---

## 6. Configurar el Webhook en Stripe

1. Stripe Dashboard → Developers → Webhooks → Add endpoint
2. URL: `https://TU-PROYECTO.vercel.app/api/stripe-webhook`
3. Eventos a escuchar:
   - `checkout.session.completed`
   - `checkout.session.expired`
4. Copia el **Signing secret** (`whsec_...`) y ponlo en `STRIPE_WEBHOOK_SECRET`

---

## 7. Probar con tarjeta de prueba

En modo test, usa:
- Tarjeta: `4242 4242 4242 4242`
- Vencimiento: cualquier fecha futura
- CVC: cualquier 3 dígitos

---

## Flujo completo

```
Cliente llena nombre + teléfono
  → Click "Pagar con Tarjeta"
  → POST /api/create-checkout-session
  → Redirige a stripe.com (HTTPS, PCI compliant)
  → Cliente paga
  → Stripe llama POST /api/stripe-webhook
  → Firestore order.estado = "pagado"
  → Cliente regresa a la tienda con confirmación
```
