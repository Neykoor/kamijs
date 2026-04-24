export class LidGuard {
    static async clean(sock, rawJid) {
        if (!rawJid || typeof rawJid !== 'string') return rawJid;
        if (!sock) return rawJid.split(':')[0].split('@')[0] + '@s.whatsapp.net';
        try {
            const resolved = await sock.lid?.resolve(rawJid);
            return (resolved || rawJid.split(':')[0].split('@')[0] + '@s.whatsapp.net').toLowerCase();
        } catch {
            return rawJid.toLowerCase();
        }
    }
}
