export class Cooldowns {
    constructor() {
        this.pending = new Map();
    }

    isReady(jid, type = 'roll', seconds = 60) {
        const now = Date.now();
        const last = this.pending.get(`${jid}_${type}`) || 0;
        const diff = (now - last) / 1000;

        return diff >= seconds ? { ready: true } : { ready: false, remaining: Math.ceil(seconds - diff) };
    }

    confirm(jid, type = 'roll') {
        this.pending.set(`${jid}_${type}`, Date.now());
    }
}
