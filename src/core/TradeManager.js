import crypto from 'crypto';

export class TradeManager {
    static activeTrades = new Map();

    static async initiate(db, proposerJid, targetJid, offeredCharId, requestedCharId) {
        if (proposerJid === targetJid) throw new Error('SELF_TRADE');

        const offered = await db.get("SELECT owner_id FROM characters WHERE id = ?", [offeredCharId]);
        const requested = await db.get("SELECT owner_id FROM characters WHERE id = ?", [requestedCharId]);

        if (!offered || offered.owner_id !== proposerJid) throw new Error('OFFERED_CHAR_NOT_OWNED');
        if (!requested || requested.owner_id !== targetJid) throw new Error('REQUESTED_CHAR_NOT_OWNED');

        const tradeId = crypto.randomBytes(3).toString('hex'); 
        
        const tradeData = {
            id: tradeId,
            proposerJid,
            targetJid,
            offeredCharId,
            requestedCharId,
            expiresAt: Date.now() + (5 * 60 * 1000) 
        };

        this.activeTrades.set(tradeId, tradeData);

        setTimeout(() => {
            if (this.activeTrades.has(tradeId)) {
                this.activeTrades.delete(tradeId);
            }
        }, 5 * 60 * 1000);

        return tradeData;
    }

    static async confirm(db, tradeId, confirmerJid) {
        const trade = this.activeTrades.get(tradeId);
        
        if (!trade) throw new Error('TRADE_NOT_FOUND_OR_EXPIRED');
        if (trade.targetJid !== confirmerJid) throw new Error('UNAUTHORIZED_CONFIRMATION');

        await db.run("BEGIN IMMEDIATE");
        
        try {
            const offered = await db.get("SELECT owner_id FROM characters WHERE id = ?", [trade.offeredCharId]);
            const requested = await db.get("SELECT owner_id FROM characters WHERE id = ?", [trade.requestedCharId]);

            if (!offered || !requested || offered.owner_id !== trade.proposerJid || requested.owner_id !== trade.targetJid) {
                this.activeTrades.delete(tradeId);
                throw new Error('OWNERSHIP_CHANGED_DURING_TRADE');
            }

            await db.run("UPDATE characters SET owner_id = ? WHERE id = ?", [trade.targetJid, trade.offeredCharId]);
            await db.run("UPDATE characters SET owner_id = ? WHERE id = ?", [trade.proposerJid, trade.requestedCharId]);

            await db.run(`
                INSERT INTO trade_history (id, proposer_jid, target_jid, offered_char, requested_char, timestamp)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [trade.id, trade.proposerJid, trade.targetJid, trade.offeredCharId, trade.requestedCharId, Date.now()]);

            await db.run("COMMIT");
            this.activeTrades.delete(tradeId);
            
            return true;
        } catch (e) {
            await db.run("ROLLBACK").catch(() => {});
            throw e;
        }
    }

    static cancel(tradeId, requesterJid) {
        const trade = this.activeTrades.get(tradeId);
        if (!trade) throw new Error('TRADE_NOT_FOUND_OR_EXPIRED');
        if (trade.proposerJid !== requesterJid && trade.targetJid !== requesterJid) {
            throw new Error('UNAUTHORIZED_CANCEL');
        }
        this.activeTrades.delete(tradeId);
        return true;
    }
}
