# 🎟️ Mini-CRM + Venta de Boletos con QR

Sistema para **vender boletos de un evento en vivo** (ej. *Alejandro López En Vivo*) desde una llamada telefónica o desde una página de invitación, cobrar con tarjeta, mandar el **boleto con código QR** por correo, y **escanear el QR en la puerta** para ver quién ya entró.

Hecho para usarse sin saber programar. Funciona en **modo demo** desde el primer minuto (simula pagos y correos) y, cuando quieras cobrar de verdad, solo pegas tus llaves de Stripe y Resend.

---

## ✨ Qué hace

| Necesidad tuya | Cómo lo resuelve |
|---|---|
| Tener un pequeño CRM (nombre, teléfono, email) | Pestaña **Contactos** del panel |
| Durante la llamada decir "el ticket vale $50" y mandar el cobro | **Nuevo cobro** en el Tablero → manda correo con link de pago |
| Que paguen y reciban el QR de entrada | Al pagar, se manda automático el correo con el **boleto QR** |
| Que el QR muestre **lo que incluye** según lo que pagó | Cada nivel (General/VIP/Mesa) trae sus beneficios; o pones beneficios **personalizados** por cobro |
| Escanear el QR en la puerta y ver quién registré | Pestaña **Escanear** (cámara), igual que el "Wings Tracker" |
| Que con el boleto venga un **formulario** de preguntas | El correo del boleto incluye link a un formulario de llegada |
| Mandar un **link de invitación / landing emblemada** | Página pública `/evento` con tu marca y botón de pago |

---

## 🚀 Cómo correrlo (en tu computadora)

Necesitas **Node.js 22 o superior** instalado.

```bash
npm install          # instala dependencias (una sola vez)
cp .env.example .env # crea tu configuración
npm start            # arranca el sistema
```

Luego abre en el navegador:

- **Panel (admin):** http://localhost:3000/admin → contraseña: la de `ADMIN_PASSWORD` (por defecto `cambiame123`)
- **Landing pública / invitación:** http://localhost:3000/evento

> Sin llaves de Stripe/Resend, arranca en **MODO DEMO**: los pagos se simulan con un botón y los correos NO se envían — se guardan en la pestaña **Correos** para que veas cómo se ven.

---

## 🧭 Cómo se usa (flujo del día a día)

### 1. Vender por teléfono
1. Entra al **Panel** → Tablero.
2. En **"Nuevo cobro"** escribe nombre, email y teléfono de la persona.
3. Elige el boleto (General / VIP / Mesa) **o** pon un **monto personalizado** y escribe a mano qué incluye.
4. Click en **"Crear cobro y enviar por correo"**.
   - Se le manda un correo con el botón de pago.
   - También aparece en la tabla con un botón **"Copiar link de pago"** (por si quieres mandarlo por WhatsApp).

### 2. La persona paga
- Paga con tarjeta (Stripe) y **automáticamente** recibe el correo con su **boleto QR** + el **formulario de llegada**.
- ¿Te pagaron por Zelle/efectivo? Usa el botón **"Marcar pagado"** en la tabla y el sistema manda el boleto igual.

### 3. Invitación / Landing
- Comparte el link `https://TU-DOMINIO/evento`. Es una página con tu marca donde la gente elige boleto y paga sola. Cada compra entra a tu CRM.

### 4. En la puerta del evento
1. Abre **Panel → Escanear** desde el celular.
2. Da permiso de cámara y apunta al QR del boleto.
3. Verás al instante:
   - 🟢 **Registrado** + nombre + lo que incluye su boleto.
   - 🟠 **Ya había entrado** (evita pases dobles).
   - 🔴 **No válido** o no pagado.

> La cámara necesita **HTTPS** (o `localhost`). En producción ya viene con HTTPS.

---

## ⚙️ Configurar el evento (precios y preguntas)

Edita **`config/event.json`**. Ahí cambias sin tocar código:

- **`brand`**: nombre, colores, logo, email de contacto, organizador.
- **`event`**: título, fecha, hora, lugar, dirección, descripción.
- **`tiers`**: los niveles de boleto, su **precio** y **qué incluye** cada uno.
- **`survey`**: las preguntas del formulario de llegada.

Ejemplo de un nivel:
```json
{ "id": "vip", "name": "VIP", "price": 100, "perks": ["Zona VIP", "Meet & greet", "Bebida"] }
```

---

## 💳 Activar cobros reales (Stripe)

1. Crea cuenta gratis en https://stripe.com y entra al Dashboard.
2. Copia tu **Secret key** (`sk_...`) desde https://dashboard.stripe.com/apikeys → ponla en `STRIPE_SECRET_KEY` del `.env`.
3. Configura el **webhook** para que el sistema sepa cuándo alguien pagó:
   - Ve a https://dashboard.stripe.com/webhooks → **Add endpoint**.
   - URL: `https://TU-DOMINIO/webhook/stripe`
   - Evento: `checkout.session.completed`
   - Copia el **Signing secret** (`whsec_...`) → ponlo en `STRIPE_WEBHOOK_SECRET`.

> Aunque no configures el webhook, el sistema **igual confirma el pago** cuando la persona regresa a la página de gracias (red de seguridad). El webhook lo hace más confiable.

---

## 📧 Activar correos reales (Resend)

1. Crea cuenta gratis en https://resend.com.
2. Saca una **API key** en https://resend.com/api-keys → ponla en `RESEND_API_KEY`.
3. En `EMAIL_FROM` pon tu remitente:
   - Para pruebas: `onboarding@resend.dev`
   - Para producción: verifica tu dominio en Resend y usa algo como `Boletos <boletos@tudominio.com>`.

---

## ☁️ Publicarlo en internet

Puedes usar **Vercel** (recomendado, lo pediste) o **Render**.

### Opción A — Vercel + Supabase (recomendada)

Vercel es *serverless*, así que la base de datos NO puede ser un archivo (se borraría). Por eso usamos **Supabase** (Postgres gratis). Son ~10 minutos:

**1. Crea la base de datos (Supabase)**
- Entra a https://supabase.com → crea cuenta (gratis, entra con GitHub).
- *New project* → ponle nombre y una contraseña de base de datos (guárdala).
- Espera ~2 min a que se cree.
- Ve a **Project Settings → Database → Connection string** y elige la pestaña **Transaction** (puerto **6543**, modo *pooler* — ideal para Vercel).
- Copia esa URL completa (`postgresql://...:6543/postgres`) y reemplaza `[YOUR-PASSWORD]` por la contraseña que pusiste.
  → guárdala como **DATABASE_URL**

> No necesitas crear ninguna tabla a mano: la app las crea sola la primera vez.

**2. Sube el proyecto a GitHub** (este repositorio).

**3. Importa en Vercel**
- Entra a https://vercel.com → *Add New… → Project* → importa tu repo de GitHub.
- Vercel detecta el `vercel.json` automáticamente. No cambies el *build*.
- En **Environment Variables** agrega:

  | Variable | Valor |
  |---|---|
  | `DATABASE_URL` | la URL de Supabase (paso 1) |
  | `ADMIN_PASSWORD` | tu contraseña del panel |
  | `SESSION_SECRET` | cualquier texto largo y aleatorio |
  | `BASE_URL` | la URL de tu proyecto (ej. `https://tu-app.vercel.app`) |
  | `STRIPE_SECRET_KEY` | tu llave de Stripe (cuando quieras cobrar real) |
  | `STRIPE_WEBHOOK_SECRET` | el secreto del webhook de Stripe |
  | `RESEND_API_KEY` | tu llave de Resend |
  | `EMAIL_FROM` | tu remitente |

- **Deploy**. Tendrás tu landing en `https://tu-app.vercel.app/evento` y el panel en `/admin`.

> 💡 La primera vez, `BASE_URL` aún no la sabes: deja que Vercel haga el primer deploy, copia la URL que te da, ponla en `BASE_URL` y vuelve a *Redeploy*. (Si no la pones, el sistema usa la URL automática de Vercel igual.)

> ⚠️ **Sin `DATABASE_URL`, Vercel funciona pero en modo temporal**: los datos se borran. Para vender de verdad, configura Supabase.

> Alternativa: también soporta **Turso** (libSQL) con `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` en vez de `DATABASE_URL`.

Después, en el webhook de Stripe usa la URL: `https://tu-app.vercel.app/webhook/stripe`.

### Opción B — Render (servidor tradicional, sin base externa)

1. Sube el repo a GitHub.
2. En Render: **New → Web Service** → conecta el repo (incluye `render.yaml`).
3. Pon las variables `BASE_URL`, `ADMIN_PASSWORD` y tus llaves.
4. Para que los datos no se borren, agrega un **Disk** montado en `/app/data` (o configura Turso igual que arriba).

---

## 🗂️ Estructura del proyecto

```
config/event.json   ← datos del evento, precios y preguntas (edítalo tú)
src/
  server.js         ← rutas y lógica principal (exporta la app)
  db.js             ← base de datos (Supabase/Postgres en la nube, o archivo local)
  payments.js       ← Stripe (o modo demo)
  email.js          ← Resend + plantillas de correo (o modo demo)
  qr.js             ← generación de códigos QR
  render.js         ← diseño/plantillas HTML
  config.js         ← carga de configuración y variables de entorno
api/index.js        ← punto de entrada para Vercel (serverless)
vercel.json         ← configuración de Vercel
render.yaml         ← configuración de Render
public/styles.css   ← estilos
data/               ← base de datos y correos demo en local (no se sube a git)
```

---

## ❓ Preguntas frecuentes

**¿Puedo cambiar el precio en cada llamada?**
Sí: en "Nuevo cobro" elige **"Monto personalizado"** y escribe el precio y lo que incluye.

**¿Y si no tienen email?**
Igual se crea el cobro; copia el **link de pago** de la tabla y mándalo por WhatsApp/SMS.

**¿El mismo QR sirve para varias personas (mesa de 4)?**
El QR es un boleto. Para una mesa, ese boleto representa la mesa (lo dice en "qué incluye"). Si quieres un QR por persona, crea un cobro por cada una.

**¿Es seguro?**
El panel está protegido con contraseña. Los pagos los procesa Stripe (no guardamos tarjetas). Cambia `ADMIN_PASSWORD` y `SESSION_SECRET` antes de publicar.
