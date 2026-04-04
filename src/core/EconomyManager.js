export class EconomyManager {
    static async processClaim(db, jid, charId) {
        await db.run("BEGIN IMMEDIATE");
        
        try {
            const char = await db.get("SELECT value, owner_id FROM characters WHERE id = ?", [charId]);
            if (!char || char.owner_id !== null) {
                throw new Error('ALREADY_CLAIMED');
            }

            const user = await db.get("SELECT yenes FROM users WHERE jid = ?", [jid]);
            if (!user || user.yenes < char.value) {
                throw new Error('INSUFFICIENT_FUNDS');
            }

            await db.run("UPDATE users SET yenes = yenes - ?, stress_level = 0, last_interaction = ? WHERE jid = ?", 
                [char.value, Date.now(), jid]);
            await db.run("UPDATE characters SET owner_id = ? WHERE id = ?", [jid, charId]);
            
            await db.run("COMMIT");
            return true;
            
        } catch (e) {
            await db.run("ROLLBACK");
            throw e;
        }
    }
}
