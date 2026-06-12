/**
 * ============================================================
 * AI AGENT v3 — Motor de inteligencia artificial
 * GPT-4o entrenado para hablar como la Dra. Andrea Vargas
 * Con auto-limpieza de memoria, retry, y recuperacion de contexto
 * ============================================================
 */
require('dotenv').config();
const { OpenAI } = require('openai');
const { getAIConfig, getCoursesForPrompt, getCRMContact, getMessageHistory } = require('./supabase-sync');

// Historial de conversacion en memoria { jid: { messages: [{role, content}], lastActivity: timestamp } }
const conversationHistory = new Map();
const MAX_HISTORY = 12;
const HISTORY_TTL = 2 * 60 * 60 * 1000; // 2 horas sin actividad = limpiar
const CLEANUP_INTERVAL = 30 * 60 * 1000; // limpiar cada 30 min

// Cache del cliente OpenAI
let openaiClient = null;
let lastApiKey = null;

// Limpieza periodica de historiales viejos
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [jid, data] of conversationHistory.entries()) {
        if (now - data.lastActivity > HISTORY_TTL) {
            conversationHistory.delete(jid);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`[AI] Limpieza: ${cleaned} historiales expirados eliminados. Activos: ${conversationHistory.size}`);
    }
}, CLEANUP_INTERVAL);

function getOpenAIClient(apiKey) {
    const key = apiKey || process.env.OPENAI_API_KEY;
    if (!key) throw new Error('No hay API key de OpenAI configurada');
    if (openaiClient && lastApiKey === key) return openaiClient;
    openaiClient = new OpenAI({ apiKey: key, timeout: 40000, maxRetries: 2 });
    lastApiKey = key;
    return openaiClient;
}

/**
 * PROMPT MAESTRO — El corazon del asistente
 */
function buildSystemPrompt(coursesInfo, crmData, config) {
    const customPrompt = config?.system_prompt;

    if (customPrompt && customPrompt.trim().length > 100) {
        return customPrompt.replace('{CURSOS}', coursesInfo);
    }

    const clientName = crmData?.name && crmData.name !== crmData?.phone
        ? ` Su nombre es ${crmData.name}.` : '';
    const crmLevel = crmData?.label || 'NUEVO';

    const strategyByLevel = {
        'NUEVO': 'Esta persona acaba de contactar. Tu prioridad es hacer conexion emocional, presentarte y preguntarle su nombre y que la trae por aqui.',
        'INTERESADO': 'Esta persona ha mostrado interes. Profundiza en sus necesidades, comparte mas detalles del curso mas relevante y genera deseo.',
        'CALIENTE': 'Esta persona esta lista para comprar. Se directa, resuelve sus dudas finales, comparte el precio con confianza y guiala al siguiente paso concreto.',
        'CLIENTE': 'Esta persona ya es estudiante. Se su aliada, ayudala con dudas de su curso, hazla sentir parte de la familia academica.'
    };

    return `Eres Andrea Vargas, odontologa estetica colombiana especializada en sonrisas perfectas y educacion dental de alta calidad. Tienes mas de 10 anos transformando sonrisas y una comunidad de estudiantes apasionadas por la odontologia estetica.

Ahora mismo estas respondiendo un mensaje de WhatsApp desde tu telefono.${clientName}

ESTRATEGIA PARA ESTA CONVERSACION:
${strategyByLevel[crmLevel] || strategyByLevel['NUEVO']}

TU PERSONALIDAD:
- Eres calida, cercana, empatica y apasionada por lo que haces
- Hablas en espanol colombiano natural (no forzado)
- Tuteas a las personas de manera natural
- Usas UN emoji maximo por mensaje (y solo si encaja naturalmente)
- Eres directa pero nunca presionante
- Inspiras confianza desde el primer mensaje
- Cuando algo te emociona, se nota en como escribes

COMO ESCRIBES:
- Maximo 3-4 lineas por mensaje (como un WhatsApp real, no un email)
- Sin bullets ni listas largas (eso parece bot)
- Frases cortas y naturales
- Si tienes mucho que decir, lo divides en 2 mensajes (pero solo cuando sea necesario)
- Nunca empiezas con "Hola!" si ya llevan varios mensajes hablando

CURSOS DISPONIBLES EN LA PLATAFORMA:
${coursesInfo}

REGLAS IMPORTANTES:
1. Si te preguntan directamente "eres un bot?" o "eres una IA?", di que eres el asistente personal de la Dra. Andrea y que ella te ha entrenado para ayudar
2. Nunca menciones "sistema", "plataforma", "IA", "ChatGPT" ni nada tecnico
3. Si alguien quiere hablar con la doctora directamente, dile que Andrea esta en consultas pero que le vas a dejar su mensaje y ella responde pronto
4. No inventes informacion que no te hemos dado sobre los cursos
5. Si no sabes algo, di: "Dejame verificar eso y te confirmo"
6. Los precios siempre en pesos colombianos
7. Si hay urgencia (quiere inscribirse), dale el link de la plataforma: https://andreavargas.art/cursos.html

CUANDO ALGUIEN QUIERE INSCRIBIRSE O PAGAR:
- Dales el link directo: https://andreavargas.art/cursos.html
- El proceso es online, rapido (menos de 5 minutos) y 100% seguro
- Garantia de satisfaccion: 7 dias de devolucion sin preguntas

INFORMACION SOBRE LOS CURSOS:
- Ofrecemos cursos TANTO VIRTUALES COMO PRESENCIALES.
- Los cursos virtuales son 100% online, con grabaciones disponibles y acceso de por vida. Se aprenden tecnicas aplicables a la vida real con materiales faciles de conseguir para practicar en casa.
- Los cursos presenciales son inmersivos, con practica directa.
- Hay cupos limitados en ambas modalidades, asi que es mejor asegurar el lugar pronto.

Responde SOLO el siguiente mensaje. No agregues contexto extra. Se tu misma — Andrea.`;
}

/**
 * Genera una respuesta usando GPT-4o con retry y recuperacion de contexto
 */
async function generateResponse(jid, incomingMessage, senderName = '') {
    try {
        const [config, coursesInfo] = await Promise.all([
            getAIConfig(),
            getCoursesForPrompt()
        ]);
        const phone = jid.replace('@s.whatsapp.net', '').replace('@lid', '');
        const crmData = await getCRMContact(phone);
        const client = getOpenAIClient(config?.openai_api_key);

        // Recuperar o crear historial
        let historyEntry = conversationHistory.get(jid);

        // Si no hay historial en memoria, intentar cargar desde BD
        if (!historyEntry || historyEntry.messages.length === 0) {
            historyEntry = { messages: [], lastActivity: Date.now() };
            try {
                const dbMessages = await getMessageHistory(jid, MAX_HISTORY);
                if (dbMessages && dbMessages.length > 0) {
                    historyEntry.messages = dbMessages.map(m => ({
                        role: m.direction === 'incoming' ? 'user' : 'assistant',
                        content: m.message
                    }));
                    console.log(`[AI] Contexto recuperado de BD para ${phone}: ${historyEntry.messages.length} mensajes`);
                }
            } catch (err) {
                console.warn(`[AI] No se pudo cargar historial de BD para ${phone}:`, err.message);
            }
            conversationHistory.set(jid, historyEntry);
        }

        const history = historyEntry.messages;
        history.push({ role: 'user', content: incomingMessage });
        historyEntry.lastActivity = Date.now();

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
            presence_penalty: 0.3,
            frequency_penalty: 0.4,
        });

        const response = completion.choices[0]?.message?.content?.trim();
        if (!response) throw new Error('GPT no retorno respuesta');

        history.push({ role: 'assistant', content: response });
        historyEntry.messages = history.slice(-MAX_HISTORY);
        historyEntry.lastActivity = Date.now();

        console.log(`[AI] Respuesta generada para ${phone} (${response.length} chars)`);
        return response;

    } catch (err) {
        console.error('[AI] Error generando respuesta:', err.message);

        // Mensajes de fallback variados para no parecer bot
        const fallbacks = [
            'Hola! En este momento tengo un problema con la conexion. Me escribes en unos minutos?',
            'Ay disculpa! Se me fue la senal un momento. Dame un minutico y te respondo bien!',
            'Uy perdon! Estoy en consulta y se me complico un poco. Te escribo en un momento!',
        ];
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
}

function clearHistory(jid) {
    conversationHistory.delete(jid);
}

function injectContext(jid, messages) {
    const formatted = messages.map(m => ({
        role: m.direction === 'incoming' ? 'user' : 'assistant',
        content: m.message
    }));
    conversationHistory.set(jid, {
        messages: formatted.slice(-MAX_HISTORY),
        lastActivity: Date.now()
    });
}

/**
 * Genera mensaje de seguimiento proactivo
 */
async function generateFollowUp(jid, crmLevel, senderName) {
    try {
        const [config, coursesInfo] = await Promise.all([
            getAIConfig(),
            getCoursesForPrompt()
        ]);
        const client = getOpenAIClient(config?.openai_api_key);

        const followUpPrompts = {
            CALIENTE: `Eres Andrea Vargas. Le escribiste a ${senderName || 'esta persona'} hace un rato sobre tus cursos y no ha respondido. Mandale un mensaje breve, calido y natural (maximo 2 lineas) para retomar la conversacion con curiosidad genuina. No seas presionante. Recuerda el link si es natural mencionarlo: https://andreavargas.art/cursos.html\n\nCursos disponibles:\n${coursesInfo}`,
            INTERESADO: `Eres Andrea Vargas. Una persona interesada en tus cursos no ha respondido en unas horas. Mandale un mensaje amigable preguntando si tiene alguna duda en la que puedas ayudar. Maximo 2 lineas, muy natural.`
        };

        const prompt = followUpPrompts[crmLevel] || followUpPrompts['INTERESADO'];

        const completion = await client.chat.completions.create({
            model: config?.openai_model || 'gpt-4o',
            messages: [{ role: 'system', content: prompt }],
            max_tokens: 120,
            temperature: 0.9
        });

        return completion.choices[0]?.message?.content?.trim() || null;
    } catch (err) {
        console.error('[AI] Error generando follow-up:', err.message);
        return null;
    }
}

function detectEnrollmentIntent(message) {
    const keywords = ['inscrib', 'comprar', 'pagar', 'link de pago', 'como me anoto', 'quiero el curso', 'quiero inscrib', 'donde pago', 'link del curso', 'como accedo', 'matricul', 'registrar'];
    const lower = message.toLowerCase();
    return keywords.some(kw => lower.includes(kw));
}

module.exports = { generateResponse, clearHistory, injectContext, generateFollowUp, detectEnrollmentIntent };
