export class EventBus {
    #listeners = new Map();

    on(event, handler) {
        if (typeof handler !== "function") throw new Error("INVALID_HANDLER");
        if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
        this.#listeners.get(event).add(handler);
        return () => this.off(event, handler);
    }

    once(event, handler) {
        const wrapped = (...args) => {
            this.off(event, wrapped);
            handler(...args);
        };
        return this.on(event, wrapped);
    }

    off(event, handler) {
        this.#listeners.get(event)?.delete(handler);
    }

    removeAllListeners(event) {
        if (event) this.#listeners.delete(event);
        else this.#listeners.clear();
    }

    emit(event, payload) {
        const handlers = this.#listeners.get(event);
        if (!handlers || handlers.size === 0) return;
        for (const handler of handlers) {
            try {
                const result = handler(payload);
                if (result && typeof result.catch === "function") {
                    result.catch(err => this.#safeEmitError(event, err));
                }
            } catch (err) {
                this.#safeEmitError(event, err);
            }
        }
    }

    #safeEmitError(sourceEvent, err) {
        if (sourceEvent === "error") return;
        const handlers = this.#listeners.get("error");
        if (!handlers || handlers.size === 0) return;
        for (const handler of handlers) {
            try { handler({ sourceEvent, error: err }); } catch {}
        }
    }
}

export const KAMIJS_EVENTS = Object.freeze({
    PULL: "pull",
    STARTER_CLAIMED: "starterClaimed",
    TICKET_USED: "ticketUsed",
    TICKET_FAILED: "ticketFailed",
    DEPOSIT: "deposit",
    MARKET_LISTED: "marketListed",
    MARKET_DELISTED: "marketDelisted",
    MARKET_BOUGHT: "marketBought",
    TRADE: "trade",
    CHARACTER_RELEASED: "characterReleased",
    CHARACTER_ADDED: "characterAdded",
    CHARACTER_UPDATED: "characterUpdated",
    CHARACTER_REMOVED: "characterRemoved",
    USERS_CLEANED: "usersCleaned",
    ERROR: "error",
});
