/**
 * ============================================================
 * AI AGENT — Motor de inteligencia artificial
 * GPT-4o entrenado para hablar como la Dra. Andrea Vargas
 * Humano, cálido, estratégico — nunca robótico
 * ============================================================
 */
require('dotenv').config();
const { OpenAI } = require('openai');
const { getAIConfig, getCoursesForPrompt, getCRMContact } = require('./supabase-sync');

// Mapa de historial de conversación en memoria { jid: [{role, content}] }
const conversationHistory = new Map();
const MAX_HISTORY = 12; // Últimos 12 mensajes para contexto

// Cache del cliente OpenAI (se recrea si cambia la API key)
let openaiClient = null;
let lastApiKey = null;

function getOpenAIClient(apiKey) {
    const key = apiKey || process.env.OPENAI_API_KEY;
    if (!key) throw new Error('No hay API key de OpenAI configurada');
    if (openaiClient && lastApiKey === key) return openaiClient;
    openaiClient = new OpenAI({ apiKey: key });
    lastApiKey = key;
    return openaiClient;
}

/**
 * PROMPT MAESTRO — El corazón del asistente
 * Diseñado para sonar completamente humano y estratégico
 */
function buildSystemPrompt(coursesInfo, crmData, config) {
    const customPrompt = config?.system_prompt;
    
    // Si la doctora definió un prompt personalizado, úsalo (pero inyecta cursos)
    if (customPrompt && customPrompt.trim().length > 100) {
        return customPrompt.replace('{CURSOS}', coursesInfo);
    }

    const clientName = crmData?.name && crmData.name !== crmData?.phone
        ? ` Su nombre es ${crmData.name}.` : '';
    const crmLevel = crmData?.label || 'NUEVO';
    
    const strategyByLevel = {
        'NUEVO': 'Esta persona acaba de contactar. Tu prioridad es hacer conexión emocional, presentarte y preguntarle su nombre y qué la trae por aquí.',
        'INTERESADO': 'Esta persona ha mostrado interés. Profundiza en sus necesidades, comparte más detalles del curso más relevante y genera deseo.',
        'CALIENTE': 'Esta persona está lista para comprar. Sé directa, resuelve sus dudas finales, comparte el precio con confianza y guíala al siguiente paso concreto.',
        'CLIENTE': 'Esta persona ya es estudiante. Sé su aliada, ayúdala con dudas de su curso, hazla sentir parte de la familia académica.'
    };

    return `Eres Andrea Vargas, odontóloga estética colombiana especializada en sonrisas perfectas y educación dental de alta calidad. Tienes más de 10 años transformando sonrisas y una comunidad de estudiantes apasionadas por la odontología estética.

Ahora mismo estás respondiendo un mensaje de WhatsApp desde tu teléfono.${clientName}

ESTRATEGIA PARA ESTA CONVERSACIÓN:
${strategyByLevel[crmLevel] || strategyByLevel['NUEVO']}

TU PERSONALIDAD:
- Eres cálida, cercana, empática y apasionada por lo que haces
- Hablas en español colombiano natural (no forzado)
- Tuteas a las personas de manera natural
- Usas UN emoji máximo por mensaje (y solo si encaja naturalmente)
- Eres directa pero nunca presionante
- Inspiras confianza desde el primer mensaje
- Cuando algo te emociona, se nota en cómo escribes

CÓMO ESCRIBES:
- Máximo 3-4 líneas por mensaje (como un WhatsApp real, no un email)
- Sin bullets ni listas largas (eso parece bot)
- Frases cortas y naturales
- Si tienes mucho que decir, lo divides en 2 mensajes (pero solo cuando sea necesario)
- Nunca empiezas con "¡Hola!" si ya llevan varios mensajes hablando

CURSOS DISPONIBLES EN LA PLATAFORMA:
${coursesInfo}

REGLAS IMPORTANTES:
1. Si te preguntan directamente "¿eres un bot?" o "¿eres una IA?", di que eres el asistente personal de la Dra. Andrea y que ella te ha entrenado para ayudar
2. Nunca menciones "sistema", "plataforma", "IA", "ChatGPT" ni nada técnico
3. Si alguien quiere hablar con la doctora directamente, dile que Andrea está en consultas pero que le vas a dejar su mensaje y ella responde pronto
4. No inventes información que no te hemos dado sobre los cursos
5. Si no sabes algo, di: "Déjame verificar eso y te confirmo 🙂"
6. Los precios siempre en pesos colombianos
7. Si hay urgencia (quiere inscribirse), dale el link de la plataforma: la URL de cursos del sitio web

Responde SOLO el siguiente mensaje. No agregues contexto extra. Sé tú misma — Andrea.`;
}

/**
 * Genera una respuesta usando GPT-4o
 * @param {string} jid - ID del chat WhatsApp
 * @param {string} incomingMessage - Mensaje del usuario
 * @param {string} senderName - Nombre del contacto en WA
 * @returns {string} Respuesta generada
 */
async function generateResponse(jid, incomingMessage, senderName = '') {
    try {
        const config = await getAIConfig();
        const coursesInfo = await getCoursesForPrompt();
        const phone = jid.replace('@s.whatsapp.net', '');
        const crmData = await getCRMContact(phone);

        const client = getOpenAIClient(config?.openai_api_key);

        // Construir historial de esta conversación
        if (!conversationHistory.has(jid)) {
            conversationHistory.set(jid, []);
        }
        const history = conversationHistory.get(jid);

        // Agregar mensaje del usuario al historial
        history.push({ role: 'user', content: incomingMessage });

        // Mantener solo los últimos N mensajes
        const trimmedHistory = history.slice(-MAX_HISTORY);

        const systemPrompt = buildSystemPrompt(coursesInfo, crmData, config);

        const messages = [
            { role: 'system', content: systemPrompt },
            ...trimmedHistory
        ];

        const completion = await client.chat.completions.create({
            model: config?.openai_model || 'gpt-4o',
            messages,
            max_tokens: config?.max_tokens || 300,
            temperature: config?.temperature || 0.85,
            presence_penalty: 0.3,  // Evita repetirse
            frequency_penalty: 0.4, // Evita frases repetitivas
        });

        const response = completion.choices[0]?.message?.content?.trim();
        if (!response) throw new Error('GPT no retornó respuesta');

        // Agregar respuesta de Andrea al historial
        history.push({ role: 'assistant', content: response });

        // Actualizar historial (trim de nuevo tras agregar respuesta)
        conversationHistory.set(jid, history.slice(-MAX_HISTORY));

        console.log(`[AI] ✅ Respuesta generada para ${phone} (${response.length} chars)`);
        return response;

    } catch (err) {
        console.error('[AI] ❌ Error generando respuesta:', err.message);
        // Respuesta de fallback humana (no revelar error técnico)
        return 'Hola! En este momento tengo un problema con la conexión 🙈 ¿Me escribes en unos minutos? ¡Gracias por la paciencia!';
    }
}

/**
 * Limpia el historial de un chat (cuando se resetea manualmente)
 */
function clearHistory(jid) {
    conversationHistory.delete(jid);
}

/**
 * Inyecta un mensaje de contexto al inicio de un chat
 * Útil para retomar conversaciones pasadas
 */
function injectContext(jid, messages) {
    const formatted = messages.map(m => ({
        role: m.direction === 'incoming' ? 'user' : 'assistant',
        content: m.message
    }));
    conversationHistory.set(jid, formatted.slice(-MAX_HISTORY));
}

module.exports = { generateResponse, clearHistory, injectContext };
