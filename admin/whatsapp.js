/**
 * ============================================================
 * WHATSAPP ADMIN v4 — Frontend JavaScript
 * Conecta al backend via Socket.io
 * QR, chats, mensajes, CRM, config IA, quick replies, sonido
 * ============================================================
 */

// ── CONFIGURACION (lee de localStorage o usa defaults) ────────
const BACKEND_URL  = localStorage.getItem('wa_backend_url')  || 'https://dra-andrea-whatsapp.onrender.com';
const ADMIN_SECRET = localStorage.getItem('wa_admin_secret') || 'AndreaVargas2024!Secure';

const state = {
    socket: null,
    connected: false,
    waConnected: false,
    currentChat: null,
    chats: new Map(),
    messages: new Map(),
    crmData: new Map(),
    aiDisabled: new Set(),
    unread: new Map(),
    searchQuery: '',
    soundEnabled: localStorage.getItem('wa_sound') !== 'false',
};

const $ = id => document.getElementById(id);

// Quick reply templates
const QUICK_REPLIES = [
    { label: 'Saludo', text: 'Hola! Bienvenida a la academia de la Dra. Andrea Vargas. En que te puedo ayudar?' },
    { label: 'Cursos', text: 'Tenemos cursos virtuales y presenciales. Los virtuales son 100% online con acceso de por vida. Los presenciales son intensivos con practica directa. Cual te interesa mas?' },
    { label: 'Link', text: 'Aqui puedes ver todos los cursos disponibles e inscribirte: https://andreavargas.art/cursos.html' },
    { label: 'Precio', text: 'Te paso la info del curso con precios. Dame un momento!' },
    { label: 'Pago', text: 'Puedes pagar por transferencia a Bancolombia, tarjeta de credito o PSE. Todo se hace desde la plataforma, es rapido y seguro.' },
    { label: 'Garantia', text: 'Tienes 7 dias de garantia. Si el curso no cumple tus expectativas, te devolvemos el dinero sin preguntas.' },
    { label: 'Doctora', text: 'La doctora esta en consultas ahorita, pero le dejo tu mensaje y te responde pronto!' },
    { label: 'Gracias', text: 'Con mucho gusto! Cualquier otra duda me cuentas. Estoy para ayudarte!' },
];

// ── INICIALIZACION ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initWhatsApp();
    initQuickReplies();
    initSoundToggle();
});

function initWhatsApp() {
    console.log('[Admin] Conectando a:', BACKEND_URL);

    state.socket = io(BACKEND_URL, {
        auth: { token: ADMIN_SECRET },
        transports: ['websocket', 'polling'],
        reconnectionAttempts: Infinity,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 10000
    });

    state.socket.on('connect', () => {
        console.log('[Admin] WS Conectado:', state.socket.id);
        state.connected = true;
        updateBadge('Esperando WA...', '#f39c12');
        setDiag('diagWS', 'Conectado (' + state.socket.id?.substring(0,8) + ')', '#27ae60');
        setDiag('diagWA', 'Esperando estado...', '#f39c12');
        if ($('qrSpinnerText')) $('qrSpinnerText').textContent = 'Conectado al servidor. Esperando WhatsApp...';
    });

    state.socket.on('connect_error', (err) => {
        console.error('[Admin] Error WS:', err.message);
        updateBadge('Error WS', '#e74c3c');
        setDiag('diagWS', err.message, '#e74c3c');
    });

    state.socket.on('disconnect', (reason) => {
        console.warn('[Admin] WS Desconectado:', reason);
        state.connected = false;
        state.waConnected = false;
        updateBadge('Desconectado', '#e74c3c');
        setDiag('diagWS', 'Desconectado: ' + reason, '#e74c3c');
    });

    state.socket.on('wa:status', (data) => {
        if (data.connected) {
            setDiag('diagWA', 'Conectado', '#27ae60');
            onWAConnected();
        } else {
            setDiag('diagWA', 'Sin sesion activa', '#e74c3c');
            if (data.qr) showQRCode(data.qr);
            else if ($('qrSpinnerText')) $('qrSpinnerText').textContent = 'Esperando QR del servidor...';
            updateBadge('Esperando QR...', '#f39c12');
        }
    });

    state.socket.on('wa:qr', (data) => {
        if (data.qr) {
            showQRCode(data.qr);
            updateBadge('Escanea el QR', '#c78e3f');
        }
    });

    state.socket.on('wa:connected', () => onWAConnected());

    state.socket.on('wa:disconnected', () => {
        state.waConnected = false;
        updateBadge('WA Desconectado', '#e74c3c');
        showQRSection();
    });

    state.socket.on('wa:chats_loaded', (data) => {
        const chats = data.chats || data;
        if (Array.isArray(chats)) {
            chats.forEach(c => {
                const jid = c.jid || c.id;
                if (jid) state.chats.set(jid, { ...c, id: jid });
            });
        }
        renderChatList();
    });

    state.socket.on('wa:message', (msg) => {
        const jid = msg.jid;
        if (!jid) return;

        const normalized = {
            key: { fromMe: msg.direction === 'outgoing', remoteJid: jid },
            message: { conversation: msg.text || '' },
            messageTimestamp: Math.floor((msg.timestamp || Date.now()) / 1000),
            senderName: msg.name,
            aiGenerated: msg.ai_generated,
            messageType: msg.messageType || 'text'
        };

        if (!state.messages.has(jid)) state.messages.set(jid, []);
        state.messages.get(jid).push(normalized);

        const existing = state.chats.get(jid) || {};
        state.chats.set(jid, {
            ...existing,
            id: jid, jid,
            name: msg.name || existing.name || jid.split('@')[0],
            lastMessage: msg.text?.substring(0, 60),
            lastTime: msg.timestamp || Date.now()
        });

        if (msg.crm) {
            const phone = jid.split('@')[0];
            state.crmData.set(phone, { ...state.crmData.get(phone), ...msg.crm });
        }

        if (state.currentChat === jid) {
            renderMessages();
            updateStats();
        } else {
            const count = state.unread.get(jid) || 0;
            state.unread.set(jid, count + 1);
            if (msg.direction === 'incoming') playNotificationSound();
        }

        renderChatList();
        updateTabTitle();
    });

    state.socket.on('wa:presence', (data) => {
        const jid = data.jid || data.id;
        const status = data.status || (data.presences?.[jid]?.lastKnownPresence);
        if (state.currentChat === jid) {
            updatePresenceIndicator(status, data.lastSeen);
        }
    });

    state.socket.on('wa:session_cleared', (data) => {
        showNotification(data.message || 'Sesion cerrada', 'info');
        showQRSection();
    });

    state.socket.on('wa:error', (data) => {
        showNotification(data.message || 'Error en WhatsApp', 'error');
    });
}

// ── CUANDO WA ESTA CONECTADO ─────────────────────────────
function onWAConnected() {
    state.waConnected = true;
    setDiag('diagWA', 'Conectado', '#2ecc71');
    updateBadge('CONECTADO', '#2ecc71', '#27ae60');
    hideQRSection();
    showChatSection();
    state.socket?.emit('wa:get_chats');
    renderChatList();
    if ($('statWA')) $('statWA').textContent = 'Activo';
    if ($('statSocket')) $('statSocket').textContent = 'Conectado';
}

// ── UI HELPERS ────────────────────────────────────────────────

function updateBadge(text, color, dotColor) {
    const pill  = $('wsPill');
    const dot   = $('wsDot');
    const label = $('wsLabel');
    if (!pill) return;
    const c = dotColor || color;
    pill.style.borderColor  = color + '44';
    pill.style.color        = color;
    pill.style.background   = color + '11';
    if (dot)   dot.style.background = c;
    if (label) label.textContent = text;
}

function showQRCode(qrDataUrl) {
    const qrImage   = $('qrImage');
    const qrSpinner = $('qrSpinner');
    const qrMessage = $('qrMessage');
    if (qrImage) { qrImage.src = qrDataUrl; qrImage.style.display = 'block'; }
    if (qrSpinner) qrSpinner.style.display = 'none';
    if (qrMessage) qrMessage.textContent = 'Escanea el codigo QR con tu WhatsApp para vincular el panel.';
    const qrSection = $('qrSection');
    if (qrSection) qrSection.style.display = 'flex';
    const chatSection = $('chatSection');
    if (chatSection) chatSection.style.display = 'none';
}

function showQRSection(msg) {
    if ($('qrSection'))   $('qrSection').style.display   = 'flex';
    if ($('chatSection')) $('chatSection').style.display  = 'none';
    if ($('qrImage'))     $('qrImage').style.display      = 'none';
    if ($('qrSpinner'))   $('qrSpinner').style.display    = 'flex';
    if ($('qrMessage'))   $('qrMessage').textContent      = msg || 'Esperando QR del servidor...';
}

function hideQRSection() {
    if ($('qrSection')) $('qrSection').style.display = 'none';
}

function showChatSection() {
    if ($('chatSection')) $('chatSection').style.display = 'flex';
}

// ── RECONEXION / SESION ──────────────────────────────────────

function reconnectWA() {
    state.socket?.emit('wa:reconnect');
    updateBadge('Reconectando...', '#f39c12');
    showNotification('Reconectando WhatsApp...', 'info');
    showQRSection('Reconectando, espera el QR...');
}

function disconnectWA() {
    if (!confirm('Desconectar WhatsApp y generar nuevo QR?')) return;
    state.socket?.emit('wa:clear_session');
}

function clearSession() {
    if (!confirm('Seguro que deseas cerrar sesion de WhatsApp? Deberas escanear el QR nuevamente.')) return;
    state.socket?.emit('wa:clear_session');
}

// ── CONFIG MODAL ─────────────────────────────────────────────

function showSetupModal() {
    const modal = $('setupModal');
    if (modal) modal.style.display = 'flex';
    if ($('backendUrlInput'))  $('backendUrlInput').value  = BACKEND_URL;
    if ($('adminSecretInput')) $('adminSecretInput').value  = ADMIN_SECRET;
}

function saveSetup() {
    const url    = $('backendUrlInput')?.value.trim();
    const secret = $('adminSecretInput')?.value.trim();
    if (!url || !secret) { showNotification('Completa todos los campos', 'error'); return; }
    localStorage.setItem('wa_backend_url', url);
    localStorage.setItem('wa_admin_secret', secret);
    $('setupModal').style.display = 'none';
    location.reload();
}

// ── LISTA DE CHATS ───────────────────────────────────────────

function refreshChats() {
    state.socket?.emit('wa:get_chats');
}

function renderChatList() {
    const list = $('chatList');
    if (!list) return;

    const query      = (state.searchQuery || '').toLowerCase();
    const chatsArray = Array.from(state.chats.values())
        .filter(c => {
            if (!query) return true;
            const name  = (c.name || '').toLowerCase();
            const phone = (c.phone || c.jid || '').toLowerCase();
            return name.includes(query) || phone.includes(query);
        })
        .sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));

    if (chatsArray.length === 0 && state.waConnected) {
        list.innerHTML = '<div class="chat-list-empty"><i class="fas fa-inbox"></i><p>No hay chats aun</p></div>';
        return;
    }
    if (chatsArray.length === 0) {
        list.innerHTML = '<div class="chat-list-empty"><div class="spinner" style="margin:0 auto 16px;width:28px;height:28px;border-width:2px"></div><p>Conectando...</p></div>';
        return;
    }

    list.innerHTML = '';
    chatsArray.forEach(chat => {
        const jid    = chat.jid || chat.id;
        if (!jid) return;
        const phone  = String(jid).split('@')[0];
        const unread = state.unread.get(jid) || 0;
        const name   = String(chat.name || phone);
        const time   = chat.lastTime ? formatTime(chat.lastTime) : '';
        const preview = chat.lastMessage || 'Toca para ver mensajes';
        const crm    = state.crmData.get(phone);
        const level  = crm?.label || chat.crmLevel || 'NUEVO';
        const crmColors = { NUEVO:'#666', INTERESADO:'#3498db', CALIENTE:'#e67e22', CLIENTE:'#f1c40f' };
        const initials = name.split(' ').map(w=>w?.[0]||'').join('').substring(0,2).toUpperCase() || phone.substring(0,2);

        const el = document.createElement('div');
        el.className = `chat-item ${state.currentChat === jid ? 'active' : ''}`;
        el.onclick = () => selectChat(jid);
        el.innerHTML = `
            <div class="chat-avatar">
                ${initials}
                <span class="chat-crm-dot" style="background:${crmColors[level]}"></span>
            </div>
            <div class="chat-body">
                <div class="chat-row">
                    <span class="chat-name">${escapeHtml(name)}</span>
                    <div class="chat-badges">
                        <span class="chat-time">${time}</span>
                        ${unread > 0 ? `<span class="unread-dot">${unread}</span>` : ''}
                    </div>
                </div>
                <span class="chat-preview">${escapeHtml(preview)}</span>
            </div>
        `;
        list.appendChild(el);
    });
}

// ── SELECCION DE CHAT ────────────────────────────────────────

async function selectChat(jid) {
    state.currentChat = jid;
    state.unread.set(jid, 0);
    updateTabTitle();
    renderChatList();

    const chat  = state.chats.get(jid) || { jid };
    const phone = String(jid).split('@')[0];
    const name  = String(chat.name || phone);
    const initials = name.split(' ').map(w=>w?.[0]||'').join('').substring(0,2).toUpperCase() || phone.substring(0,2);

    if ($('chatHeaderName'))  $('chatHeaderName').textContent  = name;
    if ($('chatHeaderPhone')) $('chatHeaderPhone').textContent = '+' + phone;
    const avatarEl = $('chatHeaderAvatar');
    if (avatarEl) { avatarEl.textContent = initials; avatarEl.style.fontSize = '0.95rem'; }

    if ($('chatEmptyState')) $('chatEmptyState').style.display = 'none';
    if ($('chatArea'))       $('chatArea').style.display       = 'flex';

    state.socket?.emit('wa:subscribe_presence', { jid });
    renderMessages();

    try {
        const res = await apiCall(`/api/crm/${phone}`);
        if (res?.crm) state.crmData.set(phone, res.crm);
    } catch {}
    renderCRMPanel(phone);

    try {
        const msgRes = await apiCall(`/api/messages/${encodeURIComponent(jid)}?limit=50`);
        if (msgRes?.messages?.length > 0) {
            const normalized = msgRes.messages.map(m => ({
                key: { fromMe: m.direction === 'outgoing', remoteJid: jid },
                message: { conversation: m.message || m.text || '' },
                messageTimestamp: Math.floor(new Date(m.created_at).getTime() / 1000),
                aiGenerated: m.ai_generated,
                messageType: m.messageType || 'text'
            }));
            state.messages.set(jid, normalized);
            renderMessages();
        }
    } catch {}

    updateStats();
}

// ── MENSAJES ─────────────────────────────────────────────────

function renderMessages() {
    const container = $('messagesContainer');
    if (!container) return;
    container.innerHTML = '';

    const jid = state.currentChat;
    if (!jid) return;

    const msgs = state.messages.get(jid) || [];
    let lastDate = '';

    msgs.forEach(msg => {
        const isMe = msg.key?.fromMe;
        const text = msg.message?.conversation
                  || msg.message?.extendedTextMessage?.text
                  || msg.message?.imageMessage?.caption
                  || '';

        const ts = msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now();
        const time = formatTime(ts);

        // Separador de fecha
        const dateStr = formatDate(ts);
        if (dateStr !== lastDate) {
            lastDate = dateStr;
            const sep = document.createElement('div');
            sep.className = 'date-separator';
            sep.textContent = dateStr;
            container.appendChild(sep);
        }

        // Detectar tipo de mensaje
        const msgType = msg.messageType || 'text';
        const typeIcon = getMessageTypeIcon(msgType);
        const displayText = text || getMessageTypeLabel(msgType);

        if (!displayText) return;

        const el = document.createElement('div');
        el.className = `message-bubble ${isMe ? 'outgoing' : 'incoming'}`;
        el.innerHTML = `
            <div class="bubble-inner">
                ${msg.aiGenerated ? '<div class="bubble-sender"><i class="fas fa-robot"></i> Andrea IA</div>' : ''}
                ${typeIcon ? `<div class="bubble-type-badge">${typeIcon}</div>` : ''}
                <div class="bubble-text">${formatMessageText(displayText)}</div>
                <div class="bubble-meta">
                    ${msg.aiGenerated && isMe ? '<span class="ai-label">IA</span>' : ''}
                    <span class="bubble-time">${time}</span>
                    ${isMe ? '<span class="bubble-tick">✓✓</span>' : ''}
                </div>
            </div>
        `;
        container.appendChild(el);
    });

    requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
}

function getMessageTypeIcon(type) {
    const icons = {
        audio: '<i class="fas fa-microphone"></i>',
        image: '<i class="fas fa-image"></i>',
        video: '<i class="fas fa-video"></i>',
        sticker: '<i class="fas fa-sticky-note"></i>',
        document: '<i class="fas fa-file-alt"></i>',
        location: '<i class="fas fa-map-marker-alt"></i>',
        contact: '<i class="fas fa-address-book"></i>',
    };
    return icons[type] || '';
}

function getMessageTypeLabel(type) {
    const labels = {
        audio: 'Audio',
        image: 'Imagen',
        video: 'Video',
        sticker: 'Sticker',
        document: 'Documento',
        location: 'Ubicacion',
        contact: 'Contacto',
    };
    return labels[type] || '';
}

function formatMessageText(text) {
    let safe = escapeHtml(text);
    // Detectar URLs y convertir en links clicables
    safe = safe.replace(
        /(https?:\/\/[^\s<]+)/g,
        '<a href="$1" target="_blank" rel="noopener" style="color:var(--gold-light);text-decoration:underline">$1</a>'
    );
    return safe;
}

function sendMessage() {
    const input = $('messageInput');
    if (!input) return;
    const text = input.value.trim();
    if (!text || !state.currentChat) return;

    state.socket?.emit('wa:send_message', { jid: state.currentChat, text });
    input.value = '';
    input.style.height = 'auto';
}

function sendQuickReply(text) {
    if (!state.currentChat) { showNotification('Selecciona un chat primero', 'warning'); return; }
    state.socket?.emit('wa:send_message', { jid: state.currentChat, text });
}

// ── QUICK REPLIES ────────────────────────────────────────────

function initQuickReplies() {
    const container = $('quickReplies');
    if (!container) return;
    QUICK_REPLIES.forEach(qr => {
        const btn = document.createElement('button');
        btn.className = 'quick-reply-btn';
        btn.textContent = qr.label;
        btn.title = qr.text;
        btn.onclick = () => sendQuickReply(qr.text);
        container.appendChild(btn);
    });
}

// ── SONIDO ───────────────────────────────────────────────────

function initSoundToggle() {
    const btn = $('soundToggle');
    if (btn) {
        updateSoundButton();
        btn.onclick = () => {
            state.soundEnabled = !state.soundEnabled;
            localStorage.setItem('wa_sound', state.soundEnabled);
            updateSoundButton();
            showNotification(state.soundEnabled ? 'Sonido activado' : 'Sonido silenciado', 'info');
        };
    }
}

function updateSoundButton() {
    const btn = $('soundToggle');
    if (!btn) return;
    btn.innerHTML = state.soundEnabled
        ? '<i class="fas fa-volume-up"></i>'
        : '<i class="fas fa-volume-mute"></i>';
    btn.title = state.soundEnabled ? 'Silenciar notificaciones' : 'Activar sonido';
}

function playNotificationSound() {
    if (!state.soundEnabled) return;
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 800;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
    } catch {}
}

// ── BROWSER TAB TITLE ────────────────────────────────────────

function updateTabTitle() {
    const total = Array.from(state.unread.values()).reduce((a, b) => a + b, 0);
    document.title = total > 0
        ? `(${total}) WhatsApp IA · Dra. Andrea`
        : 'WhatsApp IA · Dra. Andrea Vargas';
}

// ── CRM PANEL ────────────────────────────────────────────────

function renderCRMPanel(phone) {
    const crm = state.crmData.get(phone) || {};

    const setTxt = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
    setTxt('crmName',          crm.name || 'Desconocido');
    setTxt('crmPhone',         phone);
    setTxt('crmConversations', crm.conversation_count || 1);
    setTxt('crmLastContact',   crm.last_interaction ? formatRelativeTime(crm.last_interaction) : 'Reciente');

    // Avatar
    const avatarLarge = $('crmAvatarLarge');
    if (avatarLarge) {
        const name = crm.name || phone;
        avatarLarge.textContent = name.split(' ').map(w => w?.[0] || '').join('').substring(0,2).toUpperCase();
    }

    const level  = crm.label || 'NUEVO';
    const colors = { NUEVO: '#888', INTERESADO: '#3498db', CALIENTE: '#e67e22', CLIENTE: '#f1c40f' };
    const icons  = { NUEVO: '👋', INTERESADO: '👀', CALIENTE: '🔥', CLIENTE: '🌟' };
    const badgeEl = $('crmLevelBadge');
    if (badgeEl) {
        badgeEl.innerHTML = `${icons[level] || '●'} ${level}`;
        badgeEl.style.borderColor = colors[level] || '#888';
        badgeEl.style.color       = colors[level] || '#888';
    }

    const sel = $('crmLevelSelect');
    if (sel) sel.value = level;

    const notes = $('crmNotes');
    if (notes) notes.value = crm.notes || '';

    // Stars based on interest_level
    const starsEl = $('crmStars');
    if (starsEl) {
        const lvl = crm.interest_level || 0;
        starsEl.innerHTML = '★'.repeat(lvl) + '☆'.repeat(Math.max(0, 5 - lvl));
    }

    // Tags
    const tagsEl = $('crmTags');
    if (tagsEl && crm.tags && crm.tags.length > 0) {
        tagsEl.innerHTML = crm.tags.map(t =>
            `<span class="crm-tag">${escapeHtml(t.replace('OBJECION_', ''))}</span>`
        ).join('');
        tagsEl.style.display = 'flex';
    } else if (tagsEl) {
        tagsEl.style.display = 'none';
    }
}

async function saveCRMNote() {
    const phone = state.currentChat?.split('@')[0];
    const note  = $('crmNotes')?.value.trim();
    if (!phone || !note) return;
    await apiCall(`/api/crm/${phone}`, 'PUT', { notes: note });
    showNotification('Notas guardadas', 'success');
}

async function markAsClient() {
    const phone = state.currentChat?.split('@')[0];
    if (!phone) return;
    await apiCall(`/api/crm/${phone}/mark-client`, 'POST');
    const crm = state.crmData.get(phone) || {};
    crm.label = 'CLIENTE';
    crm.interest_level = 5;
    state.crmData.set(phone, crm);
    renderCRMPanel(phone);
    showNotification('Marcado como CLIENTE', 'success');
    renderChatList();
}

async function changeCRMLevel(level) {
    const phone = state.currentChat?.split('@')[0];
    if (!phone) return;
    await apiCall(`/api/crm/${phone}`, 'PUT', { label: level });
    const crm = state.crmData.get(phone) || {};
    crm.label = level;
    state.crmData.set(phone, crm);
    renderCRMPanel(phone);
    showNotification(`Nivel cambiado a ${level}`, 'success');
    renderChatList();
}

async function clearConversationHistory() {
    if (!state.currentChat) return;
    if (!confirm('Borrar la memoria de IA para este chat?')) return;
    const jid = encodeURIComponent(state.currentChat);
    await apiCall(`/api/clear-history/${jid}`, 'POST');
    showNotification('Memoria de IA reiniciada', 'success');
}

// ── CONFIG IA ────────────────────────────────────────────────

async function loadAIConfig() {
    const res = await apiCall('/api/config');
    if (!res?.config) return;
    const cfg = res.config;
    const bind = (id, val) => {
        const el = $(id);
        if (!el) return;
        if (el.type === 'checkbox') el.checked = !!val;
        else el.value = val ?? '';
    };
    bind('cfgAutoReply',   cfg.auto_reply);
    bind('cfgModel',       cfg.openai_model || cfg.ai_model);
    bind('cfgTemperature', cfg.temperature);
    bind('cfgPrompt',      cfg.system_prompt);
}

async function saveAIConfig() {
    const getVal = (id, isBool) => { const el = $(id); return el ? (isBool ? el.checked : el.value) : null; };
    const cfg = {
        auto_reply:    getVal('cfgAutoReply', true),
        openai_model:  getVal('cfgModel', false),
        temperature:   parseFloat(getVal('cfgTemperature', false)) || 0.85,
        system_prompt: getVal('cfgPrompt', false)
    };
    const res = await apiCall('/api/config', 'POST', cfg);
    if (res?.success) showNotification('Configuracion guardada', 'success');
    else showNotification('Error al guardar', 'error');
}

async function toggleAI() {
    const isEnabled = $('aiToggle')?.checked;
    if (state.currentChat) {
        state.socket?.emit('wa:toggle_ai', { jid: state.currentChat, enabled: isEnabled });
    }
    if ($('aiToggleLabel')) $('aiToggleLabel').textContent = isEnabled ? 'IA Activa' : 'IA Pausada';
    const pill = $('aiPill');
    if (pill) pill.classList.toggle('active', isEnabled);
    showNotification(isEnabled ? 'IA Activada' : 'IA Pausada', 'info');
}

function openTab(tabId, btn) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    const panel = $(tabId);
    if (panel) panel.classList.add('active');
    if (btn) btn.classList.add('active');
    if (tabId === 'tabConfig') loadAIConfig();
    if (tabId === 'tabStats') updateStats();
}

function updateStats() {
    const jid = state.currentChat;
    if (jid) {
        const msgs = state.messages.get(jid) || [];
        const outgoing = msgs.filter(m => m.key?.fromMe);
        const aiMsgs   = msgs.filter(m => m.aiGenerated);
        if ($('statTotal')) $('statTotal').textContent = msgs.length;
        if ($('statAI'))    $('statAI').textContent    = aiMsgs.length;
        if ($('statIn'))    $('statIn').textContent     = msgs.length - outgoing.length;
        if ($('statOut'))   $('statOut').textContent    = outgoing.length;
    }
    if ($('statTotalChats')) $('statTotalChats').textContent = state.chats.size;
    const totalUnread = Array.from(state.unread.values()).reduce((a,b) => a + b, 0);
    if ($('statUnread')) $('statUnread').textContent = totalUnread;
}

// ── API HELPER ───────────────────────────────────────────────

async function apiCall(endpoint, method = 'GET', body = null) {
    try {
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_SECRET }
        };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(BACKEND_URL + endpoint, opts);
        return await res.json();
    } catch (err) {
        console.error('API Error:', err);
        return { success: false, error: err.message };
    }
}

// ── UTILIDADES ───────────────────────────────────────────────

function formatTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const diff = Math.floor((now - d) / 86400000);
    if (diff === 0) return 'Hoy';
    if (diff === 1) return 'Ayer';
    return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

function formatRelativeTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    const now = new Date();
    const diff = Math.floor((now - d) / 60000);
    if (diff < 1)    return 'Justo ahora';
    if (diff < 60)   return `Hace ${diff} min`;
    if (diff < 1440) return `Hoy ${d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;
    if (diff < 2880) return 'Ayer';
    return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
}

function updatePresenceIndicator(status, lastSeen) {
    const el = $('chatPresence');
    if (!el) return;
    const textMap = {
        composing:   'escribiendo...',
        recording:   'grabando audio...',
        available:   'en linea',
        unavailable: lastSeen ? `ult. vez ${formatRelativeTime(lastSeen)}` : '',
        paused:      ''
    };
    const colorMap = {
        composing: 'var(--green)', recording: '#e67e22',
        available: 'var(--green)', unavailable: 'var(--text3)', paused: 'var(--text3)'
    };
    el.textContent = textMap[status] ?? '';
    el.style.color = colorMap[status] ?? 'var(--text3)';
}

function showNotification(msg, type = 'info') {
    const colors = { success: '#27ae60', error: '#e74c3c', info: '#3498db', warning: '#f39c12' };
    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.style.background = colors[type] || colors.info;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => { toast.classList.add('fade-out'); setTimeout(() => toast.remove(), 300); }, 3000);
}

function setDiag(id, text, color) {
    const el = $(id);
    if (el) { el.textContent = text; el.style.color = color; }
}

function filterChats(query) {
    state.searchQuery = query.toLowerCase();
    renderChatList();
}

// Keyboard shortcut: Enter para enviar
document.addEventListener('keydown', (e) => {
    const input = $('messageInput');
    if (e.key === 'Enter' && !e.shiftKey && document.activeElement === input) {
        e.preventDefault();
        sendMessage();
    }
});

// Auto-resize textarea
document.addEventListener('input', (e) => {
    if (e.target.id === 'messageInput') {
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
    }
});
