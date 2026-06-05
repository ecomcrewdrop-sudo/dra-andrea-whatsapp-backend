/**
 * ============================================================
 * SERVER.JS — Servidor principal Railway
 * Express + Socket.io + WhatsApp AI
 * ============================================================
 */
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const WhatsAppManager = require('./whatsapp-manager');
const { getAIConfig, saveAIConfig, getMessageHistory, getCRMContact, upsertCRMContact } = require('./supabase-sync');
const { addNote, markAsClient } = require('./crm-service');
const { clearHistory, injectContext } = require('./ai-agent');

const app = express();
const server = http.createServer(app);

// ── CORS — Permite frontend desde cPanel ─────────────────────
const allowedOrigins = [
    process.env.FRONTEND_URL,
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    /\.railway\.app$/,
    /\.onrender\.com$/,
    /andreavargas\.art$/,
];

app.use(cors({
    origin: (origin, callback) => {
        // Permite requests sin origin (Postman, archivo local file://, servidor mismo)
        if (!origin) return callback(null, true);
        const allowed = allowedOrigins.some(o =>
            typeof o === 'string' ? o === origin : o.test(origin)
        );
        // En desarrollo permitir todo
        if (!allowed && process.env.NODE_ENV !== 'production') return callback(null, true);
        callback(null, allowed);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// ── SOCKET.IO ────────────────────────────────────────────────
const io = new Server(server, {
    cors: {
        origin: '*',   // Permitimos cualquier origen — la auth es por token
        methods: ['GET', 'POST'],
        credentials: false
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

// Middleware de autenticación Socket.io
io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const validSecret = process.env.ADMIN_SECRET || 'draandrea2024secure!';
    if (token === validSecret) {
        return next();
    }
    return next(new Error('Autenticación requerida'));
});

// ── WHATSAPP MANAGER ─────────────────────────────────────────
const waManager = new WhatsAppManager(io);

// ── HEALTH CHECK (Railway lo requiere) ───────────────────────
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        wa_connected: waManager.isConnected,
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime())
    });
});

// ── API ROUTES ────────────────────────────────────────────────

// Estado actual de WhatsApp
app.get('/api/status', authMiddleware, (req, res) => {
    res.json(waManager.getStatus());
});

// Cerrar sesión WhatsApp
app.post('/api/disconnect', authMiddleware, (req, res) => {
    waManager.clearSession();
    res.json({ success: true });
});

// Enviar mensaje manual
app.post('/api/send', authMiddleware, async (req, res) => {
    const { jid, message } = req.body;
    if (!jid || !message) return res.status(400).json({ error: 'Faltan parámetros' });
    
    const result = await waManager.sendManualMessage(jid, message);
    res.json(result);
});

// Historial de mensajes de un chat
app.get('/api/messages/:chatId', authMiddleware, async (req, res) => {
    try {
        const { chatId } = req.params;
        const limit = parseInt(req.query.limit) || 50;
        const messages = await getMessageHistory(chatId, limit);
        res.json({ success: true, messages });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Datos CRM de un contacto
app.get('/api/crm/:phone', authMiddleware, async (req, res) => {
    const crm = await getCRMContact(req.params.phone);
    res.json({ success: true, crm: crm || {} });
});

// Actualizar datos CRM manualmente
app.put('/api/crm/:phone', authMiddleware, async (req, res) => {
    const { phone } = req.params;
    const updates = req.body;
    await upsertCRMContact(phone, updates);
    res.json({ success: true });
});

// Agregar nota a CRM
app.post('/api/crm/:phone/note', authMiddleware, async (req, res) => {
    const result = await addNote(req.params.phone, req.body.note);
    res.json(result);
});

// Marcar como cliente
app.post('/api/crm/:phone/mark-client', authMiddleware, async (req, res) => {
    await markAsClient(req.params.phone);
    res.json({ success: true });
});

// Obtener configuración IA
app.get('/api/config', authMiddleware, async (req, res) => {
    const config = await getAIConfig();
    // No retornar la API key completa por seguridad
    if (config.openai_api_key) {
        config.openai_api_key = config.openai_api_key.substring(0, 7) + '...' + config.openai_api_key.slice(-4);
    }
    res.json({ success: true, config });
});

// Guardar configuración IA
app.post('/api/config', authMiddleware, async (req, res) => {
    const result = await saveAIConfig(req.body);
    res.json(result);
});

// Activar/desactivar IA para un chat
app.post('/api/toggle-ai', authMiddleware, (req, res) => {
    const { jid, enabled } = req.body;
    waManager.toggleAI(jid, enabled);
    res.json({ success: true, jid, aiEnabled: enabled });
});

// Limpiar historial de conversación IA de un chat
app.post('/api/clear-history/:jid', authMiddleware, (req, res) => {
    clearHistory(req.params.jid);
    res.json({ success: true });
});

// Inyectar contexto de historial a IA
app.post('/api/inject-context', authMiddleware, async (req, res) => {
    const { jid, limit } = req.body;
    const messages = await getMessageHistory(jid, limit || 20);
    injectContext(jid, messages);
    res.json({ success: true, injected: messages.length });
});

// ── SOCKET.IO EVENTS ──────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`[WS] 🔗 Admin conectado: ${socket.id}`);

    // Enviar estado actual al cliente que se conecta
    socket.emit('wa:status', waManager.getStatus());

    // Si hay QR pendiente, enviarlo
    if (waManager.currentQR) {
        socket.emit('wa:qr', { qr: waManager.currentQR });
    }

    // ✅ Si WhatsApp ya está conectado, enviar chats cacheados INMEDIATAMENTE
    if (waManager.isConnected) {
        const chatList = [...waManager.chatsCache.values()]
            .sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0))
            .slice(0, 50);
        socket.emit('wa:chats_loaded', { chats: chatList });
        socket.emit('wa:connected', {
            status: 'connected',
            message: '¡WhatsApp conectado!',
            timestamp: new Date().toISOString()
        });
        console.log(`[WS] Enviando ${chatList.length} chats cacheados al nuevo cliente`);
    }

    // Cliente pide forzar reconexión
    socket.on('wa:reconnect', () => {
        console.log('[WS] Admin solicitó reconexión');
        waManager.connect();
    });

    // Cliente pide limpiar sesión
    socket.on('wa:clear_session', () => {
        console.log('[WS] Admin solicitó limpiar sesión');
        waManager.clearSession();
        setTimeout(() => waManager.connect(), 1000);
    });

    // Cliente toggle IA en un chat
    socket.on('wa:toggle_ai', ({ jid, enabled }) => {
        waManager.toggleAI(jid, enabled);
    });

    // Cliente pide refrescar lista de chats manualmente
    socket.on('wa:get_chats', () => {
        const chatList = [...waManager.chatsCache.values()]
            .sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0))
            .slice(0, 50);
        socket.emit('wa:chats_loaded', { chats: chatList });
    });

    // Cliente envía mensaje manual desde el panel
    socket.on('wa:send_message', async ({ jid, text }) => {
        if (!jid || !text) return;
        const result = await waManager.sendManualMessage(jid, text);
        if (!result.success) {
            socket.emit('wa:error', { message: 'No se pudo enviar el mensaje: ' + (result.error || '') });
        }
    });

    // Admin suscribe presencia de un chat (para ver "en línea", "escribiendo")
    socket.on('wa:subscribe_presence', ({ jid }) => {
        if (jid && waManager.sock && waManager.isConnected) {
            waManager.sock.presenceSubscribe(jid).catch(() => {});
        }
    });

    socket.on('disconnect', () => {
        console.log(`[WS] 🔌 Admin desconectado: ${socket.id}`);
    });
});

// ── MIDDLEWARE DE AUTH REST ───────────────────────────────────
function authMiddleware(req, res, next) {
    const token = req.headers['x-admin-token'];
    const validSecret = process.env.ADMIN_SECRET || 'draandrea2024secure!';
    if (token !== validSecret) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    next();
}

// ── MANEJO DE ERRORES GLOBAL ─────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
    console.error('[SERVER] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[SERVER] Uncaught Exception:', err.message);
    // No cerramos el proceso — Railway ya maneja el reinicio
});

// ── INICIO DEL SERVIDOR ───────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🚀 Servidor corriendo en puerto ${PORT}`);
    console.log(`🌐 Health: http://localhost:${PORT}/health\n`);
    
    // Conectar WhatsApp automáticamente al iniciar
    waManager.connect();
});

module.exports = app;
