/**
 * ============================================================
 * CRM SERVICE — Sistema de clasificación automática
 * Clasifica leads automáticamente según interacción
 * ============================================================
 */
const { getCRMContact, upsertCRMContact } = require('./supabase-sync');

// Palabras clave por nivel de intención
const INTENT_KEYWORDS = {
    CALIENTE: ['precio', 'cuánto', 'cuanto', 'costo', 'pagar', 'inscribir', 'inscripción', 'comprar', 'quiero', 'necesito', 'cuándo empieza', 'cuando empieza', 'disponible', 'inscribirme'],
    INTERESADO: ['información', 'informacion', 'saber', 'cuéntame', 'cuénteme', 'cuentame', 'conocer', 'qué incluye', 'que incluye', 'detalles', 'módulos', 'contenido', 'duración', 'duracion'],
    NUEVO: [] // Cualquier primer contacto
};

// Niveles en orden ascendente
const LEVELS = ['NUEVO', 'INTERESADO', 'CALIENTE', 'CLIENTE'];

/**
 * Analiza un mensaje y determina el nivel de intención
 */
function detectIntent(message) {
    const lower = message.toLowerCase();
    for (const level of ['CALIENTE', 'INTERESADO']) {
        if (INTENT_KEYWORDS[level].some(kw => lower.includes(kw))) {
            return level;
        }
    }
    return null;
}

/**
 * Actualiza el nivel CRM de un contacto (nunca baja de nivel)
 */
async function updateCRMLevel(phone, incomingMessage, detectedName = null) {
    try {
        let crm = await getCRMContact(phone);
        const currentLevelIdx = LEVELS.indexOf(crm?.label || 'NUEVO');
        
        const detectedIntent = detectIntent(incomingMessage);
        const newLevelIdx = detectedIntent ? LEVELS.indexOf(detectedIntent) : currentLevelIdx;
        
        // Solo sube de nivel, nunca baja
        const finalLevelIdx = Math.max(currentLevelIdx, newLevelIdx);
        const finalLabel = LEVELS[finalLevelIdx];
        
        const updates = {
            label: finalLabel,
            interest_level: Math.min(finalLevelIdx + 1, 5),
            last_interaction: new Date().toISOString(),
            conversation_count: (crm?.conversation_count || 0) + 1
        };

        // Actualiza nombre si lo detectamos y no lo teníamos
        if (detectedName && (!crm?.name || crm.name === crm?.phone)) {
            updates.name = detectedName;
        }

        await upsertCRMContact(phone, updates);
        
        const levelChanged = finalLabel !== (crm?.label || 'NUEVO');
        if (levelChanged) {
            console.log(`[CRM] 📈 ${phone} subió a nivel: ${finalLabel}`);
        }

        return { ...crm, ...updates };
    } catch (err) {
        console.error('[CRM] Error actualizando nivel:', err.message);
        return null;
    }
}

/**
 * Marca un contacto como CLIENTE cuando se inscribe a un curso
 */
async function markAsClient(phone) {
    await upsertCRMContact(phone, {
        label: 'CLIENTE',
        interest_level: 5,
        last_interaction: new Date().toISOString()
    });
    console.log(`[CRM] 🏆 ${phone} marcado como CLIENTE`);
}

/**
 * Agrega una nota manual al CRM de un contacto
 */
async function addNote(phone, note) {
    try {
        const crm = await getCRMContact(phone);
        const existingNotes = crm?.notes || '';
        const timestamp = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
        const newNote = `[${timestamp}]: ${note}`;
        const updatedNotes = existingNotes ? `${existingNotes}\n${newNote}` : newNote;
        
        await upsertCRMContact(phone, { notes: updatedNotes });
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * Intenta extraer el nombre de un mensaje de presentación
 * Ej: "Hola, soy María" → "María"
 */
function extractNameFromMessage(message) {
    const patterns = [
        /(?:soy|me llamo|mi nombre es|soy la|soy el)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/i,
        /^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)[\s,!]+(?:hola|buenas|buenos|buen)/i
    ];
    
    for (const pattern of patterns) {
        const match = message.match(pattern);
        if (match && match[1]) return match[1].trim();
    }
    return null;
}

module.exports = {
    updateCRMLevel,
    markAsClient,
    addNote,
    extractNameFromMessage,
    detectIntent
};
