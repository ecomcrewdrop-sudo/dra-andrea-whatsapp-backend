/**
 * ============================================================
 * CRM SERVICE v3 — Sistema de clasificacion automatica
 * Con deteccion de intencion mejorada y extraccion de nombres robusta
 * ============================================================
 */
const { getCRMContact, upsertCRMContact } = require('./supabase-sync');

const INTENT_KEYWORDS = {
    CALIENTE: [
        'precio', 'cuanto', 'cuánto', 'costo', 'valor',
        'pagar', 'pago', 'inscribir', 'inscripción', 'inscripcion',
        'comprar', 'quiero', 'necesito', 'matricul',
        'cuándo empieza', 'cuando empieza', 'cuando inicia', 'cuándo inicia',
        'disponible', 'inscribirme', 'registrarme', 'registrar',
        'link de pago', 'donde pago', 'dónde pago', 'como pago', 'cómo pago',
        'transferencia', 'nequi', 'daviplata', 'bancolombia',
        'tarjeta', 'cuotas', 'financiar', 'descuento', 'promocion', 'promoción',
        'quiero el curso', 'me interesa el curso', 'quiero inscribirme',
        'como me inscribo', 'cómo me inscribo', 'como accedo', 'cómo accedo'
    ],
    INTERESADO: [
        'información', 'informacion', 'info',
        'saber', 'cuéntame', 'cuénteme', 'cuentame', 'cuenteme',
        'conocer', 'qué incluye', 'que incluye',
        'detalles', 'módulos', 'modulos', 'contenido',
        'duración', 'duracion', 'cuanto dura', 'cuánto dura',
        'temario', 'programa', 'pensum', 'plan de estudios',
        'certificado', 'certificacion', 'certificación', 'diploma',
        'horario', 'horarios', 'presencial', 'virtual', 'online',
        'materiales', 'requisitos', 'experiencia necesaria',
        'quién dicta', 'quien dicta', 'profesora', 'instructora'
    ],
    NUEVO: []
};

const LEVELS = ['NUEVO', 'INTERESADO', 'CALIENTE', 'CLIENTE'];

function detectIntent(message) {
    const lower = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    for (const level of ['CALIENTE', 'INTERESADO']) {
        const found = INTENT_KEYWORDS[level].some(kw => {
            const normalizedKw = kw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            return lower.includes(normalizedKw);
        });
        if (found) return level;
    }
    return null;
}

async function updateCRMLevel(phone, incomingMessage, detectedName = null) {
    try {
        let crm = await getCRMContact(phone);
        const currentLevelIdx = LEVELS.indexOf(crm?.label || 'NUEVO');

        const detectedIntent = detectIntent(incomingMessage);
        const newLevelIdx = detectedIntent ? LEVELS.indexOf(detectedIntent) : currentLevelIdx;

        const finalLevelIdx = Math.max(currentLevelIdx, newLevelIdx);
        const finalLabel = LEVELS[finalLevelIdx];

        const updates = {
            label: finalLabel,
            interest_level: Math.min(finalLevelIdx + 1, 5),
            last_interaction: new Date().toISOString(),
            conversation_count: (crm?.conversation_count || 0) + 1
        };

        if (detectedName && (!crm?.name || crm.name === crm?.phone)) {
            updates.name = detectedName;
        }

        await upsertCRMContact(phone, updates);

        const levelChanged = finalLabel !== (crm?.label || 'NUEVO');
        if (levelChanged) {
            console.log(`[CRM] ${phone} subio a nivel: ${finalLabel}`);
        }

        return { ...crm, ...updates };
    } catch (err) {
        console.error('[CRM] Error actualizando nivel:', err.message);
        return null;
    }
}

async function markAsClient(phone) {
    await upsertCRMContact(phone, {
        label: 'CLIENTE',
        interest_level: 5,
        last_interaction: new Date().toISOString()
    });
    console.log(`[CRM] ${phone} marcado como CLIENTE`);
}

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

function extractNameFromMessage(message) {
    const patterns = [
        /(?:soy|me llamo|mi nombre es|soy la|soy el)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/i,
        /^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)[\s,!]+(?:hola|buenas|buenos|buen)/i,
        /(?:hola|buenas|buenos|buen\w*)[,!.\s]+(?:soy|me llamo)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i,
        /(?:hola|buenas)[,!\s]+(?:mi nombre es|me llamo)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/i,
        /(?:habla|escribe|te escribe)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i,
    ];

    for (const pattern of patterns) {
        const match = message.match(pattern);
        if (match && match[1] && match[1].length >= 2) return match[1].trim();
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
