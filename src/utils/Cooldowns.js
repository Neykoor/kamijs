export class Cooldowns {
    constructor() {
        this.pending = new Map();
    }

    isReady(key) {
        const now = Date.now();
        const record = this.pending.get(key);
        
        if (!record) return { ready: true };

        const diff = now - record.ts;
        if (diff < record.ttl) {
            return { 
                ready: false, 
                remaining: Math.ceil((record.ttl - diff) / 1000) 
            };
        }

        return { ready: true };
    }

    confirm(key, seconds = 60) {
        this.pending.set(key, { 
            ts: Date.now(), 
            ttl: seconds * 1000 
        });

        if (Math.random() < 0.05) {
            this.#cleanup();
        }
    }

    #cleanup() {
        const now = Date.now();
        for (const [key, { ts, ttl }] of this.pending) {
            if (now - ts > ttl) {
                this.pending.delete(key);
            }
        }
    }
}
