/**
 * ============================================================
 * WHATSAPP MANAGER v3 — Gestor de conexion Baileys
 * Robusto, anti-caidas, anti-ban, auto-recuperable
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
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const { generateResponse, generateFollowUp } = require('./ai-agent');
const { MessageQueue, sleep } = require('./message-queue');
const { updateCRMLevel, extractNameFromMessage } = require('./crm-service');
const { getAIConfig, getCoursesForPrompt, saveMessage, getCRMContact, getRecentChats } = require('./supabase-sync');

const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth_session');
const logger = pino({ level: 'silent' });

class WhatsAppManager {
    constructor(io) {
        this.io = io;
        this.sock = null;
        this.queue = new MessageQueue();
        this.isConnected = false;
        this.currentQR = null;
        this.retryCount = 0;
        this.MAX_RETRIES = 15;
        this.retryDelay = 3000;
        this.reconnectTimer = null;
        this.aiDisabledChats = new Set();
        this.chatsCache = new Map();
        this.followUpTimers = new Map();
        this.contactNames = new Map();

        // Deduplicacion: guarda IDs de mensajes recientes para evitar procesarlos dos veces
        this.processedMessages = new Set();
        this.DEDUP_MAX = 500;

        // Watchdog: detecta conexiones muertas silenciosamente
        this.watchdogTimer = null;
        this.lastMessageTime = Date.now();
        this.WATCHDOG_INTERVAL = 5 * 60 * 1000; // revisar cada 5 min
        this.WATCHDOG_TIMEOUT = 15 * 60 * 1000; // 15 min sin actividad = sospechoso

        // Flag para evitar reconexiones concurrentes
        this._connecting = false;

        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        this.startWatchdog();
    }

    /**
     * Watchdog: si pasan 15 min sin ningun mensaje y estamos "conectados",
     * fuerza una reconexion preventiva
     */
    startWatchdog() {
        if (this.watchdogTimer) clearInterval(this.watchdogTimer);

        this.watchdogTimer = setInterval(() => {
            if (!this.isConnected) return;

            const silentTime = Date.now() - this.lastMessageTime;
            if (silentTime > this.WATCHDOG_TIMEOUT) {
                console.log(`[WA] WATCHDOG: ${Math.round(silentTime / 60000)} min sin actividad. Verificando conexion...`);
                this.healthCheck();
            }
        }, this.WATCHDOG_INTERVAL);
    }

    async healthCheck() {
        if (!this.sock || !this.isConnected) return;

        try {
            // Intentar una operacion liviana para verificar que la conexion esta viva
            await Promise.race([
                this.sock.sendPresenceUpdate('available'),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
            ]);
            console.log('[WA] WATCHDOG: Conexion verificada OK');
        } catch (err) {
            console.error('[WA] WATCHDOG: Conexion muerta detectada. Reconectando...');
            this.isConnected = false;
            this.io.emit('wa:disconnected', {
                status: 'disconnected',
                message: 'Conexion perdida detectada. Reconectando...'
            });
            this.cleanupSocket();
            this.scheduleReconnect();
        }
    }

    /**
     * Limpia el socket actual antes de crear uno nuevo (evita event handler leaks)
     */
    cleanupSocket() {
        if (this.sock) {
            try {
                this.sock.ev.removeAllListeners();
                this.sock.end(new Error('cleanup'));
            } catch {}
            this.sock = null;
        }
    }

    /**
     * Inicializa y conecta WhatsApp
     */
    async connect() {
        // Evitar reconexiones concurrentes
        if (this._connecting) {
            console.log('[WA] Ya hay una conexion en progreso. Ignorando.');
            return;
        }
        this._connecting = true;

        console.log('[WA] Iniciando conexion WhatsApp...');

        try {
            // Limpiar socket anterior para evitar acumulacion de event handlers
            this.cleanupSocket();

            const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
            const { version } = await fetchLatestBaileysVersion();
            console.log(`[WA] Usando WhatsApp Web v${version.join('.')}`);

            this.sock = makeWASocket({
                version,
                logger,
                auth: state,
                printQRInTerminal: false,
                syncFullHistory: false,
                markOnlineOnConnect: true,
                generateHighQualityLinkPreview: false,
                browser: ['Andrea Vargas', 'Chrome', '124.0.6367.60'],
                getMessage: async () => ({ conversation: '' }),
                keepAliveIntervalMs: 30000,
                retryRequestDelayMs: 2000,
            });

            this.setupEventHandlers(saveCreds);

        } catch (err) {
            console.error('[WA] Error critico iniciando:', err.message);
            this.scheduleReconnect();
        } finally {
            this._connecting = false;
        }
    }

    setupEventHandlers(saveCreds) {
        const { sock, io } = this;
        if (!sock) return;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('[WA] QR generado. Esperando escaneo...');
                try {
                    const qrDataUrl = await QRCode.toDataURL(qr, {
                        width: 300, margin: 2,
                        color: { dark: '#000000', light: '#FFFFFF' }
                    });
                    this.currentQR = qrDataUrl;
                    io.emit('wa:qr', { qr: qrDataUrl });
                } catch (err) {
                    console.error('[WA] Error generando QR image:', err.message);
                    io.emit('wa:qr', { qr_raw: qr });
                }
            }

            if (connection === 'open') {
                console.log('[WA] WhatsApp conectado!');
                this.isConnected = true;
                this.retryCount = 0;
                this.retryDelay = 3000;
                this.currentQR = null;
                this.lastMessageTime = Date.now();

                if (this.chatsCache.size === 0) {
                    console.log('[WA] Cache de chats vacio. Cargando desde BD...');
                    try {
                        const chats = await getRecentChats(50);
                        if (chats && chats.length > 0) {
                            chats.forEach(chat => this.chatsCache.set(chat.jid, chat));
                            io.emit('wa:chats_loaded', { chats });
                            console.log(`[WA] ${chats.length} chats recuperados de la BD`);
                        }
                    } catch (err) {
                        console.error('Error cargando chats BD:', err.message);
                    }
                }

                io.emit('wa:connected', {
                    status: 'connected',
                    message: 'WhatsApp conectado exitosamente!',
                    timestamp: new Date().toISOString()
                });
            }

            if (connection === 'close') {
                this.isConnected = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                console.log(`[WA] Conexion cerrada. Codigo: ${statusCode}. Reconectar: ${shouldReconnect}`);

                io.emit('wa:disconnected', {
                    status: 'disconnected',
                    code: statusCode,
                    message: shouldReconnect ? 'Reconectando...' : 'Sesion cerrada. Escanea QR nuevamente.'
                });

                if (shouldReconnect) {
                    this.scheduleReconnect();
                } else {
                    this.clearSession();
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                try {
                    await this.handleIncomingMessage(msg);
                } catch (err) {
                    console.error('[WA] Error no capturado en handleIncomingMessage:', err.message);
                }
            }
        });

        sock.ev.on('chats.upsert', chats => this.updateChatsCache(chats));
        sock.ev.on('chats.set', ({ chats }) => this.updateChatsCache(chats));
        sock.ev.on('chats.update', chats => this.updateChatsCache(chats));

        sock.ev.on('messaging-history.set', ({ chats, contacts }) => {
            console.log(`[WA] Recibido historial: ${chats.length} chats`);
            if (contacts) {
                contacts.forEach(contact => {
                    if (contact.name || contact.pushname) {
                        this.contactNames.set(contact.id, contact.name || contact.pushname);
                    }
                });
            }
            this.updateChatsCache(chats);
        });

        sock.ev.on('contacts.upsert', (contacts) => {
            contacts.forEach(contact => {
                if (contact.name || contact.pushname) {
                    this.contactNames.set(contact.id, contact.name || contact.pushname);
                }
            });
        });

        sock.ev.on('presence.update', ({ id, presences }) => {
            const presenceData = presences[id] || {};
            io.emit('wa:presence', {
                jid: id,
                presences,
                status: presenceData.lastKnownPresence,
                lastSeen: presenceData.lastSeen ? new Date(presenceData.lastSeen * 1000).toISOString() : null,
                isOnline: presenceData.lastKnownPresence === 'available'
            });
        });
    }

    updateChatsCache(chats) {
        if (!chats || !Array.isArray(chats)) return;

        chats.forEach(chat => {
            if (!isJidGroup(chat.id)) {
                const isLid = chat.id.includes('@lid');
                const rawPhone = chat.id.replace('@s.whatsapp.net', '').replace('@lid', '');
                this.chatsCache.set(chat.id, {
                    jid: chat.id,
                    phone: rawPhone,
                    isLid,
                    name: chat.name || this.contactNames.get(chat.id) || (isLid ? 'Contacto Anuncio' : rawPhone),
                    unreadCount: chat.unreadCount || 0,
                    lastTime: chat.conversationTimestamp ? Number(chat.conversationTimestamp) * 1000 : Date.now()
                });
            }
        });

        const chatList = [...this.chatsCache.values()]
            .sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0))
            .slice(0, 50);

        this.io.emit('wa:chats_loaded', { chats: chatList });
    }

    /**
     * Maneja un mensaje entrante con deduplicacion y proteccion total
     */
    async handleIncomingMessage(msg) {
        const { io } = this;

        if (msg.key.fromMe) return;
        if (isJidGroup(msg.key.remoteJid)) return;
        if (msg.key.remoteJid === 'status@broadcast') return;
        if (!msg.message) return;

        // DEDUPLICACION: evitar procesar el mismo mensaje dos veces
        const msgId = msg.key.id;
        if (this.processedMessages.has(msgId)) return;
        this.processedMessages.add(msgId);
        if (this.processedMessages.size > this.DEDUP_MAX) {
            const first = this.processedMessages.values().next().value;
            this.processedMessages.delete(first);
        }

        const jid = msg.key.remoteJid;

        // Cancelar timer de seguimiento si el usuario volvio a escribir
        if (this.followUpTimers.has(jid)) {
            clearTimeout(this.followUpTimers.get(jid));
            this.followUpTimers.delete(jid);
        }

        const isLid = jid.includes('@lid');
        const phone = jid.replace('@s.whatsapp.net', '').replace('@lid', '');

        const text = this.extractMessageText(msg);
        if (!text || text.trim().length === 0) return;

        const senderName = msg.pushName || this.contactNames.get(jid) || (isLid ? 'Contacto Anuncio' : phone);
        if (msg.pushName) this.contactNames.set(jid, msg.pushName);

        // Actualizar timestamp del watchdog
        this.lastMessageTime = Date.now();

        console.log(`[WA] Mensaje de ${senderName} (${isLid ? 'LID' : phone}): "${text.substring(0, 60)}"`);

        this.chatsCache.set(jid, {
            jid, phone, isLid,
            name: senderName,
            lastMessage: text.substring(0, 60),
            lastTime: Date.now()
        });

        // Simular lectura (anti-ban)
        await this.safeSockCall(async () => {
            await this.sock.readMessages([msg.key]);
            await this.sock.presenceSubscribe(jid);
        });

        await saveMessage(jid, phone, 'incoming', text, false);

        const detectedName = extractNameFromMessage(text);
        const crmUpdate = await updateCRMLevel(phone, text, detectedName || senderName);

        io.emit('wa:message', {
            jid, phone,
            name: senderName,
            text,
            direction: 'incoming',
            timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
            messageId: msgId,
            crm: crmUpdate
        });

        // IA activa para este chat?
        let config;
        try {
            config = await getAIConfig();
        } catch (err) {
            console.error('[WA] Error obteniendo config IA:', err.message);
            return;
        }

        if (!config.auto_reply || this.aiDisabledChats.has(jid)) {
            console.log(`[WA] IA desactivada para ${phone}.`);
            return;
        }

        this.queue.enqueue(jid, async () => {
            await this.sendAIResponse(jid, phone, text, senderName, config);
        });

        if (crmUpdate && config.auto_reply && !this.aiDisabledChats.has(jid)) {
            this.scheduleFollowUp(jid, phone, crmUpdate.label, senderName);
        }
    }

    /**
     * Ejecuta una operacion sobre sock de forma segura (null-check + try/catch)
     */
    async safeSockCall(fn) {
        if (!this.sock || !this.isConnected) return;
        try {
            await fn();
        } catch (err) {
            if (err.message?.includes('Connection Closed') || err.message?.includes('not open')) {
                console.warn('[WA] Conexion cerrada durante operacion. Marcando desconectado.');
                this.isConnected = false;
            }
        }
    }

    /**
     * Genera y envia respuesta de IA con proteccion completa contra caidas
     */
    async sendAIResponse(jid, phone, incomingText, senderName, config) {
        const { io } = this;

        try {
            // 1. Presencia "available"
            await this.safeSockCall(() => this.sock.sendPresenceUpdate('available', jid));

            // 2. Delay de lectura
            const readDelay = 1000 + Math.random() * 2000;
            await sleep(readDelay);

            // 3. Generar respuesta con timeout de seguridad
            const responsePromise = generateResponse(jid, incomingText, senderName);
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('OpenAI timeout (45s)')), 45000)
            );

            // 4. Mostrar "escribiendo..."
            await this.safeSockCall(() => this.sock.sendPresenceUpdate('composing', jid));

            let responseText;
            try {
                responseText = await Promise.race([responsePromise, timeoutPromise]);
            } catch (aiErr) {
                console.error(`[WA] Error/timeout generando respuesta IA: ${aiErr.message}`);
                responseText = 'Hola! Disculpa, en este momento estoy un poco ocupada. Te respondo en unos minutos!';
            }

            if (!responseText || responseText.trim().length === 0) {
                console.warn('[WA] Respuesta IA vacia. Omitiendo envio.');
                return;
            }

            // 5. Delay de escritura
            const typingDelay = MessageQueue.humanTypingDelay(responseText);
            await sleep(typingDelay);

            // 6. Verificar conexion antes de enviar
            if (!this.sock || !this.isConnected) {
                console.warn('[WA] Conexion perdida antes de enviar respuesta IA.');
                return;
            }

            await this.sock.sendMessage(jid, { text: responseText });
            await this.safeSockCall(() => this.sock.sendPresenceUpdate('available', jid));

            console.log(`[WA] Respuesta IA enviada a ${phone}`);

            await saveMessage(jid, phone, 'outgoing', responseText, true);

            io.emit('wa:message', {
                jid, phone,
                name: 'Andrea (IA)',
                text: responseText,
                direction: 'outgoing',
                ai_generated: true,
                timestamp: Date.now()
            });

        } catch (err) {
            console.error(`[WA] Error enviando respuesta IA a ${phone}:`, err.message);
            await this.safeSockCall(() => this.sock.sendPresenceUpdate('available', jid));
        }
    }

    /**
     * Programa seguimiento proactivo con proteccion
     */
    scheduleFollowUp(jid, phone, crmLevel, senderName) {
        const delays = { CALIENTE: 90 * 60 * 1000, INTERESADO: 4 * 60 * 60 * 1000 };
        const delay = delays[crmLevel];
        if (!delay) return;

        if (this.followUpTimers.has(jid)) clearTimeout(this.followUpTimers.get(jid));

        const timer = setTimeout(async () => {
            this.followUpTimers.delete(jid);
            if (!this.isConnected || !this.sock) return;
            if (this.aiDisabledChats.has(jid)) return;

            try {
                const followUpText = await generateFollowUp(jid, crmLevel, senderName);
                if (!followUpText || followUpText.trim().length === 0) return;

                // Humanizar el follow-up tambien
                await this.safeSockCall(() => this.sock.sendPresenceUpdate('composing', jid));
                const typingDelay = MessageQueue.humanTypingDelay(followUpText);
                await sleep(typingDelay);

                if (!this.sock || !this.isConnected) return;

                await this.sock.sendMessage(jid, { text: followUpText });
                await this.safeSockCall(() => this.sock.sendPresenceUpdate('available', jid));

                await saveMessage(jid, phone, 'outgoing', followUpText, true);

                this.io.emit('wa:message', {
                    jid, phone,
                    name: 'Andrea (IA - Follow-up)',
                    text: followUpText,
                    direction: 'outgoing',
                    ai_generated: true,
                    timestamp: Date.now()
                });
                console.log(`[WA] Follow-up enviado a ${phone} (nivel ${crmLevel})`);
            } catch (err) {
                console.error('[WA] Error enviando follow-up:', err.message);
            }
        }, delay);

        this.followUpTimers.set(jid, timer);
    }

    async sendManualMessage(jid, text) {
        if (!this.isConnected || !this.sock) {
            return { success: false, error: 'WhatsApp no esta conectado' };
        }

        try {
            await this.sock.sendMessage(jid, { text });
            const phone = jid.replace('@s.whatsapp.net', '').replace('@lid', '');
            await saveMessage(jid, phone, 'outgoing', text, false);

            this.io.emit('wa:message', {
                jid, phone,
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

    toggleAI(jid, enabled) {
        if (enabled) {
            this.aiDisabledChats.delete(jid);
        } else {
            this.aiDisabledChats.add(jid);
            // Cancelar follow-up pendiente si se desactiva IA
            if (this.followUpTimers.has(jid)) {
                clearTimeout(this.followUpTimers.get(jid));
                this.followUpTimers.delete(jid);
            }
        }
        console.log(`[WA] IA ${enabled ? 'activada' : 'desactivada'} para ${jid}`);
    }

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

    scheduleReconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this._connecting) return;

        if (this.retryCount >= this.MAX_RETRIES) {
            console.error(`[WA] Maximo de reintentos (${this.MAX_RETRIES}) alcanzado. Esperando 10 min antes de reiniciar ciclo...`);
            this.io.emit('wa:error', { message: 'Reconexion fallida. Reintentando en 10 minutos...' });

            // En vez de morir para siempre, reiniciar el ciclo despues de 10 min
            this.reconnectTimer = setTimeout(() => {
                console.log('[WA] Reiniciando ciclo de reconexion...');
                this.retryCount = 0;
                this.retryDelay = 3000;
                this.connect();
            }, 10 * 60 * 1000);
            return;
        }

        this.retryCount++;
        const delay = Math.min(this.retryDelay * Math.pow(1.5, this.retryCount - 1), 60000);
        console.log(`[WA] Reintento ${this.retryCount}/${this.MAX_RETRIES} en ${Math.round(delay / 1000)}s...`);

        this.reconnectTimer = setTimeout(() => {
            this.connect();
        }, delay);
    }

    clearSession() {
        try {
            this.cleanupSocket();
            if (fs.existsSync(AUTH_DIR)) {
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                fs.mkdirSync(AUTH_DIR, { recursive: true });
            }
            this.isConnected = false;
            this.retryCount = 0;
            this._connecting = false;
            console.log('[WA] Sesion eliminada. Listo para nuevo QR.');
            this.io.emit('wa:session_cleared', { message: 'Sesion cerrada. Escanea el QR para reconectar.' });
        } catch (err) {
            console.error('[WA] Error limpiando sesion:', err.message);
        }
    }

    async disconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.watchdogTimer) clearInterval(this.watchdogTimer);

        // Cancelar todos los follow-ups
        for (const timer of this.followUpTimers.values()) {
            clearTimeout(timer);
        }
        this.followUpTimers.clear();

        this.cleanupSocket();
        this.isConnected = false;
    }

    getStatus() {
        return {
            connected: this.isConnected,
            hasQR: !!this.currentQR,
            qr: this.currentQR,
            retryCount: this.retryCount,
            uptime: Math.floor(process.uptime()),
            chatsCount: this.chatsCache.size,
            activeFollowUps: this.followUpTimers.size
        };
    }
}

module.exports = WhatsAppManager;
