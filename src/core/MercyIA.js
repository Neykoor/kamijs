export class MercyIA {
    static async getProcessedUser(db, jid) {
        let user = await db.get("SELECT * FROM users WHERE jid = ?", [jid]);
        if (!user) return null;

        const now = Date.now();
        const lastInteraction = user.last_interaction || now; 
        const hoursSinceLast = (now - lastInteraction) / (1000 * 60 * 60);

        const erosion = Math.floor(hoursSinceLast / 2);
        
        if (erosion > 0 && user.stress_level > 0) {
            user.stress_level = Math.max(0, user.stress_level - erosion);
            await db.run("UPDATE users SET stress_level = ? WHERE jid = ?", [user.stress_level, jid]);
        }

        return user;
    }

    static shouldIntervene(user) {
        return user && user.stress_level >= 3 && Math.random() < 0.4;
    }

    static getRollQuery(isPity, userBalance) {
        if (isPity) {
            return {
                sql: "SELECT * FROM characters WHERE owner_id IS NULL AND value <= ? ORDER BY RANDOM() LIMIT 1",
                params: [userBalance]
            };
        }
        return {
            sql: "SELECT * FROM characters ORDER BY RANDOM() LIMIT 1",
            params: []
        };
    }
}
