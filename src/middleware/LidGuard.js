export class LidGuard {
    /**
     * Normaliza un JID a la forma canónica: número@s.whatsapp.net
     * Elimina el sufijo de dispositivo (:device) si estuviera presente.
     */
    static #normalize(rawJid) {
        if (!rawJid || typeof rawJid !== 'string') return rawJid;
        return rawJid.split(':')[0].split('@')[0] + '@s.whatsapp.net';
    }

    /**
     * Devuelve el JID limpio (canónico).
     * Intenta resolver el LID real via sock; si falla, normaliza el raw.
     */
    static async clean(sock, rawJid) {
        if (!rawJid || typeof rawJid !== 'string') return rawJid;
        if (!sock) return LidGuard.#normalize(rawJid);
        try {
            const resolved = await sock.lid?.resolve(rawJid);
            return resolved ? resolved.toLowerCase() : LidGuard.#normalize(rawJid);
        } catch {
            return LidGuard.#normalize(rawJid);
        }
    }

    /**
     * Devuelve la mención adecuada para un JID dentro de un grupo.
     *
     * - Si el JID es participante del grupo → "@número" (WhatsApp lo convierte en mención)
     * - Si NO está en el grupo            → el número plano (sin @)
     *
     * @param {object} sock      - instancia de Baileys/WA-socket
     * @param {string} jid       - JID del usuario a mencionar
     * @param {string} groupId   - JID del grupo donde se mostrará el mensaje
     * @returns {Promise<string>} - "@número" o "número"
     */
    static async getMention(sock, jid, groupId) {
        const cleanJid = await LidGuard.clean(sock, jid);
        const number = cleanJid.split('@')[0];

        // Sin sock o sin groupId no podemos verificar participantes
        if (!sock || !groupId) return number;

        try {
            const meta = await sock.groupMetadata(groupId);
            const isParticipant = meta.participants.some(p => {
                const pNum = p.id.split(':')[0].split('@')[0];
                return pNum === number;
            });
            return isParticipant ? `@${number}` : number;
        } catch {
            // Si falla la consulta de metadatos, devolvemos número plano
            return number;
        }
    }

    /**
     * Versión sincrónica de getMention para cuando ya se tiene la lista
     * de participantes (evita llamadas repetidas a groupMetadata en loops).
     *
     * @param {string}   jid          - JID del usuario
     * @param {string[]} participants - array de JIDs de participantes del grupo
     * @returns {string} - "@número" o "número"
     */
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
