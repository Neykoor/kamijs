export class MercyIA {
    static CONFIG = {
        SOFT_PITY_THRESHOLD: 3,
        HARD_PITY_THRESHOLD: 5,
        INTERVENTION_CHANCE: 0.4
    };

    static shouldIntervene(user) {
        if (!user) return false;

        if (user.stress_level >= this.CONFIG.HARD_PITY_THRESHOLD) {
            return true;
        }

        if (user.stress_level >= this.CONFIG.SOFT_PITY_THRESHOLD) {
            return Math.random() < this.CONFIG.INTERVENTION_CHANCE;
        }

        return false;
    }

    static getRollQuery(isPity, userBalance = 0) {
        return {
            sql: "SELECT * FROM characters ORDER BY RANDOM() LIMIT 1",
            params: []
        };
    }
}
