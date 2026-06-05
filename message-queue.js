/**
 * ============================================================
 * MESSAGE QUEUE — Anti-Ban Rate Limiter
 * Controla el ritmo de envío para simular comportamiento humano
 * ============================================================
 */

class MessageQueue {
    constructor() {
        // Queue por número de teléfono: { jid: [tasks] }
        this.queues = new Map();
        // Timestamps del último mensaje por jid (anti-spam)
        this.lastSent = new Map();
        // Contador de mensajes por hora por jid
        this.hourlyCount = new Map();
        // Límite máximo de mensajes por hora por chat
        this.HOURLY_LIMIT = 20;
        // Limpia contadores cada hora
        setInterval(() => this.resetHourlyCounters(), 3600000);
    }

    /**
     * Encola una tarea de respuesta IA con delays humanizados
     * @param {string} jid - Número WhatsApp destino
     * @param {Function} task - Función async a ejecutar
     */
    enqueue(jid, task) {
        if (!this.queues.has(jid)) {
            this.queues.set(jid, []);
        }

        // Verificar límite por hora
        const count = this.hourlyCount.get(jid) || 0;
        if (count >= this.HOURLY_LIMIT) {
            console.warn(`[QUEUE] ⚠️ Límite de mensajes alcanzado para ${jid}. Omitiendo.`);
            return;
        }

        this.queues.get(jid).push(task);
        this.hourlyCount.set(jid, count + 1);

        // Si no hay otra tarea corriendo para este jid, procesa
        if (this.queues.get(jid).length === 1) {
            this.processQueue(jid);
        }
    }

    async processQueue(jid) {
        const queue = this.queues.get(jid);
        if (!queue || queue.length === 0) return;

        const task = queue[0];

        try {
            await task();
        } catch (err) {
            console.error(`[QUEUE] Error procesando tarea para ${jid}:`, err.message);
        }

        // Delay ENTRE mensajes del mismo chat (evita spam)
        const betweenDelay = 1500 + Math.random() * 2000;
        await sleep(betweenDelay);

        queue.shift(); // Eliminar tarea procesada
        if (queue.length > 0) {
            this.processQueue(jid); // Procesar siguiente
        }
    }

    resetHourlyCounters() {
        this.hourlyCount.clear();
        console.log('[QUEUE] ✅ Contadores por hora reiniciados');
    }

    /**
     * Calcula delay humanizado basado en longitud del texto
     * Simula velocidad de escritura real (~40 palabras/min)
     */
    static humanTypingDelay(text) {
        const words = text.trim().split(/\s+/).length;
        const baseTypingTime = words * 400; // ~400ms por palabra (lento pero creíble)
        const readDelay = 1500 + Math.random() * 1500; // Simula "leer" el mensaje entrante
        const variance = (Math.random() - 0.5) * 1000; // ±500ms de varianza natural
        return Math.min(Math.max(readDelay + baseTypingTime + variance, 2500), 12000);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { MessageQueue, sleep };
