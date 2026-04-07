export class MercyIA {
    static CONFIG = {
        SOFT_PITY_THRESHOLD: 3,
        HARD_PITY_THRESHOLD: 5,
        INTERVENTION_CHANCE: 0.4,
        RICH_THRESHOLD: 50000,
        PREMIUM_VALUE_MIN: 4000
    };

    static shouldIntervene(user) {
        if (!user || typeof user.stress_level !== 'number' || user.stress_level < 0) {
            return false;
        }

        if (user.stress_level >= this.CONFIG.HARD_PITY_THRESHOLD) {
            return true;
        }

        if (user.stress_level >= this.CONFIG.SOFT_PITY_THRESHOLD) {
            return Math.random() < this.CONFIG.INTERVENTION_CHANCE;
        }

        return false;
    }

    static getRollQuery(userBalance = 0) {
        if (userBalance >= this.CONFIG.RICH_THRESHOLD) {
            return {
                sql: "SELECT * FROM characters WHERE value >= ? ORDER BY RANDOM() LIMIT 1",
                params: [this.CONFIG.PREMIUM_VALUE_MIN]
            };
        }

        return {
            sql: "SELECT * FROM characters ORDER BY RANDOM() LIMIT 1",
            params: []
        };
    }
}
