export class LidGuard {
    static #normalize(rawJid) {
        if (!rawJid || typeof rawJid !== 'string') return rawJid;
        return rawJid.split(':')[0].split('@')[0] + '@s.whatsapp.net';
    }

    static async clean(sock, rawJid) {
        if (!rawJid || typeof rawJid !== 'string') return rawJid;
        if (!sock) return LidGuard.#normalize(rawJid);

        if (rawJid.endsWith('@lid') && sock.lid?.isResolvable && !sock.lid.isResolvable(rawJid)) {
            return LidGuard.#normalize(rawJid);
        }

        try {
            const resolved = await sock.lid?.resolve(rawJid);
            return resolved ? resolved.toLowerCase() : LidGuard.#normalize(rawJid);
        } catch {
            return LidGuard.#normalize(rawJid);
        }
    }

    static async getMention(sock, jid, groupId) {
        const cleanJid = await LidGuard.clean(sock, jid);
        const number = cleanJid.split('@')[0];

        if (!sock || !groupId) return number;

        try {
            const meta = await sock.groupMetadata(groupId);
            const isParticipant = meta.participants.some(p => {
                const pNum = p.id.split(':')[0].split('@')[0];
                return pNum === number;
            });
            return isParticipant ? `@${number}` : number;
        } catch {
            return number;
        }
    }

    static getMentionSync(jid, participants = []) {
        if (!jid || typeof jid !== 'string') return '';
        const number = jid.split(':')[0].split('@')[0];
        const isParticipant = participants.some(p => {
            const pNum = (typeof p === 'string' ? p : p.id ?? '')
                .split(':')[0].split('@')[0];
            return pNum === number;
        });
        return isParticipant ? `@${number}` : number;
    }
}
