/**
 * ============================================================
 * WHATSAPP MANAGER — Gestor de conexión Baileys
 * Conexión estable, anticaídas, anti-ban
 * Maneja QR, mensajes, presencias y reconexión automática
 * ============================================================
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    isJidGroup,
    makeInMemoryStore,
    jidNormalizedUser,
    proto,
    getAggregateVotesInPollMessage,
    areJidsSameUser,
    downloadContentFromMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const { generateResponse } = require('./ai-agent');
const { MessageQueue, sleep } = require('./message-queue');
const { updateCRMLevel, extractNameFromMessage } = require('./crm-service');
const { getAIConfig, saveMessage, getCRMContact, upsertCRMContact } = require('./supabase-sync');

// Directorio persistente para la sesión (Railway Volume en /app/auth_session)
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth_session');

// Logger silencioso (evita spam de logs de Baileys)
const logger = pino({ level: 'silent' });

class WhatsAppManager {
    constructor(io) {
        this.io = io;           // Socket.io para emitir al frontend
        this.sock = null;       // Socket de WhatsApp
        this.store = null;      // Store en memoria (metadata de chats)
        this.queue = new MessageQueue(); // Queue de mensajes anti-ban
        this.isConnected = false;
        this.currentQR = null;
        this.retryCount = 0;
        this.MAX_RETRIES = 15;
        this.retryDelay = 3000;
        this.reconnectTimer = null;
        
        // Chats con IA desactivada manualmente por la doctora
        this.aiDisabledChats = new Set();
        
        // Cache de nombres de contactos { jid: name }
        this.contactNames = new Map();
        
        // Asegurar que el directorio de sesión exista
        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }
    }

    /**
     * Inicializa y conecta WhatsApp
     */
    async connect() {
        console.log('[WA] 🔌 Iniciando conexión WhatsApp...');
        
        try {
            const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
            const { version } = await fetchLatestBaileysVersion();
            console.log(`[WA] 📱 Usando WhatsApp Web v${version.join('.')}`);

            // Store en memoria para metadata de chats y mensajes
            this.store = makeInMemoryStore({ logger });
            
            // Crear socket de WhatsApp con configuración anti-ban
            this.sock = makeWASocket({
                version,
                logger,
                auth: state,
                printQRInTerminal: false, // Nosotros lo manejamos vía WebSocket
                syncFullHistory: false,   // Solo cargar chats recientes
                markOnlineOnConnect: true,
                generateHighQualityLinkPreview: false,
                // Simular un navegador Chrome real
                browser: ['Andrea Vargas', 'Chrome', '124.0.6367.60'],
                getMessage: async (key) => {
                    if (this.store) {
                        const msg = await this.store.loadMessage(key.remoteJid, key.id);
                        return msg?.message || undefined;
                    }
                    return { conversation: '' };
                }
            });

            // Vincular store al socket
            this.store.bind(this.sock.ev);

            // === HANDLERS DE EVENTOS ===
            this.setupEventHandlers(saveCreds);

        } catch (err) {
            console.error('[WA] ❌ Error crítico iniciando:', err.message);
            this.scheduleReconnect();
        }
    }

    /**
     * Configura todos los handlers de eventos de Baileys
     */
    setupEventHandlers(saveCreds) {
        const { sock, io } = this;

        // ── CREDENCIALES ─────────────────────────────────────────
        sock.ev.on('creds.update', saveCreds);

        // ── ESTADO DE CONEXIÓN ───────────────────────────────────
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // QR Code generado — enviar al frontend
            if (qr) {
                console.log('[WA] 📲 QR generado. Esperando escaneo...');
                try {
                    const qrDataUrl = await QRCode.toDataURL(qr, {
                        width: 300,
                        margin: 2,
                        color: { dark: '#000000', light: '#FFFFFF' }
                    });
                    this.currentQR = qrDataUrl;
                    io.emit('wa:qr', { qr: qrDataUrl });
                } catch (err) {
                    console.error('[WA] Error generando QR image:', err.message);
                    io.emit('wa:qr', { qr_raw: qr });
                }
            }

            // Conexión abierta exitosamente
            if (connection === 'open') {
                console.log('[WA] ✅ ¡WhatsApp conectado!');
                this.isConnected = true;
                this.retryCount = 0;
                this.retryDelay = 3000;
                this.currentQR = null;
                
                io.emit('wa:connected', {
                    status: 'connected',
                    message: '¡WhatsApp conectado exitosamente!',
                    timestamp: new Date().toISOString()
                });

                // Cargar chats iniciales
                setTimeout(() => this.loadInitialChats(), 2000);
            }

            // Conexión cerrada
            if (connection === 'close') {
                this.isConnected = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log(`[WA] ⚠️ Conexión cerrada. Código: ${statusCode}. Reconectar: ${shouldReconnect}`);
                
                io.emit('wa:disconnected', {
                    status: 'disconnected',
                    code: statusCode,
                    message: shouldReconnect ? 'Reconectando...' : 'Sesión cerrada. Escanea QR nuevamente.'
                });

                if (shouldReconnect) {
                    this.scheduleReconnect();
                } else {
                    // Sesión inválida — limpiar auth para pedir QR nuevo
                    this.clearSession();
                }
            }
        });

        // ── MENSAJES ENTRANTES ───────────────────────────────────
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                await this.handleIncomingMessage(msg);
            }
        });

        // ── ACTUALIZACIÓN DE CHATS ───────────────────────────────
        sock.ev.on('chats.update', (updates) => {
            // Notificar al frontend que se actualizó algo
            io.emit('wa:chats_update', { updates });
        });

        // ── PRESENCIA (quién está escribiendo) ───────────────────
        sock.ev.on('presence.update', ({ id, presences }) => {
            io.emit('wa:presence', { jid: id, presences });
        });
    }

    /**
     * Maneja un mensaje entrante
     */
    async handleIncomingMessage(msg) {
        const { io, sock, queue } = this;

        // Filtros: ignorar mensajes propios, de grupos, vacíos, o del sistema
        if (msg.key.fromMe) return;
        if (isJidGroup(msg.key.remoteJid)) return;
        if (msg.key.remoteJid === 'status@broadcast') return;
        if (!msg.message) return;

        const jid = msg.key.remoteJid;
        const phone = jid.replace('@s.whatsapp.net', '');
        
        // Extraer texto del mensaje (soporta texto, imagen con caption, etc.)
        const text = this.extractMessageText(msg);
        if (!text || text.trim().length === 0) return;

        // Nombre del contacto
        const senderName = msg.pushName || this.contactNames.get(jid) || phone;
        if (msg.pushName) this.contactNames.set(jid, msg.pushName);

        console.log(`[WA] 📩 Mensaje de ${senderName} (${phone}): "${text.substring(0, 60)}..."`);

        // Simular que leímos el mensaje (anti-ban: marcar como leído)
        try {
            await sock.readMessages([msg.key]);
        } catch {}

        // Guardar en historial
        await saveMessage(jid, phone, 'incoming', text, false);

        // Actualizar CRM
        const detectedName = extractNameFromMessage(text);
        const crmUpdate = await updateCRMLevel(phone, text, detectedName || senderName);

        // Emitir al frontend en tiempo real
        io.emit('wa:message', {
            jid,
            phone,
            name: senderName,
            text,
            direction: 'incoming',
            timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
            messageId: msg.key.id,
            crm: crmUpdate
        });

        // ¿IA activa para este chat?
        const config = await getAIConfig();
        if (!config.auto_reply || this.aiDisabledChats.has(jid)) {
            console.log(`[WA] 🔕 IA desactivada para ${phone}. No se responde automáticamente.`);
            return;
        }

        // Encolar respuesta IA con delays humanizados
        queue.enqueue(jid, async () => {
            await this.sendAIResponse(jid, phone, text, senderName, config);
        });
    }

    /**
     * Genera y envía respuesta de IA con comportamiento humano
     */
    async sendAIResponse(jid, phone, incomingText, senderName, config) {
        const { sock, io } = this;

        try {
            // 1. Presencia "available" primero
            await sock.sendPresenceUpdate('available', jid);

            // 2. Delay inicial: simula leer el mensaje (1-3 seg)
            const readDelay = 1000 + Math.random() * 2000;
            await sleep(readDelay);

            // 3. Generar respuesta con GPT-4o (proceso paralelo al "typing")
            const responsePromise = generateResponse(jid, incomingText, senderName);

            // 4. Mostrar "escribiendo..." mientras genera
            await sock.sendPresenceUpdate('composing', jid);

            const responseText = await responsePromise;

            // 5. Delay de escritura basado en longitud de la respuesta
            const typingDelay = MessageQueue.humanTypingDelay(responseText);
            await sleep(typingDelay);

            // 6. Enviar mensaje
            await sock.sendMessage(jid, { text: responseText });
            await sock.sendPresenceUpdate('available', jid);

            console.log(`[WA] ✅ Respuesta IA enviada a ${phone}`);

            // 7. Guardar en historial y emitir al frontend
            await saveMessage(jid, phone, 'outgoing', responseText, true);
            
            io.emit('wa:message', {
                jid,
                phone,
                name: 'Andrea (IA)',
                text: responseText,
                direction: 'outgoing',
                ai_generated: true,
                timestamp: Date.now()
            });

        } catch (err) {
            console.error(`[WA] ❌ Error enviando respuesta IA a ${phone}:`, err.message);
            await sock.sendPresenceUpdate('available', jid).catch(() => {});
        }
    }

    /**
     * Envía un mensaje manual (desde el panel admin)
     */
    async sendManualMessage(jid, text) {
        if (!this.isConnected || !this.sock) {
            return { success: false, error: 'WhatsApp no está conectado' };
        }

        try {
            await this.sock.sendMessage(jid, { text });
            const phone = jid.replace('@s.whatsapp.net', '');
            await saveMessage(jid, phone, 'outgoing', text, false);
            
            this.io.emit('wa:message', {
                jid,
                phone,
                name: 'Andrea (Manual)',
                text,
                direction: 'outgoing',
                ai_generated: false,
                timestamp: Date.now()
            });

            return { success: true };
        } catch (err) {
            console.error('[WA] Error enviando mensaje manual:', err.message);
            return { success: false, error: err.message };
        }
    }

    /**
     * Carga los chats iniciales del store en memoria
     */
    async loadInitialChats() {
        try {
            if (!this.store) return;
            const chats = this.store.chats.all();
            const formattedChats = chats
                .filter(c => !isJidGroup(c.id))
                .slice(0, 50) // Top 50 chats recientes
                .map(c => ({
                    jid: c.id,
                    phone: c.id.replace('@s.whatsapp.net', ''),
                    name: c.name || this.contactNames.get(c.id) || c.id.replace('@s.whatsapp.net', ''),
                    unreadCount: c.unreadCount || 0,
                    lastMessage: c.conversationTimestamp
                        ? new Date(Number(c.conversationTimestamp) * 1000).toISOString()
                        : null
                }));

            this.io.emit('wa:chats_loaded', { chats: formattedChats });
            console.log(`[WA] 📋 ${formattedChats.length} chats enviados al frontend`);
        } catch (err) {
            console.error('[WA] Error cargando chats:', err.message);
        }
    }

    /**
     * Activa/desactiva la IA para un chat específico
     */
    toggleAI(jid, enabled) {
        if (enabled) {
            this.aiDisabledChats.delete(jid);
        } else {
            this.aiDisabledChats.add(jid);
        }
        console.log(`[WA] IA ${enabled ? 'activada' : 'desactivada'} para ${jid}`);
    }

    /**
     * Extrae texto de cualquier tipo de mensaje WhatsApp
     */
    extractMessageText(msg) {
        const m = msg.message;
        if (!m) return '';
        
        return m.conversation ||
               m.extendedTextMessage?.text ||
               m.imageMessage?.caption ||
               m.videoMessage?.caption ||
               m.documentMessage?.caption ||
               m.buttonsResponseMessage?.selectedDisplayText ||
               m.listResponseMessage?.title ||
               m.templateButtonReplyMessage?.selectedDisplayText ||
               '';
    }

    /**
     * Programa reconexión con backoff exponencial
     */
    scheduleReconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.retryCount >= this.MAX_RETRIES) {
            console.error('[WA] ❌ Máximo de reintentos alcanzado. Revisa tu conexión.');
            this.io.emit('wa:error', { message: 'No se pudo reconectar. Recarga la página y escanea el QR.' });
            return;
        }

        this.retryCount++;
        const delay = Math.min(this.retryDelay * Math.pow(1.5, this.retryCount - 1), 60000);
        console.log(`[WA] 🔄 Reintento ${this.retryCount}/${this.MAX_RETRIES} en ${Math.round(delay/1000)}s...`);
        
        this.reconnectTimer = setTimeout(() => {
            this.connect();
        }, delay);
    }

    /**
     * Limpia la sesión guardada (para pedir QR nuevo)
     */
    clearSession() {
        try {
            if (fs.existsSync(AUTH_DIR)) {
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                fs.mkdirSync(AUTH_DIR, { recursive: true });
            }
            this.isConnected = false;
            this.retryCount = 0;
            console.log('[WA] 🗑️ Sesión eliminada. Listo para nuevo QR.');
            this.io.emit('wa:session_cleared', { message: 'Sesión cerrada. Escanea el QR para reconectar.' });
        } catch (err) {
            console.error('[WA] Error limpiando sesión:', err.message);
        }
    }

    /**
     * Cierra la conexión limpiamente
     */
    async disconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.sock) {
            await this.sock.logout().catch(() => {});
            this.sock = null;
        }
        this.isConnected = false;
    }

    getStatus() {
        return {
            connected: this.isConnected,
            hasQR: !!this.currentQR,
            qr: this.currentQR,
            retryCount: this.retryCount
        };
    }
}

module.exports = WhatsAppManager;
