/**
 * ============================================================
 * SUPABASE SYNC v3 — Sincronizacion con la plataforma
 * Con cache de config IA, retry, y realtime robusto
 * ============================================================
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ── CACHE DE CURSOS ──────────────────────────────────────────
let coursesCache = null;
let coursesCacheTimestamp = 0;
const COURSES_CACHE_TTL = 30 * 60 * 1000;

// ── CACHE DE CONFIG IA ───────────────────────────────────────
let aiConfigCache = null;
let aiConfigCacheTimestamp = 0;
const AI_CONFIG_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

// ── RETRY HELPER ─────────────────────────────────────────────
async function withRetry(fn, retries = 2, delay = 1000) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt === retries) throw err;
            console.warn(`[SUPABASE] Reintentando operacion (intento ${attempt + 1}/${retries})...`);
            await new Promise(r => setTimeout(r, delay * (attempt + 1)));
        }
    }
}

/**
 * Obtiene todos los cursos activos (con cache)
 */
async function getCourses() {
    const now = Date.now();
    if (coursesCache && (now - coursesCacheTimestamp) < COURSES_CACHE_TTL) {
        return coursesCache;
    }

    try {
        const data = await withRetry(async () => {
            const { data, error } = await supabase
                .from('courses')
                .select('id, title, description, price, category, active, image_url')
                .eq('active', true)
                .order('created_at', { ascending: false });
            if (error) throw error;
            return data;
        });

        coursesCache = data || [];
        coursesCacheTimestamp = now;
        console.log(`[SUPABASE] ${coursesCache.length} cursos cargados al cache`);
        return coursesCache;
    } catch (err) {
        console.error('[SUPABASE] Error cargando cursos:', err.message);
        return coursesCache || [];
    }
}

/**
 * Inicializa la escucha en tiempo real con auto-reconexion
 */
function initRealtimeListener() {
    const channel = supabase
        .channel('custom-courses-channel')
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'courses' },
            (payload) => {
                console.log(`[SUPABASE] Cambio en courses (${payload.eventType}). Invalidando cache...`);
                invalidateCoursesCache();
            }
        )
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('[SUPABASE] Escucha en tiempo real activa para courses.');
            }
            if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
                console.warn('[SUPABASE] Realtime desconectado. Reintentando en 30s...');
                setTimeout(() => {
                    supabase.removeChannel(channel);
                    initRealtimeListener();
                }, 30000);
            }
        });
}

/**
 * Formatea los cursos para inyectar en el prompt de IA
 */
async function getCoursesForPrompt() {
    const courses = await getCourses();
    if (!courses.length) return 'No hay cursos disponibles en este momento.';

    return courses.map(c => {
        const price = c.price ? `$${Number(c.price).toLocaleString('es-CO')} COP` : 'Precio a consultar';
        const type = c.category?.toLowerCase() === 'virtual' ? 'Modalidad: VIRTUAL'
                   : c.category?.toLowerCase() === 'presential' ? 'Modalidad: PRESENCIAL'
                   : `Categoria: ${c.category || 'General'}`;

        return `- **${c.title}** (${type})\n  Precio: ${price}\n  Detalle: ${c.description || 'Consulta para mas detalles'}`;
    }).join('\n\n');
}

/**
 * Obtiene la configuracion del asistente IA (con cache de 5 min)
 */
async function getAIConfig() {
    const now = Date.now();
    if (aiConfigCache && (now - aiConfigCacheTimestamp) < AI_CONFIG_CACHE_TTL) {
        return { ...aiConfigCache };
    }

    try {
        const data = await withRetry(async () => {
            const { data, error } = await supabase
                .from('whatsapp_ai_config')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(1)
                .single();
            if (error) throw error;
            return data;
        });

        if (data) {
            aiConfigCache = data;
            aiConfigCacheTimestamp = now;
            return { ...data };
        }
        return getDefaultConfig();
    } catch (err) {
        console.error('[SUPABASE] Error cargando config IA:', err.message);
        if (aiConfigCache) return { ...aiConfigCache };
        return getDefaultConfig();
    }
}

/**
 * Guarda/actualiza la configuracion del asistente IA
 */
async function saveAIConfig(config) {
    try {
        const { data: existing } = await supabase
            .from('whatsapp_ai_config')
            .select('id')
            .limit(1)
            .single();

        if (existing?.id) {
            const { error } = await supabase
                .from('whatsapp_ai_config')
                .update({ ...config, updated_at: new Date().toISOString() })
                .eq('id', existing.id);
            if (error) throw error;
        } else {
            const { error } = await supabase
                .from('whatsapp_ai_config')
                .insert([config]);
            if (error) throw error;
        }

        // Invalidar cache de config
        aiConfigCache = null;
        aiConfigCacheTimestamp = 0;

        return { success: true };
    } catch (err) {
        console.error('[SUPABASE] Error guardando config IA:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Guarda un mensaje en el historial (no critico, no bloquea el flujo)
 */
async function saveMessage(chatId, phone, direction, message, aiGenerated = false) {
    try {
        const { error } = await supabase.from('whatsapp_messages').insert([{
            chat_id: chatId,
            phone,
            direction,
            message: message?.substring(0, 4000),
            ai_generated: aiGenerated,
            created_at: new Date().toISOString()
        }]);
        if (error) console.error('[SUPABASE] Error guardando mensaje:', error.message);
    } catch (err) {
        console.error('[SUPABASE] Error guardando mensaje:', err.message);
    }
}

/**
 * Obtiene historial de mensajes de un chat
 */
async function getMessageHistory(chatId, limit = 50) {
    try {
        const { data, error } = await supabase
            .from('whatsapp_messages')
            .select('*')
            .eq('chat_id', chatId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return (data || []).reverse();
    } catch (err) {
        console.error('[SUPABASE] Error obteniendo historial:', err.message);
        return [];
    }
}

/**
 * Obtiene los chats recientes desde la BD (para cuando el cache esta vacio)
 */
async function getRecentChats(limit = 50) {
    try {
        const { data: msgs, error } = await supabase
            .from('whatsapp_messages')
            .select('chat_id, phone, message, created_at, direction, ai_generated')
            .order('created_at', { ascending: false })
            .limit(500);

        if (error) throw error;

        const chats = new Map();
        for (const msg of (msgs || [])) {
            if (!chats.has(msg.chat_id)) {
                const isLid = msg.chat_id.includes('@lid');
                const rawPhone = msg.chat_id.replace('@s.whatsapp.net', '').replace('@lid', '');
                chats.set(msg.chat_id, {
                    jid: msg.chat_id,
                    phone: rawPhone,
                    isLid,
                    lastMessage: msg.message,
                    lastTime: new Date(msg.created_at).getTime(),
                    direction: msg.direction,
                    unreadCount: 0
                });
            }
        }

        const chatArray = Array.from(chats.values()).slice(0, limit);
        if (chatArray.length > 0) {
            const phones = chatArray.map(c => c.phone);
            try {
                const { data: crmData } = await supabase
                    .from('whatsapp_crm')
                    .select('phone, name')
                    .in('phone', phones);

                if (crmData) {
                    const nameMap = new Map(crmData.map(c => [c.phone, c.name]));
                    chatArray.forEach(c => {
                        c.name = nameMap.get(c.phone) || (c.isLid ? 'Contacto Anuncio' : c.phone);
                    });
                } else {
                    chatArray.forEach(c => {
                        if (!c.name) c.name = c.isLid ? 'Contacto Anuncio' : c.phone;
                    });
                }
            } catch {
                chatArray.forEach(c => {
                    if (!c.name) c.name = c.isLid ? 'Contacto Anuncio' : c.phone;
                });
            }
        }

        return chatArray;
    } catch (err) {
        console.error('[SUPABASE] Error obteniendo chats recientes:', err.message);
        return [];
    }
}

async function getCRMContact(phone) {
    try {
        const { data } = await supabase
            .from('whatsapp_crm')
            .select('*')
            .eq('phone', phone)
            .single();
        return data || null;
    } catch {
        return null;
    }
}

async function upsertCRMContact(phone, updates) {
    try {
        const existing = await getCRMContact(phone);
        if (existing) {
            const { error } = await supabase
                .from('whatsapp_crm')
                .update({ ...updates, updated_at: new Date().toISOString() })
                .eq('phone', phone);
            if (error) throw error;
        } else {
            const { error } = await supabase
                .from('whatsapp_crm')
                .insert([{ phone, ...updates, created_at: new Date().toISOString() }]);
            if (error) throw error;
        }
    } catch (err) {
        console.error('[SUPABASE] Error en CRM upsert:', err.message);
    }
}

function getDefaultConfig() {
    return {
        auto_reply: true,
        delay_min: 3,
        delay_max: 8,
        tone: 'calida y profesional',
        system_prompt: null,
        openai_api_key: null,
        openai_model: 'gpt-4o',
        max_tokens: 300,
        temperature: 0.85
    };
}

function invalidateCoursesCache() {
    coursesCache = null;
    coursesCacheTimestamp = 0;
}

module.exports = {
    supabase,
    getCourses,
    getCoursesForPrompt,
    getAIConfig,
    saveAIConfig,
    saveMessage,
    getMessageHistory,
    getRecentChats,
    getCRMContact,
    upsertCRMContact,
    invalidateCache: invalidateCoursesCache,
    initRealtimeListener
};
