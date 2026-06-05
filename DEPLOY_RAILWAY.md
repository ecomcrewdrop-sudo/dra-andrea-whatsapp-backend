# 🚀 GUÍA DE DEPLOY — WhatsApp IA en Railway

## Requisitos previos
- Cuenta en GitHub (gratis)
- Cuenta en Railway (railway.app)
- API Key de OpenAI
- Credenciales de Supabase (ya las tienes)

---

## PASO 1: Crear repositorio en GitHub

1. Ve a **github.com** → "New repository"
2. Nombre: `dra-andrea-whatsapp-backend`
3. Privado ✓
4. Clic en "Create repository"

En tu computadora (desde la carpeta `backend/`):
```bash
git init
git add .
git commit -m "Initial commit - WhatsApp AI Backend"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/dra-andrea-whatsapp-backend.git
git push -u origin main
```

---

## PASO 2: Crear proyecto en Railway

1. Ve a **railway.app** → "New Project"
2. Selecciona "Deploy from GitHub repo"
3. Conecta tu cuenta de GitHub si no lo has hecho
4. Selecciona el repo `dra-andrea-whatsapp-backend`
5. Railway detecta Node.js automáticamente

---

## PASO 3: Configurar Variables de Entorno en Railway

En Railway → tu proyecto → "Variables":

| Variable | Valor |
|----------|-------|
| `OPENAI_API_KEY` | `sk-tu-clave-de-openai` |
| `SUPABASE_URL` | `https://xxxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | `eyJhbGc...` (service role key, NO la anon) |
| `ADMIN_SECRET` | Una clave segura aleatoria, ej: `draandrea2024secure!` |
| `FRONTEND_URL` | `https://draandreavargas.com` |
| `NODE_ENV` | `production` |

> ⚠️ La `SUPABASE_SERVICE_KEY` la encuentras en:  
> Supabase → Settings → API → "service_role" key

---

## PASO 4: Agregar Volume en Railway (CRÍTICO para persistencia de sesión)

Sin el Volume, cada deploy pide QR nuevo.

1. En Railway → tu proyecto → "Volumes" tab
2. Clic "Add Volume"
3. Mount Path: `/app/auth_session`
4. Guardar

---

## PASO 5: Verificar que corre

1. Railway te da una URL como `https://dra-andrea-whatsapp-backend-production.railway.app`
2. Visita `https://TU_URL.railway.app/health`
3. Debes ver: `{"status":"ok","wa_connected":false,...}`

---

## PASO 6: Configurar el panel admin

1. Sube `admin/whatsapp.html` y `admin/whatsapp.js` a tu cPanel
2. Abre `https://draandreavargas.com/admin/whatsapp.html`
3. Aparecerá el modal de configuración:
   - **URL del Backend**: `https://TU_URL.railway.app`
   - **Secreto Admin**: el valor de `ADMIN_SECRET` que pusiste en Railway
4. Clic en "Conectar Sistema"
5. Escanea el QR con tu WhatsApp

---

## PASO 7: Ejecutar SQL en Supabase

1. Ve a **Supabase → SQL Editor → New Query**
2. Copia y pega el contenido de `supabase/whatsapp-migration.sql`
3. Ejecuta (Run)
4. Verifica que las 4 tablas se crearon

---

## ✅ CHECKLIST FINAL

- [ ] Backend corriendo en Railway (health check OK)
- [ ] Volume montado en `/app/auth_session`
- [ ] Variables de entorno configuradas
- [ ] SQL ejecutado en Supabase
- [ ] `whatsapp.html` y `whatsapp.js` subidos al cPanel
- [ ] QR escaneado → WhatsApp conectado
- [ ] Prueba: enviar mensaje al número → la IA responde

---

## 🔧 SOLUCIÓN DE PROBLEMAS

**"No se puede conectar al servidor"**  
→ Verifica que la URL en el panel sea correcta y sin slash final

**"Autenticación requerida"**  
→ El ADMIN_SECRET del panel no coincide con el de Railway

**"WhatsApp desconecta frecuentemente"**  
→ Asegúrate de que el Volume esté montado. Sin él, la sesión se pierde al redeploy.

**"IA no responde"**  
→ Verifica la OPENAI_API_KEY en Railway → Variables

**Cambiar la API Key de OpenAI**  
→ Hazlo desde el panel admin → Pestaña "IA Config" → Campo API Key

---

## 💰 COSTOS ESTIMADOS

| Servicio | Plan | Costo |
|---------|------|-------|
| Railway | Hobby | ~$5 USD/mes |
| OpenAI GPT-4o | Por uso | ~$0.01–0.05 por conversación |
| Supabase | Free | Gratis |
| **Total** | | **~$5–15 USD/mes** |
