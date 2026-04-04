export class LidGuard {
    static async clean(sock, jid) {
        if (!sock || !jid) return jid;
        return await sock.lid.resolve(jid);
    }
}
