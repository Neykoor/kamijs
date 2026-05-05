export class LidGuard {
    static #normalize(raw) {
        return typeof raw === "string" && raw ? `${raw.split(":")[0].split("@")[0]}@s.whatsapp.net` : raw;
    }

    static async clean(sock, raw) {
        if (!raw || typeof raw !== "string") return raw;
        if (!sock || (raw.endsWith("@lid") && sock.lid?.isResolvable && !sock.lid.isResolvable(raw))) {
            return LidGuard.#normalize(raw);
        }
        try {
            return (await sock.lid?.resolve(raw))?.toLowerCase() || LidGuard.#normalize(raw);
        } catch {
            return LidGuard.#normalize(raw);
        }
    }

    static async getMention(sock, jid, groupId) {
        const number = (await LidGuard.clean(sock, jid)).split("@")[0];
        if (!sock || !groupId) return number;
        try {
            const meta = await sock.groupMetadata(groupId);
            return meta.participants.some((p) => p.id.split(":")[0].split("@")[0] === number) ? `@${number}` : number;
        } catch {
            return number;
        }
    }

    static getMentionSync(jid, participants = []) {
        if (!jid || typeof jid !== "string") return "";
        const number = jid.split(":")[0].split("@")[0];
        return participants.some((p) => (typeof p === "string" ? p : p.id || "").split(":")[0].split("@")[0] === number) ? `@${number}` : number;
    }
}
