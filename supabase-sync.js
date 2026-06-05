/**
 * ============================================================
 * SUPABASE SYNC — Sincronización con la plataforma
 * Lee cursos, precios y config desde la BD en tiempo real
 * ============================================================
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// Cache local para no sobrecargar la BD
let coursesCache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutos

/**
 * Obtiene todos los cursos activos (con caché)
 */
async function getCourses() {
    const now = Date.now();
    if (coursesCache && (now - cacheTimestamp) < CACHE_TTL) {
        return coursesCache;
    }

    try {
        const { data, error } = await supabase
            .from('courses')
            .select('id, title, description, price, category, active, image_url')
            .eq('active', true)
            .order('created_at', { ascending: false });

        if (error) throw error;

        coursesCache = data || [];
        cacheTimestamp = now;
        console.log(`[SUPABASE] ✅ ${coursesCache.length} cursos cargados al caché`);
        return coursesCache;
    } catch (err) {
        console.error('[SUPABASE] Error cargando cursos:', err.message);
        return coursesCache || []; // Retorna caché viejo si hay error
    }
}

/**
 * Inicializa la escucha en tiempo real para mantener el bot sincronizado con la BD
 */
function initRealtimeListener() {
    supabase
        .channel('custom-courses-channel')
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'courses' },
            (payload) => {
                console.log('[SUPABASE] 🔄 Cambio detectado en tabla courses (Evento:', payload.eventType, '). Invalidando caché...');
                invalidateCache();
            }
        )
        .subscribe();
    console.log('[SUPABASE] 📡 Escucha en tiempo real activada para tabla courses.');
}

/**
 * Formatea los cursos para inyectar en el prompt de IA con el máximo nivel de detalle
 */
async function getCoursesForPrompt() {
    const courses = await getCourses();
    if (!courses.length) return 'No hay cursos disponibles en este momento.';

    return courses.map(c => {
        const price = c.price ? `$${Number(c.price).toLocaleString('es-CO')} COP` : 'Precio a consultar';
        const type = c.category?.toLowerCase() === 'virtual' ? 'Modalidad: VIRTUAL' 
                   : c.category?.toLowerCase() === 'presential' ? 'Modalidad: PRESENCIAL' 
                   : `Categoría: ${c.category || 'General'}`;
        
        return `- **${c.title}** (${type})\n  Precio: ${price}\n  Detalle: ${c.description || 'Consulta para más detalles'}`;
    }).join('\n\n');
}

/**
 * Obtiene la configuración del asistente IA
 */
async function getAIConfig() {
    try {
        const { data, error } = await supabase
            .from('whatsapp_ai_config')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (error || !data) {
            // Configuración por defecto si no existe
            return getDefaultConfig();
        }
        return data;
    } catch (err) {
        console.error('[SUPABASE] Error cargando config IA:', err.message);
        return getDefaultConfig();
    }
}

/**
 * Guarda/actualiza la configuración del asistente IA
 */
async function saveAIConfig(config) {
    try {
        // Verificar si ya existe
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
        return { success: true };
    } catch (err) {
        console.error('[SUPABASE] Error guardando config IA:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Guarda un mensaje en el historial
 */
async function saveMessage(chatId, phone, direction, message, aiGenerated = false) {
    try {
        await supabase.from('whatsapp_messages').insert([{
            chat_id: chatId,
            phone,
            direction,
            message: message?.substring(0, 4000), // Límite seguro
            ai_generated: aiGenerated,
            created_at: new Date().toISOString()
        }]);
    } catch (err) {
        // No crítico — no cortar el flujo por esto
        console.error('[SUPABASE] Error guardando mensaje:', err.message);
    }
}

/**
 * Obtiene historial de mensajes de un chat (últimos N)
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
 * Obtiene los chats recientes agrupados desde el historial de la BD
 * Esto es necesario porque al reiniciar el servidor, Baileys no re-descarga chats antiguos.
 */
async function getRecentChats(limit = 50) {
    try {
        // En Supabase no hay GROUP BY nativo simple vía SDK sin RPC, así que ordenamos
        // y agrupamos en memoria, o usamos una vista. Para hacerlo robusto y simple,
        // traemos los últimos 500 mensajes y los agrupamos por chat_id.
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
                    isLid: isLid,
                    lastMessage: msg.message,
                    lastTime: new Date(msg.created_at).getTime(),
                    direction: msg.direction,
                    unreadCount: 0 // Si queremos podríamos calcularlo, pero dejémoslo en 0 para historicos
                });
            }
        }

        // Consultamos los nombres en el CRM para esos números
        const chatArray = Array.from(chats.values()).slice(0, limit);
        if (chatArray.length > 0) {
            const phones = chatArray.map(c => c.phone);
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
        }

        return chatArray;
    } catch (err) {
        console.error('[SUPABASE] Error obteniendo chats recientes:', err.message);
        return [];
    }
}

/**
 * Obtiene datos CRM de un contacto
 */
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

/**
 * Actualiza datos CRM de un contacto
 */
async function upsertCRMContact(phone, updates) {
    try {
        const existing = await getCRMContact(phone);
        if (existing) {
            await supabase
                .from('whatsapp_crm')
                .update({ ...updates, updated_at: new Date().toISOString() })
                .eq('phone', phone);
        } else {
            await supabase
                .from('whatsapp_crm')
                .insert([{ phone, ...updates, created_at: new Date().toISOString() }]);
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
        tone: 'cálida y profesional',
        system_prompt: null, // Se genera dinámicamente en ai-agent.js
        openai_api_key: null, // Usa variable de entorno si es null
        openai_model: 'gpt-4o',
        max_tokens: 300,
        temperature: 0.85
    };
}

// Invalida caché cuando se actualiza un curso
function invalidateCache() {
    coursesCache = null;
    cacheTimestamp = 0;
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
    invalidateCache,
    initRealtimeListener
};
