/**
 * ============================================================
 * MESSAGE QUEUE v3 — Anti-Ban Rate Limiter
 * Con proteccion contra race conditions y limites de cola
 * ============================================================
 */

class MessageQueue {
    constructor() {
        this.queues = new Map();
        this.lastSent = new Map();
        this.hourlyCount = new Map();
        this.HOURLY_LIMIT = 20;
        this.MAX_QUEUE_SIZE = 5; // maximo 5 tareas encoladas por chat
        // Flag para saber si una cola esta siendo procesada
        this.processing = new Set();

        setInterval(() => this.resetHourlyCounters(), 3600000);
    }

    enqueue(jid, task) {
        if (!this.queues.has(jid)) {
            this.queues.set(jid, []);
        }

        const queue = this.queues.get(jid);

        // Limite de cola para evitar acumulacion
        if (queue.length >= this.MAX_QUEUE_SIZE) {
            console.warn(`[QUEUE] Cola llena para ${jid} (${queue.length}). Descartando tarea.`);
            return;
        }

        const count = this.hourlyCount.get(jid) || 0;
        if (count >= this.HOURLY_LIMIT) {
            console.warn(`[QUEUE] Limite horario alcanzado para ${jid}. Omitiendo.`);
            return;
        }

        queue.push(task);
        this.hourlyCount.set(jid, count + 1);

        // Solo iniciar procesamiento si no hay uno activo para este jid
        if (!this.processing.has(jid)) {
            this.processQueue(jid);
        }
    }

    async processQueue(jid) {
        if (this.processing.has(jid)) return;
        this.processing.add(jid);

        try {
            const queue = this.queues.get(jid);

            while (queue && queue.length > 0) {
                const task = queue.shift();

                try {
                    await task();
                } catch (err) {
                    // Un error en una tarea no debe bloquear las demas
                    console.error(`[QUEUE] Error en tarea para ${jid}:`, err.message);
                }

                // Delay entre mensajes del mismo chat
                if (queue.length > 0) {
                    const betweenDelay = 1500 + Math.random() * 2000;
                    await sleep(betweenDelay);
                }
            }
        } finally {
            this.processing.delete(jid);
        }
    }

    resetHourlyCounters() {
        this.hourlyCount.clear();
        console.log('[QUEUE] Contadores por hora reiniciados');
    }

    static humanTypingDelay(text) {
        const words = text.trim().split(/\s+/).length;
        const baseTypingTime = words * 400;
        const readDelay = 1500 + Math.random() * 1500;
        const variance = (Math.random() - 0.5) * 1000;
        return Math.min(Math.max(readDelay + baseTypingTime + variance, 2500), 12000);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { MessageQueue, sleep };
