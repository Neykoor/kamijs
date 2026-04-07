import { LidGuard } from './middleware/LidGuard.js';
import { ImageProvider } from './core/ImageProvider.js';
import { MercyIA } from './core/MercyIA.js';
import { Cooldowns } from './utils/Cooldowns.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fs from 'fs-extra';
import crypto from 'crypto';

export class Kamijs {
    constructor(config = {}) {
        this.dbPath = config.dbPath || './database/gacha.db';
        this.jsonPath = config.jsonPath || './database/characters.json';
        this.currency = config.currency || 'yenes';
        this.db = null;
        this.cooldowns = new Cooldowns();
    }

    async init() {
        this.db = await open({ filename: this.dbPath, driver: sqlite3.Database });
        await this.db.exec(`
            PRAGMA busy_timeout = 5000;
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS characters (
                id TEXT PRIMARY KEY, 
                name TEXT, 
                series TEXT, 
                gender TEXT, 
                booru_tag TEXT, 
                value INTEGER DEFAULT 3000, 
                votes INTEGER DEFAULT 0
            );
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS groups (
                id TEXT PRIMARY KEY,
                mode TEXT DEFAULT 'global'
            );
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS group_users (
                jid TEXT, 
                group_id TEXT,
                balance INTEGER DEFAULT 0, 
                stress_level INTEGER DEFAULT 0, 
                last_interaction INTEGER,
                claim_msg TEXT DEFAULT NULL,
                PRIMARY KEY (jid, group_id)
            );
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS claims (
                char_id TEXT,
                group_id TEXT,
                owner_jid TEXT,
                market_price INTEGER DEFAULT NULL,
                PRIMARY KEY (char_id, group_id),
                FOREIGN KEY(char_id) REFERENCES characters(id) ON DELETE CASCADE
            );
        `);

        await this.db.exec(`
            CREATE TABLE IF NOT EXISTS trade_history (
                id TEXT PRIMARY KEY, 
                group_id TEXT,
                proposer_jid TEXT, 
                target_jid TEXT, 
                offered_char TEXT, 
                requested_char TEXT, 
                timestamp INTEGER,
                expires_at INTEGER
            );
        `);

        if (!fs.existsSync(this.jsonPath)) {
            await fs.ensureDir('./database');
            await fs.writeJson(this.jsonPath, { characters: [] });
        }
    }

    async getGroupMode(rawGroupId) {
        if (!rawGroupId || !rawGroupId.endsWith('@g.us')) return 'global';
        const group = await this.db.get("SELECT mode FROM groups WHERE id = ?", [rawGroupId]);
        return group ? group.mode : 'global';
    }

    async setGroupMode(rawGroupId, mode) {
        if (!rawGroupId || !rawGroupId.endsWith('@g.us')) throw new Error('NOT_A_GROUP');
        if (!['global', 'private'].includes(mode)) throw new Error('INVALID_MODE');
        await this.db.run("INSERT INTO groups (id, mode) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET mode = ?", [rawGroupId, mode, mode]);
        return { success: true, mode };
    }

    async #resolveGroup(rawGroupId) {
        const mode = await this.getGroupMode(rawGroupId);
        return mode === 'private' ? rawGroupId : 'global';
    }

    async #resolveCharacter(query, ownerJid = null, forceMode = 'auto', fullData = false, groupId = 'global') {
        const select = fullData ? "c.*, cl.owner_jid as owner_id, cl.market_price" : "c.id, c.name, c.series, c.booru_tag";
        let condition, params;
        
        if (forceMode === 'free') {
            condition = "cl.owner_jid IS NULL";
            params = [groupId, query];
        } else if (forceMode === 'owned') {
            condition = "cl.owner_jid = ?";
            params = [groupId, query, ownerJid];
        } else {
            condition = "1=1"; 
            params = [groupId, query];
        }

        const baseQuery = `SELECT ${select} FROM characters c LEFT JOIN claims cl ON c.id = cl.char_id AND cl.group_id = ?`;
        
        let chars = await this.db.all(`${baseQuery} WHERE c.id = ? AND ${condition}`, params);
        if (chars.length === 0) chars = await this.db.all(`${baseQuery} WHERE LOWER(c.name) = LOWER(?) AND ${condition}`, params);
        if (chars.length === 0) throw new Error(forceMode === 'free' ? 'CHARACTER_NOT_FOUND_OR_CLAIMED' : 'CHARACTER_NOT_FOUND');
        if (chars.length > 1) throw new Error(`AMBIGUOUS_QUERY:\n${chars.map(c => `[ID: ${c.id}] ${c.name} (${c.series})`).join('\n')}`);
        
        return chars[0];
    }

    async addCharacter(data) {
        const { name, series, gender, booru_tag, value = 3000 } = data;
        if (!name || !series || !gender || !booru_tag) throw new Error('MISSING_REQUIRED_FIELDS');
        const charId = data.id || crypto.randomBytes(4).toString('hex');
        await this.db.run("INSERT OR IGNORE INTO characters (id, name, series, gender, booru_tag, value) VALUES (?, ?, ?, ?, ?, ?)", [charId, name, series, gender, booru_tag, value]);
        const backup = await fs.readJson(this.jsonPath);
        if (!backup.characters.find(c => c.id === charId)) {
            data.id = charId; backup.characters.push(data);
            await fs.writeJson(this.jsonPath, backup, { spaces: 2 });
        }
    }

    async bulkAddCharacters(dataArray) {
        if (!Array.isArray(dataArray) || dataArray.length === 0) return 0;
        await this.db.run("BEGIN IMMEDIATE");
        const backup = await fs.readJson(this.jsonPath);
        let addedCount = 0;
        
        const chunkSize = 50; 
        try {
            for (let i = 0; i < dataArray.length; i += chunkSize) {
                const chunk = dataArray.slice(i, i + chunkSize);
                const validChars = chunk.filter(c => c.name && c.series && c.gender && c.booru_tag);
                if (validChars.length === 0) continue;

                validChars.forEach(c => c.id = c.id || crypto.randomBytes(4).toString('hex'));

                const idPlaceholders = validChars.map(() => '?').join(',');
                const existingRows = await this.db.all(`SELECT id FROM characters WHERE id IN (${idPlaceholders})`, validChars.map(c => c.id));
                const existingIds = new Set(existingRows.map(r => r.id));

                const toInsert = validChars.filter(c => !existingIds.has(c.id));
                if (toInsert.length === 0) continue;

                const insertPlaceholders = toInsert.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
                const params = [];

                for (const char of toInsert) {
                    params.push(char.id, char.name, char.series, char.gender, char.booru_tag, char.value || 3000);
                    if (!backup.characters.find(c => c.id === char.id)) {
                        backup.characters.push(char);
                    }
                }
                
                await this.db.run(`INSERT INTO characters (id, name, series, gender, booru_tag, value) VALUES ${insertPlaceholders}`, params);
                addedCount += toInsert.length;
            }
            await this.db.run("COMMIT");
            if (addedCount > 0) await fs.writeJson(this.jsonPath, backup, { spaces: 2 });
            return addedCount;
        } catch (e) { 
            await this.db.run("ROLLBACK").catch(() => {}); 
            throw e; 
        }
    }

    async roll(sock, rawJid, rawGroupId = 'global') {
        const resolvedJid = await LidGuard.clean(sock, rawJid);
        const groupId = await this.#resolveGroup(rawGroupId);
        const cd = this.cooldowns.isReady(resolvedJid);
        if (!cd.ready) return { error: 'COOLDOWN', remaining: cd.remaining };

        const now = Date.now();
        let user = await this.db.get("SELECT * FROM group_users WHERE jid = ? AND group_id = ?", [resolvedJid, groupId]);
        
        if (!user) {
            await this.db.run("INSERT OR IGNORE INTO group_users (jid, group_id, balance, stress_level, last_interaction) VALUES (?, ?, 0, 0, ?)", [resolvedJid, groupId, now]);
            user = { jid: resolvedJid, balance: 0, stress_level: 0, last_interaction: now };
        } else {
            const hoursInactive = (now - user.last_interaction) / 3600000;
            if (hoursInactive >= 24 && user.stress_level > 0) {
                const decay = Math.floor(hoursInactive / 24);
                user.stress_level = Math.max(0, user.stress_level - decay);
            }
        }

        const isPity = MercyIA.shouldIntervene(user);
        const normalQuery = "SELECT * FROM characters ORDER BY RANDOM() LIMIT 1";
        const pityQuery = "SELECT c.* FROM characters c LEFT JOIN claims cl ON c.id = cl.char_id AND cl.group_id = ? WHERE cl.owner_jid IS NULL ORDER BY RANDOM() LIMIT 1";
        
        let char;
        if (isPity) {
            char = await this.db.get(pityQuery, [groupId]);
            if (!char) char = await this.db.get(normalQuery);
        } else {
            const { sql, params } = MercyIA.getRollQuery(user.balance);
            char = await this.db.get(sql, params);
            if (!char) char = await this.db.get(normalQuery);
        }
        
        if (!char) return { error: 'NOT_FOUND' };

        await this.db.run("UPDATE group_users SET stress_level = ?, last_interaction = ? WHERE jid = ? AND group_id = ?", [user.stress_level, now, resolvedJid, groupId]);
        return { ...char, currencyName: this.currency, imageUrl: await ImageProvider.getRandomUrl(char.booru_tag), pityActive: isPity, resolvedJid, groupId };
    }

    confirmRoll(resolvedJid) {
        this.cooldowns.confirm(resolvedJid);
    }
        async claim(sock, rawJid, query, rawGroupId = 'global') {
        const jid = await LidGuard.clean(sock, rawJid);
        const groupId = await this.#resolveGroup(rawGroupId);
        const char = await this.#resolveCharacter(query, null, 'free', true, groupId);

        await this.db.run("BEGIN IMMEDIATE");
        try {
            const user = await this.db.get("SELECT balance, claim_msg FROM group_users WHERE jid = ? AND group_id = ?", [jid, groupId]);
            const currentBalance = user?.balance || 0;
            
            if (currentBalance < char.value) throw new Error('INSUFFICIENT_FUNDS');

            await this.db.run("INSERT INTO claims (char_id, group_id, owner_jid) VALUES (?, ?, ?)", [char.id, groupId, jid]);
            await this.db.run("UPDATE group_users SET balance = balance - ?, stress_level = 0 WHERE jid = ? AND group_id = ?", [char.value, jid, groupId]);
            await this.db.run("COMMIT");
            return { success: true, charId: char.id, charName: char.name, customMsg: user?.claim_msg || null };
        } catch (e) {
            await this.db.run("ROLLBACK").catch(() => {});
            if (e.message.includes('UNIQUE constraint failed')) throw new Error('ALREADY_CLAIMED');
            throw e;
        }
    }

    async reportMissedClaim(sock, rawJid, rawGroupId = 'global') {
        const jid = await LidGuard.clean(sock, rawJid);
        const groupId = await this.#resolveGroup(rawGroupId);
        await this.db.run(`
            INSERT INTO group_users (jid, group_id, balance, stress_level, last_interaction)
            VALUES (?, ?, 0, 1, ?)
            ON CONFLICT(jid, group_id) DO UPDATE SET 
            stress_level = MIN(stress_level + 1, 5), 
            last_interaction = excluded.last_interaction
        `, [jid, groupId, Date.now()]);
    }

    async addBalance(sock, rawJid, amount, rawGroupId = 'global') {
        if (amount <= 0) throw new Error('INVALID_AMOUNT');
        const jid = await LidGuard.clean(sock, rawJid);
        const groupId = await this.#resolveGroup(rawGroupId);
        
        await this.db.run(`
            INSERT INTO group_users (jid, group_id, balance, last_interaction) 
            VALUES (?, ?, ?, ?) 
            ON CONFLICT(jid, group_id) DO UPDATE SET balance = balance + excluded.balance, last_interaction = excluded.last_interaction
        `, [jid, groupId, amount, Date.now()]);
        
        return { success: true, amountAdded: amount };
    }

    async listCharacter(sock, rawJid, query, price, rawGroupId = 'global') {
        const jid = await LidGuard.clean(sock, rawJid);
        const groupId = await this.#resolveGroup(rawGroupId);
        if (!price || price <= 0) throw new Error('INVALID_PRICE');
        const char = await this.#resolveCharacter(query, jid, 'owned', false, groupId);
        const result = await this.db.run("UPDATE claims SET market_price = ? WHERE char_id = ? AND owner_jid = ? AND group_id = ?", [price, char.id, jid, groupId]);
        if (result.changes === 0) throw new Error('NOT_OWNER_OR_NOT_FOUND');
        return { success: true, name: char.name, price };
    }

    async buyCharacter(sock, rawJid, query, rawGroupId = 'global') {
        const buyerJid = await LidGuard.clean(sock, rawJid);
        const groupId = await this.#resolveGroup(rawGroupId);
        const candidates = await this.db.all(`
            SELECT c.id, c.name, cl.owner_jid as owner_id, cl.market_price 
            FROM characters c JOIN claims cl ON c.id = cl.char_id AND cl.group_id = ? 
            WHERE (c.id = ? OR LOWER(c.name) = LOWER(?)) AND cl.market_price IS NOT NULL
        `, [groupId, query, query]);

        if (candidates.length === 0) throw new Error('NOT_FOR_SALE');
        if (candidates.length > 1) throw new Error(`AMBIGUOUS_BUY:\n${candidates.map(c => `[ID: ${c.id}] ${c.name} - ${c.market_price}¥`).join('\n')}`);
        
        const target = candidates[0];
        await this.db.run("BEGIN IMMEDIATE");
        try {
            const char = await this.db.get("SELECT owner_jid as owner_id, market_price FROM claims WHERE char_id = ? AND group_id = ? AND market_price IS NOT NULL", [target.id, groupId]);
            if (!char) throw new Error('ALREADY_SOLD_OR_WITHDRAWN');
            if (char.owner_id === buyerJid) throw new Error('ALREADY_OWNED_BY_YOU');

            const updateBuyer = await this.db.run("UPDATE group_users SET balance = balance - ? WHERE jid = ? AND group_id = ? AND balance >= ?", [char.market_price, buyerJid, groupId, char.market_price]);
            if (updateBuyer.changes === 0) throw new Error('INSUFFICIENT_FUNDS');

            await this.db.run("UPDATE group_users SET balance = balance + ? WHERE jid = ? AND group_id = ?", [char.market_price, char.owner_id, groupId]);
            await this.db.run("UPDATE claims SET owner_jid = ?, market_price = NULL WHERE char_id = ? AND group_id = ?", [buyerJid, target.id, groupId]);
            await this.db.run("COMMIT");
            return { success: true, charName: target.name, price: char.market_price };
        } catch (e) { await this.db.run("ROLLBACK").catch(() => {}); throw e; }
    }

    async getMarketplace(page = 1, limit = 10, rawGroupId = 'global') {
        const offset = (page - 1) * limit;
        const groupId = await this.#resolveGroup(rawGroupId);
        const count = await this.db.get("SELECT COUNT(*) as total FROM claims WHERE group_id = ? AND market_price IS NOT NULL", [groupId]);
        const items = await this.db.all(`
            SELECT c.id, c.name, c.series, cl.market_price, cl.owner_jid as owner_id 
            FROM claims cl JOIN characters c ON cl.char_id = c.id 
            WHERE cl.group_id = ? AND cl.market_price IS NOT NULL ORDER BY cl.market_price ASC LIMIT ? OFFSET ?
        `, [groupId, limit, offset]);
        return { items, totalPages: Math.ceil(count.total / limit), currentPage: page, totalItems: count.total };
    }

    async withdrawCharacter(sock, rawJid, query, rawGroupId = 'global') {
        const jid = await LidGuard.clean(sock, rawJid);
        const groupId = await this.#resolveGroup(rawGroupId);
        const char = await this.#resolveCharacter(query, jid, 'owned', false, groupId);
        const result = await this.db.run("UPDATE claims SET market_price = NULL WHERE char_id = ? AND owner_jid = ? AND group_id = ?", [char.id, jid, groupId]);
        if (result.changes === 0) throw new Error('NOT_OWNER_OR_NOT_FOUND');
        return { name: char.name };
    }

    async giveCharacter(sock, rawFrom, rawTo, query, rawGroupId = 'global') {
        const from = await LidGuard.clean(sock, rawFrom);
        const to = await LidGuard.clean(sock, rawTo);
        const groupId = await this.#resolveGroup(rawGroupId);
        if (from === to) throw new Error('CANNOT_GIVE_TO_SELF');
        const char = await this.#resolveCharacter(query, from, 'owned', false, groupId);
        const result = await this.db.run("UPDATE claims SET owner_jid = ?, market_price = NULL WHERE char_id = ? AND owner_jid = ? AND group_id = ?", [to, char.id, from, groupId]);
        if (result.changes === 0) throw new Error('TRANSFER_FAILED');
        return { name: char.name };
    }

    async giveAllHarem(sock, rawFrom, rawTo, rawGroupId = 'global') {
        const from = await LidGuard.clean(sock, rawFrom);
        const to = await LidGuard.clean(sock, rawTo);
        const groupId = await this.#resolveGroup(rawGroupId);
        if (from === to) throw new Error('CANNOT_GIVE_TO_SELF');
        await this.db.run("BEGIN IMMEDIATE");
        try {
            const result = await this.db.run("UPDATE claims SET owner_jid = ?, market_price = NULL WHERE owner_jid = ? AND group_id = ?", [to, from, groupId]);
            if (result.changes === 0) throw new Error('EMPTY_HAREM');
            await this.db.run("COMMIT");
            return { success: true, totalTransferred: result.changes };
        } catch (e) { await this.db.run("ROLLBACK").catch(() => {}); throw e; }
    }

    async proposeTrade(sock, rawFrom, rawTo, offeredQ, requestedQ, rawGroupId = 'global') {
        const from = await LidGuard.clean(sock, rawFrom);
        const to = await LidGuard.clean(sock, rawTo);
        const groupId = await this.#resolveGroup(rawGroupId);
        const cd = this.cooldowns.isReady(`${from}_trade`, 60);
        if (!cd.ready) return { error: 'COOLDOWN', remaining: cd.remaining };
        
        const offered = await this.#resolveCharacter(offeredQ, from, 'owned', false, groupId);
        const requested = await this.#resolveCharacter(requestedQ, to, 'owned', false, groupId);
        const tradeId = crypto.randomBytes(4).toString('hex');
        const expiresAt = Date.now() + 300000;
        
        const result = await this.db.run(
            "INSERT INTO trade_history (id, group_id, proposer_jid, target_jid, offered_char, requested_char, timestamp, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [tradeId, groupId, from, to, offered.id, requested.id, Date.now(), expiresAt]
        );

        if (result.changes > 0) {
            this.cooldowns.confirm(`${from}_trade`);
            return { success: true, tradeId, offeredRealName: offered.name, requestedRealName: requested.name };
        }
        throw new Error('TRADE_CREATION_FAILED');
    }

    async confirmTrade(sock, rawTo, tradeId) {
        const to = await LidGuard.clean(sock, rawTo);
        const trade = await this.db.get("SELECT * FROM trade_history WHERE id = ? AND target_jid = ?", [tradeId, to]);
        if (!trade) throw new Error('TRADE_NOT_FOUND_OR_UNAUTHORIZED');

        if (Date.now() > trade.expires_at) {
            await this.db.run("DELETE FROM trade_history WHERE id = ?", [tradeId]);
            throw new Error('TRADE_EXPIRED');
        }

        await this.db.run("BEGIN IMMEDIATE");
        try {
            const p1 = await this.db.get("SELECT owner_jid FROM claims WHERE char_id = ? AND group_id = ?", [trade.offered_char, trade.group_id]);
            const p2 = await this.db.get("SELECT owner_jid FROM claims WHERE char_id = ? AND group_id = ?", [trade.requested_char, trade.group_id]);

            if (!p1 || p1.owner_jid !== trade.proposer_jid) throw new Error('PROPOSER_NO_LONGER_OWNS');
            if (!p2 || p2.owner_jid !== trade.target_jid) throw new Error('TARGET_NO_LONGER_OWNS');

            await this.db.run("UPDATE claims SET owner_jid = ? WHERE char_id = ? AND group_id = ?", [trade.target_jid, trade.offered_char, trade.group_id]);
            await this.db.run("UPDATE claims SET owner_jid = ? WHERE char_id = ? AND group_id = ?", [trade.proposer_jid, trade.requested_char, trade.group_id]);
            await this.db.run("DELETE FROM trade_history WHERE id = ?", [tradeId]);
            await this.db.run("COMMIT");
            return { success: true };
        } catch (e) { await this.db.run("ROLLBACK").catch(() => {}); throw e; }
    }

    async cancelTrade(sock, rawJid, tradeId) {
        const jid = await LidGuard.clean(sock, rawJid);
        const result = await this.db.run("DELETE FROM trade_history WHERE id = ? AND (proposer_jid = ? OR target_jid = ?)", [tradeId, jid, jid]);
        if (result.changes === 0) throw new Error('TRADE_NOT_FOUND_OR_UNAUTHORIZED');
        return { success: true };
    }

    async getCharacterInfo(query, rawGroupId = 'global') {
        const groupId = await this.#resolveGroup(rawGroupId);
        const char = await this.#resolveCharacter(query, null, 'auto', true, groupId);
        char.imageUrl = await ImageProvider.getRandomUrl(char.booru_tag);
        if (char.owner_id) char.ownerTag = `@${char.owner_id.split('@')[0]}`;
        return char;
    }

    async getUserProfile(sock, rawJid, rawGroupId = 'global') {
        const jid = await LidGuard.clean(sock, rawJid);
        const groupId = await this.#resolveGroup(rawGroupId);
        const profile = await this.db.get("SELECT balance FROM group_users WHERE jid = ? AND group_id = ?", [jid, groupId]);
        const chars = await this.db.all("SELECT c.id, c.name, c.series, c.value FROM characters c JOIN claims cl ON c.id = cl.char_id WHERE cl.owner_jid = ? AND cl.group_id = ? ORDER BY c.value DESC", [jid, groupId]);
        
        const rollCd = this.cooldowns.isReady(jid);
        const voteCd = this.cooldowns.isReady(`${jid}_vote`);
        
        return { 
            balance: profile?.balance || 0, 
            characters: chars, 
            currencyName: this.currency, 
            cooldowns: { roll: rollCd.ready ? 0 : rollCd.remaining, vote: voteCd.ready ? 0 : voteCd.remaining } 
        };
    }

    async getSeriesInfo(seriesName, rawGroupId = 'global') {
        const groupId = await this.#resolveGroup(rawGroupId);
        const totalReq = await this.db.get("SELECT COUNT(*) as total FROM characters WHERE LOWER(series) = LOWER(?)", [seriesName]);
        if (totalReq.total === 0) throw new Error('SERIES_NOT_FOUND');
        const claimedReq = await this.db.get("SELECT COUNT(*) as claimed FROM claims cl JOIN characters c ON cl.char_id = c.id WHERE LOWER(c.series) = LOWER(?) AND cl.group_id = ?", [seriesName, groupId]);
        const sample = await this.db.get("SELECT booru_tag FROM characters WHERE LOWER(series) = LOWER(?) LIMIT 1", [seriesName]);
        return { name: seriesName, total: totalReq.total, claimed: claimedReq.claimed, imageUrl: await ImageProvider.getRandomUrl(sample.booru_tag) };
    }

    async listSeries(page = 1, limit = 15) {
        const offset = (page - 1) * limit;
        const total = await this.db.get("SELECT COUNT(DISTINCT series) as count FROM characters");
        const list = await this.db.all("SELECT DISTINCT series FROM characters ORDER BY series ASC LIMIT ? OFFSET ?", [limit, offset]);
        return { list: list.map(s => s.series), totalPages: Math.ceil(total.count / limit), currentPage: page };
    }

    async getTopWaifus(limit = 10) {
        return await this.db.all("SELECT name, series, value, votes FROM characters WHERE votes > 0 ORDER BY votes DESC LIMIT ?", [limit]);
    }

    async getTopCharacters(limit = 10) { return this.getTopWaifus(limit); }

    async voteCharacter(sock, rawJid, query) {
        const jid = await LidGuard.clean(sock, rawJid);
        const cd = this.cooldowns.isReady(`${jid}_vote`, 3600);
        if (!cd.ready) return { error: 'COOLDOWN', remaining: cd.remaining };
        const char = await this.#resolveCharacter(query, null, 'auto', false, 'global');
        
        await this.db.run("UPDATE characters SET votes = votes + 1 WHERE id = ?", [char.id]);
        const updated = await this.db.get("SELECT votes FROM characters WHERE id = ?", [char.id]);
        
        this.cooldowns.confirm(`${jid}_vote`);
        return { name: char.name, newVotes: updated.votes };
    }

    async deleteClaim(sock, rawJid, query, rawGroupId = 'global') {
        const jid = await LidGuard.clean(sock, rawJid);
        const groupId = await this.#resolveGroup(rawGroupId);
        const char = await this.#resolveCharacter(query, jid, 'owned', false, groupId);
        const result = await this.db.run("DELETE FROM claims WHERE char_id = ? AND owner_jid = ? AND group_id = ?", [char.id, jid, groupId]);
        if (result.changes === 0) throw new Error('NOT_OWNER_OR_NOT_FOUND');
        return { success: true, charName: char.name };
    }

    async setClaimMsg(sock, rawJid, message, rawGroupId = 'global') {
        const jid = await LidGuard.clean(sock, rawJid);
        const groupId = await this.#resolveGroup(rawGroupId);
        
        await this.db.run(`
            INSERT INTO group_users (jid, group_id, claim_msg, last_interaction) 
            VALUES (?, ?, ?, ?) 
            ON CONFLICT(jid, group_id) DO UPDATE SET claim_msg = excluded.claim_msg
        `, [jid, groupId, message, Date.now()]);
        
        return { success: true };
    }

    async getCharacterImage(query = null) {
        let char;
        if (!query) char = await this.db.get("SELECT booru_tag, name FROM characters ORDER BY RANDOM() LIMIT 1");
        else char = await this.#resolveCharacter(query, null, 'auto', false, 'global');
        if (!char) throw new Error('NO_CHARACTERS_IN_DB');
        return { name: char.name, url: await ImageProvider.getRandomUrl(char.booru_tag) };
    }

    async getRandomAvailable(rawGroupId = 'global') { 
        const groupId = await this.#resolveGroup(rawGroupId);
        return await this.db.get("SELECT c.* FROM characters c LEFT JOIN claims cl ON c.id = cl.char_id AND cl.group_id = ? WHERE cl.owner_jid IS NULL ORDER BY RANDOM() LIMIT 1", [groupId]); 
    }
}
