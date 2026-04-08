export class MercyIA {
    static CONFIG = {
        SOFT_PITY_THRESHOLD: 3,
        HARD_PITY_THRESHOLD: 5,
        INTERVENTION_CHANCE: 0.4,
        RICH_THRESHOLD: 50000,
        PREMIUM_VALUE_MIN: 4000
    };

    static shouldIntervene(user) {
        if (!user || typeof user.stress_level !== 'number') return false;
        if (user.stress_level >= this.CONFIG.HARD_PITY_THRESHOLD) return true;
        if (user.stress_level >= this.CONFIG.SOFT_PITY_THRESHOLD) {
            return Math.random() < this.CONFIG.INTERVENTION_CHANCE;
        }
        return false;
    }

    static getRollQuery(isPity, userBalance, groupId = 'global') {
        const base = "SELECT c.* FROM characters c LEFT JOIN claims cl ON c.id = cl.char_id AND cl.group_id = ? WHERE cl.owner_jid IS NULL";
        
        if (isPity || userBalance < this.CONFIG.RICH_THRESHOLD) {
            return {
                sql: `${base} ORDER BY RANDOM() LIMIT 1`,
                params: [groupId]
            };
        }

        return {
            sql: `${base} AND c.value >= ? ORDER BY RANDOM() LIMIT 1`,
            params: [groupId, this.CONFIG.PREMIUM_VALUE_MIN]
        };
    }
}
