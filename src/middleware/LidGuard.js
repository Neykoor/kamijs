export class LidGuard {
    static async clean(sock, rawJid) {
        if (!rawJid || typeof rawJid !== 'string') return rawJid;

        const [userPart, domain] = rawJid.split('@');
        const userId = userPart.split(':')[0];
        const normalized = `${userId}@${domain || 's.whatsapp.net'}`.toLowerCase();

        if (!sock?.lid?.resolve) return normalized;

        try {
            const resolved = await sock.lid.resolve(rawJid);
            return (resolved || normalized).toLowerCase();
        } catch (e) {
            console.warn('[kamijs - LidGuard]: Fallo al resolver LID:', e.message);
            return normalized;
        }
    }
}
