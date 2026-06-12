/**
 * ============================================================
 * CRM SERVICE v4 — Clasificacion inteligente de leads
 * Deteccion de intencion, objeciones, urgencia, saludos
 * ============================================================
 */
const { getCRMContact, upsertCRMContact } = require('./supabase-sync');

// ── KEYWORDS POR NIVEL DE INTENCION ──────────────────────────
const INTENT_KEYWORDS = {
    CALIENTE: [
        // Precio y dinero
        'precio', 'cuanto', 'cuánto', 'costo', 'valor', 'cuanto vale', 'cuánto vale',
        'cuanto cuesta', 'cuánto cuesta', 'que precio', 'qué precio',
        // Pago y metodos
        'pagar', 'pago', 'transferencia', 'nequi', 'daviplata', 'bancolombia',
        'tarjeta', 'cuotas', 'financiar', 'financiacion', 'financiación',
        'link de pago', 'donde pago', 'dónde pago', 'como pago', 'cómo pago',
        // Inscripcion
        'inscribir', 'inscripción', 'inscripcion', 'inscribirme',
        'comprar', 'matricul', 'registrar', 'registrarme',
        'como me inscribo', 'cómo me inscribo', 'como me anoto', 'cómo me anoto',
        'como accedo', 'cómo accedo', 'como entro', 'cómo entro',
        // Intencion directa
        'quiero el curso', 'me interesa el curso', 'quiero inscribirme',
        'quiero comprar', 'quiero pagar', 'lo quiero', 'me lo llevo',
        'separar cupo', 'reservar cupo', 'reservar', 'apartar',
        // Disponibilidad
        'cuándo empieza', 'cuando empieza', 'cuando inicia', 'cuándo inicia',
        'hay cupos', 'quedan cupos', 'disponible', 'disponibilidad',
        'proxima fecha', 'próxima fecha', 'siguiente grupo',
        // Descuentos
        'descuento', 'promocion', 'promoción', 'oferta', 'rebaja',
    ],
    INTERESADO: [
        // Informacion general
        'información', 'informacion', 'info', 'mas informacion', 'más información',
        'saber', 'cuéntame', 'cuénteme', 'cuentame', 'cuenteme',
        'conocer', 'me gustaria saber', 'me gustaría saber',
        // Contenido del curso
        'qué incluye', 'que incluye', 'que trae', 'qué trae',
        'detalles', 'módulos', 'modulos', 'contenido', 'temario',
        'programa', 'pensum', 'plan de estudios', 'syllabus',
        // Duracion y formato
        'duración', 'duracion', 'cuanto dura', 'cuánto dura',
        'horario', 'horarios', 'presencial', 'virtual', 'online',
        'grabaciones', 'acceso de por vida', 'para siempre',
        // Requisitos
        'materiales', 'requisitos', 'experiencia necesaria',
        'necesito saber', 'que necesito', 'qué necesito',
        // Credenciales
        'certificado', 'certificacion', 'certificación', 'diploma',
        'aval', 'titulo', 'título',
        // Sobre la doctora
        'quién dicta', 'quien dicta', 'profesora', 'instructora',
        'experiencia', 'trayectoria',
        // Cursos especificos
        'carillas', 'resina', 'porcelana', 'estetica', 'estética',
        'sonrisa', 'blanqueamiento', 'diseño de sonrisa',
        // Comparacion
        'a diferencia', 'que tiene de diferente', 'por que este curso',
    ],
    NUEVO: []
};

// ── KEYWORDS DE OBJECION (para contexto del CRM) ────────────
const OBJECTION_KEYWORDS = {
    PRECIO: ['caro', 'costoso', 'muy caro', 'no tengo plata', 'no me alcanza', 'mucho dinero', 'presupuesto', 'no puedo pagar'],
    TIEMPO: ['no tengo tiempo', 'estoy ocupad', 'muy ocupad', 'no me da tiempo', 'agenda llena', 'despues', 'después', 'mas adelante', 'más adelante', 'otro momento'],
    DUDA: ['no estoy segur', 'lo voy a pensar', 'pensarlo', 'no se si', 'no sé si', 'será que', 'sera que', 'valdra la pena', 'valdrá la pena'],
};

const LEVELS = ['NUEVO', 'INTERESADO', 'CALIENTE', 'CLIENTE'];

function normalizeText(text) {
    return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function detectIntent(message) {
    const normalized = normalizeText(message);
    for (const level of ['CALIENTE', 'INTERESADO']) {
        const found = INTENT_KEYWORDS[level].some(kw => {
            return normalized.includes(normalizeText(kw));
        });
        if (found) return level;
    }
    return null;
}

function detectObjection(message) {
    const normalized = normalizeText(message);
    for (const [type, keywords] of Object.entries(OBJECTION_KEYWORDS)) {
        const found = keywords.some(kw => normalized.includes(normalizeText(kw)));
        if (found) return type;
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

        // Detectar objeciones y agregarlas como tag
        const objection = detectObjection(incomingMessage);
        if (objection) {
            const currentTags = crm?.tags || [];
            const objTag = `OBJECION_${objection}`;
            if (!currentTags.includes(objTag)) {
                updates.tags = [...currentTags, objTag];
            }
        }

        await upsertCRMContact(phone, updates);

        const levelChanged = finalLabel !== (crm?.label || 'NUEVO');
        if (levelChanged) {
            console.log(`[CRM] ${phone} subio a nivel: ${finalLabel}`);
        }
        if (objection) {
            console.log(`[CRM] ${phone} objecion detectada: ${objection}`);
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
        /(?:habla|escribe|te escribe|le escribe)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i,
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
    detectIntent,
    detectObjection
};
