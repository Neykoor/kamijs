export class LidGuard {
    static async clean(sock, rawJid) {
        if (!rawJid || typeof rawJid !== 'string') return rawJid;

        if (!sock?.lid?.resolve) {
            const [userPart, domain] = rawJid.split('@');
            const userId = userPart.split(':')[0];
            return `${userId}@${domain || 's.whatsapp.net'}`.toLowerCase();
        }

        try {
            const resolved = await sock.lid.resolve(rawJid);
            
            if (!resolved) {
                const [userPart, domain] = rawJid.split('@');
                const userId = userPart.split(':')[0];
                return `${userId}@${domain || 's.whatsapp.net'}`.toLowerCase();
            }

            return resolved.toLowerCase();
        } catch (e) {
            return rawJid.toLowerCase();
        }
    }
}
