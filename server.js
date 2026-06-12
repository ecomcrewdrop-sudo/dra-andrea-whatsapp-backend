/**
 * ============================================================
 * SERVER.JS v3 — Servidor principal Railway
 * Express + Socket.io + WhatsApp AI
 * Con error handling completo y graceful shutdown
 * ============================================================
 */
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const WhatsAppManager = require('./whatsapp-manager');
const { getAIConfig, saveAIConfig, getMessageHistory, getCRMContact, upsertCRMContact, initRealtimeListener } = require('./supabase-sync');
const { addNote, markAsClient } = require('./crm-service');
const { clearHistory, injectContext } = require('./ai-agent');

initRealtimeListener();

const app = express();
const server = http.createServer(app);

// ── CORS ─────────────────────────────────────────────────────
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
        if (!origin) return callback(null, true);
        const allowed = allowedOrigins.some(o =>
            typeof o === 'string' ? o === origin : o.test(origin)
        );
        if (!allowed && process.env.NODE_ENV !== 'production') return callback(null, true);
        callback(null, allowed);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// ── MIDDLEWARE DE AUTH ────────────────────────────────────────
function authMiddleware(req, res, next) {
    const token = req.headers['x-admin-token'];
    const validSecret = process.env.ADMIN_SECRET || 'draandrea2024secure!';
    if (token !== validSecret) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    next();
}

// Wrapper para rutas async — captura errores sin repetir try/catch
function asyncRoute(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(err => {
            console.error(`[API] Error en ${req.method} ${req.path}:`, err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Error interno del servidor' });
            }
        });
    };
}

// ── SOCKET.IO ────────────────────────────────────────────────
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: false
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const validSecret = process.env.ADMIN_SECRET || 'draandrea2024secure!';
    if (token === validSecret) return next();
    return next(new Error('Autenticacion requerida'));
});

// ── WHATSAPP MANAGER ─────────────────────────────────────────
const waManager = new WhatsAppManager(io);

// ── HEALTH CHECK ─────────────────────────────────────────────
app.get('/health', (req, res) => {
    const status = waManager.getStatus();
    res.json({
        status: 'ok',
        wa_connected: status.connected,
        wa_retries: status.retryCount,
        chats_cached: status.chatsCount,
        active_followups: status.activeFollowUps,
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    });
});

// ── API ROUTES ───────────────────────────────────────────────

app.get('/api/status', authMiddleware, (req, res) => {
    res.json(waManager.getStatus());
});

app.post('/api/disconnect', authMiddleware, (req, res) => {
    waManager.clearSession();
    res.json({ success: true });
});

app.post('/api/send', authMiddleware, asyncRoute(async (req, res) => {
    const { jid, message } = req.body;
    if (!jid || !message) return res.status(400).json({ error: 'Faltan parametros' });
    const result = await waManager.sendManualMessage(jid, message);
    res.json(result);
}));

app.get('/api/messages/:chatId', authMiddleware, asyncRoute(async (req, res) => {
    const { chatId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const messages = await getMessageHistory(chatId, limit);
    res.json({ success: true, messages });
}));

app.get('/api/crm/:phone', authMiddleware, asyncRoute(async (req, res) => {
    const crm = await getCRMContact(req.params.phone);
    res.json({ success: true, crm: crm || {} });
}));

app.put('/api/crm/:phone', authMiddleware, asyncRoute(async (req, res) => {
    await upsertCRMContact(req.params.phone, req.body);
    res.json({ success: true });
}));

app.post('/api/crm/:phone/note', authMiddleware, asyncRoute(async (req, res) => {
    const result = await addNote(req.params.phone, req.body.note);
    res.json(result);
}));

app.post('/api/crm/:phone/mark-client', authMiddleware, asyncRoute(async (req, res) => {
    await markAsClient(req.params.phone);
    res.json({ success: true });
}));

app.get('/api/config', authMiddleware, asyncRoute(async (req, res) => {
    const config = await getAIConfig();
    if (config.openai_api_key) {
        config.openai_api_key = config.openai_api_key.substring(0, 7) + '...' + config.openai_api_key.slice(-4);
    }
    res.json({ success: true, config });
}));

app.post('/api/config', authMiddleware, asyncRoute(async (req, res) => {
    const result = await saveAIConfig(req.body);
    res.json(result);
}));

app.post('/api/toggle-ai', authMiddleware, (req, res) => {
    const { jid, enabled } = req.body;
    waManager.toggleAI(jid, enabled);
    res.json({ success: true, jid, aiEnabled: enabled });
});

app.post('/api/clear-history/:jid', authMiddleware, (req, res) => {
    clearHistory(req.params.jid);
    res.json({ success: true });
});

app.post('/api/inject-context', authMiddleware, asyncRoute(async (req, res) => {
    const { jid, limit } = req.body;
    const messages = await getMessageHistory(jid, limit || 20);
    injectContext(jid, messages);
    res.json({ success: true, injected: messages.length });
}));

// ── SOCKET.IO EVENTS ─────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`[WS] Admin conectado: ${socket.id}`);

    socket.emit('wa:status', waManager.getStatus());

    if (waManager.currentQR) {
        socket.emit('wa:qr', { qr: waManager.currentQR });
    }

    if (waManager.isConnected) {
        const chatList = [...waManager.chatsCache.values()]
            .sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0))
            .slice(0, 50);
        socket.emit('wa:chats_loaded', { chats: chatList });
        socket.emit('wa:connected', {
            status: 'connected',
            message: 'WhatsApp conectado!',
            timestamp: new Date().toISOString()
        });
        console.log(`[WS] Enviando ${chatList.length} chats cacheados al nuevo cliente`);
    }

    socket.on('wa:reconnect', () => {
        console.log('[WS] Admin solicito reconexion');
        waManager.connect();
    });

    socket.on('wa:clear_session', () => {
        console.log('[WS] Admin solicito limpiar sesion');
        waManager.clearSession();
        setTimeout(() => waManager.connect(), 1000);
    });

    socket.on('wa:toggle_ai', ({ jid, enabled }) => {
        waManager.toggleAI(jid, enabled);
    });

    socket.on('wa:get_chats', () => {
        const chatList = [...waManager.chatsCache.values()]
            .sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0))
            .slice(0, 50);
        socket.emit('wa:chats_loaded', { chats: chatList });
    });

    socket.on('wa:send_message', async ({ jid, text }) => {
        if (!jid || !text) return;
        try {
            const result = await waManager.sendManualMessage(jid, text);
            if (!result.success) {
                socket.emit('wa:error', { message: 'No se pudo enviar: ' + (result.error || '') });
            }
        } catch (err) {
            socket.emit('wa:error', { message: 'Error enviando mensaje: ' + err.message });
        }
    });

    socket.on('wa:subscribe_presence', ({ jid }) => {
        if (jid && waManager.sock && waManager.isConnected) {
            waManager.sock.presenceSubscribe(jid).catch(() => {});
        }
    });

    socket.on('disconnect', () => {
        console.log(`[WS] Admin desconectado: ${socket.id}`);
    });
});

// ── MANEJO DE ERRORES GLOBAL ─────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
    console.error('[SERVER] Unhandled Rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
    console.error('[SERVER] Uncaught Exception:', err.message);
});

// ── GRACEFUL SHUTDOWN ────────────────────────────────────────
async function gracefulShutdown(signal) {
    console.log(`[SERVER] ${signal} recibido. Cerrando limpiamente...`);
    try {
        await waManager.disconnect();
        server.close(() => {
            console.log('[SERVER] Servidor cerrado.');
            process.exit(0);
        });
        setTimeout(() => process.exit(1), 10000);
    } catch {
        process.exit(1);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── INICIO DEL SERVIDOR ──────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\nServidor corriendo en puerto ${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health\n`);
    waManager.connect();
});

module.exports = app;
