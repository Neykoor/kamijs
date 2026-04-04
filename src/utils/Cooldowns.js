export class Cooldowns {
    constructor() {
        this.pending = new Map();
    }

    isReady(jid, type = 'roll', seconds = 60) {
        const key = `${jid}_${type}`;
        const now = Date.now();
        const last = this.pending.get(key) || 0;
        const diff = (now - last) / 1000;

        if (diff < seconds) {
            return { ready: false, remaining: Math.ceil(seconds - diff) };
        }

        return { ready: true };
    }

    confirm(jid, type = 'roll') {
        this.pending.set(`${jid}_${type}`, Date.now());

        if (Math.random() < 0.05) {
            this.#cleanup();
        }
    }

    #cleanup() {
        const now = Date.now();
        const maxAge = 24 * 60 * 60 * 1000; 
        for (const [key, timestamp] of this.pending) {
            if (now - timestamp > maxAge) {
                this.pending.delete(key);
            }
        }
    }
}
