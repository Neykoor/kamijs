export class LidGuard {
    static async clean(sock, rawJid) {
        if (!rawJid || typeof rawJid !== 'string') return rawJid;

        const basic = rawJid.split(':')[0].split('@')[0] + 
                     (rawJid.includes('@g.us') ? '@g.us' : '@s.whatsapp.net');
        
        const normalized = basic.toLowerCase();

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
