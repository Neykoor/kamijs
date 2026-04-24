export class LidGuard {
    /**
     * Normaliza un JID de WhatsApp a la forma canónica: número@s.whatsapp.net
     * BUG FIX: el catch anterior devolvía rawJid.toLowerCase() sin normalizar
     * (podía quedar con sufijo :device@s.whatsapp.net).
     */
    static #normalize(rawJid) {
        if (!rawJid || typeof rawJid !== 'string') return rawJid;
        return rawJid.split(':')[0].split('@')[0] + '@s.whatsapp.net';
    }

    static async clean(sock, rawJid) {
        if (!rawJid || typeof rawJid !== 'string') return rawJid;
        if (!sock) return LidGuard.#normalize(rawJid);
        try {
            const resolved = await sock.lid?.resolve(rawJid);
            // Si resolved es falsy (undefined, null, '') usamos el fallback normalizado
            return resolved ? resolved.toLowerCase() : LidGuard.#normalize(rawJid);
        } catch {
            return LidGuard.#normalize(rawJid);
        }
    }
}
