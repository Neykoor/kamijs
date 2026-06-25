export class RateLimiter {
    #cooldowns;
    #lastHits = new Map();
    #sweepEvery;
    #lastSweep = Date.now();

    constructor(cooldowns = {}, options = {}) {
        this.#cooldowns = { ...cooldowns };
        this.#sweepEvery = Number.isInteger(options.sweepEveryMs) && options.sweepEveryMs > 0
            ? options.sweepEveryMs
            : 60_000;
    }

    setCooldown(action, ms) {
        if (!Number.isInteger(ms) || ms < 0) throw new Error("INVALID_COOLDOWN_MS");
        this.#cooldowns[action] = ms;
    }

    getCooldown(action) {
        return this.#cooldowns[action] ?? 0;
    }

    #key(action, jid) {
        return `${action}:${jid}`;
    }

    #maybeSweep() {
        const now = Date.now();
        if (now - this.#lastSweep < this.#sweepEvery) return;
        this.#lastSweep = now;
        for (const [key, lastHit] of this.#lastHits) {
            const action = key.slice(0, key.indexOf(":"));
            const cd = this.#cooldowns[action] ?? 0;
            if (now - lastHit >= cd) this.#lastHits.delete(key);
        }
    }

    check(action, jid) {
        const cd = this.#cooldowns[action];
        if (!cd) return { allowed: true, remainingMs: 0 };

        this.#maybeSweep();

        const key = this.#key(action, jid);
        const last = this.#lastHits.get(key);
        const now = Date.now();

        if (last !== undefined) {
            const elapsed = now - last;
            if (elapsed < cd) return { allowed: false, remainingMs: cd - elapsed };
        }

        return { allowed: true, remainingMs: 0 };
    }

    hit(action, jid) {
        if (!this.#cooldowns[action]) return;
        this.#lastHits.set(this.#key(action, jid), Date.now());
    }

    reset(action, jid) {
        this.#lastHits.delete(this.#key(action, jid));
    }

    clear() {
        this.#lastHits.clear();
    }
}
