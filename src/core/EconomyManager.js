export class EconomyManager {
    static async processClaim(db, jid, charId) {
        await db.run("BEGIN IMMEDIATE");
        
        try {
            const char = await db.get("SELECT value, owner_id FROM characters WHERE id = ?", [charId]);
            
            if (!char) throw new Error('CHARACTER_NOT_FOUND');
            if (char.owner_id !== null) throw new Error('ALREADY_CLAIMED');

            
            const userUpdate = await db.run(`
                UPDATE users 
                SET balance = balance - ?, stress_level = 0, last_interaction = ? 
                WHERE jid = ? AND balance >= ?
            `, [char.value, Date.now(), jid, char.value]);

            if (userUpdate.changes === 0) {
                throw new Error('INSUFFICIENT_FUNDS');
            }

            await db.run("UPDATE characters SET owner_id = ? WHERE id = ?", [jid, charId]);
            
            await db.run("COMMIT");
            
            return {
                success: true,
                characterValue: char.value,
                characterId: charId
            };
            
        } catch (e) {
            await db.run("ROLLBACK").catch(() => {});
            throw e;
        }
    }
}
