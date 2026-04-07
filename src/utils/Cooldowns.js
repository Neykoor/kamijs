export class Cooldowns {
    constructor() {
        this.pending = new Map();
    }

    isReady(key, seconds = 60) {
        const now = Date.now();
        const record = this.pending.get(key);
        const last = record ? record.ts : 0;
        const diff = (now - last) / 1000;

        if (diff < seconds) {
            return { ready: false, remaining: Math.ceil(seconds - diff) };
        }

        return { ready: true };
    }

    confirm(key, seconds = 86400) {
        this.pending.set(key, { ts: Date.now(), ttl: seconds * 1000 });

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
