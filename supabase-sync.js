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
            .select('id, title, description, price, category, status, image_url')
            .eq('status', 'active')
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
 * Formatea los cursos para inyectar en el prompt de IA
 */
async function getCoursesForPrompt() {
    const courses = await getCourses();
    if (!courses.length) return 'No hay cursos disponibles en este momento.';

    return courses.map(c => {
        const price = c.price ? `$${Number(c.price).toLocaleString('es-CO')} COP` : 'Precio a consultar';
        return `- **${c.title}**: ${c.description?.substring(0, 120) || 'Curso profesional'}... | Precio: ${price}`;
    }).join('\n');
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
    getCRMContact,
    upsertCRMContact,
    invalidateCache
};
