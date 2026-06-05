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
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const { generateResponse } = require('./ai-agent');
const { MessageQueue, sleep } = require('./message-queue');
const { updateCRMLevel, extractNameFromMessage } = require('./crm-service');
const { getAIConfig, saveMessage } = require('./supabase-sync');

// Directorio persistente para la sesión
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth_session');

// Logger silencioso (evita spam de logs de Baileys)
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

        // Chats con IA desactivada manualmente
        this.aiDisabledChats = new Set();

        // Cache simple de chats en memoria { jid: chatData }
        this.chatsCache = new Map();

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

            // Crear socket de WhatsApp con configuración anti-ban
            this.sock = makeWASocket({
                version,
                logger,
                auth: state,
                printQRInTerminal: false,
                syncFullHistory: false,
                markOnlineOnConnect: true,
                generateHighQualityLinkPreview: false,
                browser: ['Andrea Vargas', 'Chrome', '124.0.6367.60'],
                getMessage: async () => ({ conversation: '' })
            });

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

        // ── CHATS (para mantener la lista actualizada) ────────────
        sock.ev.on('chats.upsert', chats => this.updateChatsCache(chats));
        sock.ev.on('chats.set', ({ chats }) => this.updateChatsCache(chats));
        sock.ev.on('chats.update', chats => this.updateChatsCache(chats));

        // Evento de historial inicial
        sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest }) => {
            console.log(`[WA] 📥 Recibido historial de sincronización: ${chats.length} chats`);
            
            if (contacts) {
                contacts.forEach(contact => {
                    if (contact.name || contact.pushname) {
                        this.contactNames.set(contact.id, contact.name || contact.pushname);
                    }
                });
            }
            
            this.updateChatsCache(chats);
        });

        // ── CONTACTOS ────────────────────────────────────────────
        sock.ev.on('contacts.upsert', (contacts) => {
            contacts.forEach(contact => {
                if (contact.name || contact.pushname) {
                    this.contactNames.set(contact.id, contact.name || contact.pushname);
                }
            });
        });

        // ── PRESENCIA (quién está escribiendo) ───────────────────
        sock.ev.on('presence.update', ({ id, presences }) => {
            io.emit('wa:presence', { jid: id, presences });
        });
    }

    /**
     * Actualiza el cache de chats y emite al frontend
     */
    updateChatsCache(chats) {
        if (!chats || !Array.isArray(chats)) return;
        
        chats.forEach(chat => {
            if (!isJidGroup(chat.id)) {
                this.chatsCache.set(chat.id, {
                    jid: chat.id,
                    phone: chat.id.replace('@s.whatsapp.net', ''),
                    name: chat.name || this.contactNames.get(chat.id) || chat.id.replace('@s.whatsapp.net', ''),
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

        // Extraer texto del mensaje
        const text = this.extractMessageText(msg);
        if (!text || text.trim().length === 0) return;

        // Nombre del contacto
        const senderName = msg.pushName || this.contactNames.get(jid) || phone;
        if (msg.pushName) this.contactNames.set(jid, msg.pushName);

        console.log(`[WA] 📩 Mensaje de ${senderName} (${phone}): "${text.substring(0, 60)}"`);

        // Actualizar cache de chats
        this.chatsCache.set(jid, {
            jid,
            phone,
            name: senderName,
            lastMessage: text.substring(0, 60),
            lastTime: Date.now()
        });

        // Simular lectura (anti-ban)
        try { await sock.readMessages([msg.key]); } catch {}

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
            console.log(`[WA] 🔕 IA desactivada para ${phone}.`);
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

            // 3. Generar respuesta con GPT-4o (paralelo al typing)
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

            // 7. Guardar y emitir al frontend
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
            console.error('[WA] ❌ Máximo de reintentos alcanzado.');
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
