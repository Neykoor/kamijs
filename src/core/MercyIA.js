export class MercyIA {
    static CONFIG = {
        EROSION_HOURS: 2,
        PITY_THRESHOLD: 3,
        INTERVENTION_CHANCE: 0.4
    };

    static async getProcessedUser(db, jid) {
        let user = await db.get("SELECT * FROM users WHERE jid = ?", [jid]);
        if (!user) return null;

        const now = Date.now();
        const lastInteraction = user.last_interaction || now; 
        const hoursSinceLast = (now - lastInteraction) / (1000 * 60 * 60);

        const erosion = Math.floor(hoursSinceLast / this.CONFIG.EROSION_HOURS);
        
        if (erosion > 0 && user.stress_level > 0) {
            user.stress_level = Math.max(0, user.stress_level - erosion);
            await db.run("UPDATE users SET stress_level = ? WHERE jid = ?", [user.stress_level, jid]);
        }

        return user;
    }

    static shouldIntervene(user) {
        if (!user || user.stress_level < this.CONFIG.PITY_THRESHOLD) return false;
        return Math.random() < this.CONFIG.INTERVENTION_CHANCE;
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
