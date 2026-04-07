import { LidGuard } from './middleware/LidGuard.js';
import { ImageProvider } from './core/ImageProvider.js';
import { MercyIA } from './core/MercyIA.js';
import { EconomyManager } from './core/EconomyManager.js';
import { TradeManager } from './core/TradeManager.js';
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
                owner_id TEXT DEFAULT NULL, 
                votes INTEGER DEFAULT 0,
                market_price INTEGER DEFAULT NULL
            );
            CREATE TABLE IF NOT EXISTS users (
                jid TEXT PRIMARY KEY, 
                balance INTEGER DEFAULT 0, 
                stress_level INTEGER DEFAULT 0, 
                last_interaction INTEGER
            );
            CREATE TABLE IF NOT EXISTS trade_history (
                id TEXT PRIMARY KEY, 
                proposer_jid TEXT, 
                target_jid TEXT, 
                offered_char TEXT, 
                requested_char TEXT, 
                timestamp INTEGER
            );
        `);
        if (!fs.existsSync(this.jsonPath)) {
            await fs.ensureDir('./database');
            await fs.writeJson(this.jsonPath, { characters: [] });
        }
    }

    async addCharacter(data) {
        const { name, series, gender, booru_tag, value = 3000 } = data;
        if (!name || !series || !gender || !booru_tag) throw new Error('MISSING_REQUIRED_FIELDS');
        const charId = data.id || crypto.randomBytes(4).toString('hex');
        await this.db.run(
            "INSERT OR IGNORE INTO characters (id, name, series, gender, booru_tag, value) VALUES (?, ?, ?, ?, ?, ?)",
            [charId, name, series, gender, booru_tag, value]
        );
        const backup = await fs.readJson(this.jsonPath);
        if (!backup.characters.find(c => c.id === charId)) {
            data.id = charId;
            backup.characters.push(data);
            await fs.writeJson(this.jsonPath, backup, { spaces: 2 });
        }
    }

    async bulkAddCharacters(dataArray) {
        if (!Array.isArray(dataArray)) throw new Error('INVALID_ARRAY');
        await this.db.run("BEGIN IMMEDIATE");
        const backup = await fs.readJson(this.jsonPath);
        let addedCount = 0;
        try {
            for (const char of dataArray) {
                if (!char.name || !char.series || !char.gender || !char.booru_tag) continue;
                const charId = char.id || crypto.randomBytes(4).toString('hex');
                const result = await this.db.run(
                    "INSERT OR IGNORE INTO characters (id, name, series, gender, booru_tag, value) VALUES (?, ?, ?, ?, ?, ?)",
                    [charId, char.name, char.series, char.gender, char.booru_tag, char.value || 3000]
                );
                if (result.changes > 0 && !backup.characters.find(c => c.id === charId)) {
                    char.id = charId;
                    backup.characters.push(char);
                    addedCount++;
                }
            }
            await this.db.run("COMMIT");
            if (addedCount > 0) await fs.writeJson(this.jsonPath, backup, { spaces: 2 });
            return addedCount;
        } catch (e) {
            await this.db.run("ROLLBACK").catch(() => {});
            throw e;
        }
    }

    async #resolveCharacter(query, ownerJid = null, forceMode = 'auto', fullData = false) {
        const select = fullData ? "*" : "id, name, series, booru_tag";
        let condition, params;
        if (forceMode === 'free') {
            condition = "owner_id IS NULL";
            params = [query];
        } else if (forceMode === 'owned') {
            condition = "owner_id = ?";
            params = [query, ownerJid];
        } else {
            condition = "1=1"; 
            params = [query];
        }
        let chars = await this.db.all(`SELECT ${select} FROM characters WHERE id = ? AND ${condition}`, params);
        if (chars.length === 0) {
            chars = await this.db.all(`SELECT ${select} FROM characters WHERE LOWER(name) = LOWER(?) AND ${condition}`, params);
        }
        if (chars.length === 0) {
            throw new Error(forceMode === 'free' ? 'CHARACTER_NOT_FOUND_OR_CLAIMED' : 'CHARACTER_NOT_FOUND');
        }
        if (chars.length > 1) {
            const options = chars.map(c => `[ID: ${c.id}] ${c.name} (${c.series})`).join('\n');
            throw new Error(`AMBIGUOUS_QUERY:\n${options}`);
        }
        return chars[0];
    }

    async reportMissedClaim(sock, rawJid) {
        const jid = await LidGuard.clean(sock, rawJid);
        await this.db.run(
            "UPDATE users SET stress_level = MIN(stress_level + 1, 5), last_interaction = ? WHERE jid = ?", 
            [Date.now(), jid]
        );
    }

    async addBalance(sock, rawJid, amount) {
        if (amount <= 0) throw new Error('INVALID_AMOUNT');
        const jid = await LidGuard.clean(sock, rawJid);
        const result = await this.db.run("UPDATE users SET balance = balance + ? WHERE jid = ?", [amount, jid]);
        if (result.changes === 0) {
            await this.db.run("INSERT INTO users (jid, balance, last_interaction) VALUES (?, ?, ?)", [jid, amount, Date.now()]);
        }
        return { success: true, amountAdded: amount };
    }

    async claim(sock, rawJid, query) {
        const jid = await LidGuard.clean(sock, rawJid);
        const char = await this.#resolveCharacter(query, null, 'free');
        return await EconomyManager.processClaim(this.db, jid, char.id);
    }

    async roll(sock, rawJid) {
        const resolvedJid = await LidGuard.clean(sock, rawJid);
        const cd = this.cooldowns.isReady(resolvedJid);
        if (!cd.ready) return { error: 'COOLDOWN', remaining: cd.remaining };
        let user = await MercyIA.getProcessedUser(this.db, resolvedJid);
        if (!user) {
            const now = Date.now();
            await this.db.run("INSERT INTO users (jid, balance, last_interaction) VALUES (?, 0, ?)", [resolvedJid, now]);
            user = { jid: resolvedJid, balance: 0, stress_level: 0, last_interaction: now };
        }
        const isPity = MercyIA.shouldIntervene(user);
        const { sql, params } = MercyIA.getRollQuery(isPity, user.balance);
        let char = await this.db.get(sql, params);
        if (!char && isPity) {
            const normalRoll = MercyIA.getRollQuery(false, 0);
            char = await this.db.get(normalRoll.sql, normalRoll.params);
        }
        if (!char) return { error: 'NOT_FOUND' };
        await this.db.run("UPDATE users SET last_interaction = ? WHERE jid = ?", [Date.now(), resolvedJid]);
        return {
            id: char.id,
            name: char.name,
            series: char.series,
            gender: char.gender,
            value: char.value,
            currencyName: this.currency,
            imageUrl: await ImageProvider.getRandomUrl(char.booru_tag),
            pityActive: isPity,
            resolvedJid: resolvedJid 
        };
    }

    confirmRoll(resolvedJid) {
        this.cooldowns.confirm(resolvedJid);
    }

    async getUserProfile(sock, rawJid) {
        const jid = await LidGuard.clean(sock, rawJid);
        let user = await this.db.get("SELECT balance FROM users WHERE jid = ?", [jid]);
        if (!user) return { balance: 0, characters: [], currencyName: this.currency };
        const characters = await this.db.all("SELECT id, name, series, value FROM characters WHERE owner_id = ? ORDER BY value DESC", [jid]);
        return { balance: user.balance, currencyName: this.currency, characters };
    }

    async listCharacter(sock, rawJid, query, price) {
        const jid = await LidGuard.clean(sock, rawJid);
        if (!price || price <= 0) throw new Error('INVALID_PRICE');
        const char = await this.#resolveCharacter(query, jid, 'owned');
        const result = await this.db.run("UPDATE characters SET market_price = ? WHERE id = ? AND owner_id = ?", [price, char.id, jid]);
        if (result.changes === 0) throw new Error('NOT_OWNER_OR_NOT_FOUND');
        return { success: true, name: char.name, price };
    }

    async buyCharacter(sock, rawJid, query) {
        const buyerJid = await LidGuard.clean(sock, rawJid);
        const candidates = await this.db.all(
            "SELECT id, name, owner_id, market_price FROM characters WHERE (id = ? OR LOWER(name) = LOWER(?)) AND market_price IS NOT NULL",
            [query, query]
        );
        if (candidates.length === 0) throw new Error('NOT_FOR_SALE');
        if (candidates.length > 1) {
            const list = candidates.map(c => `[ID: ${c.id}] ${c.name} - ${c.market_price}¥`).join('\n');
            throw new Error(`AMBIGUOUS_BUY:\n${list}`);
        }
        const target = candidates[0];
        await this.db.run("BEGIN IMMEDIATE");
        try {
            const char = await this.db.get("SELECT owner_id, market_price, name FROM characters WHERE id = ? AND market_price IS NOT NULL", [target.id]);
            if (!char) throw new Error('ALREADY_SOLD_OR_WITHDRAWN');
            if (char.owner_id === buyerJid) throw new Error('ALREADY_OWNED_BY_YOU');
            const updateBuyer = await this.db.run("UPDATE users SET balance = balance - ? WHERE jid = ? AND balance >= ?", [char.market_price, buyerJid, char.market_price]);
            if (updateBuyer.changes === 0) throw new Error('INSUFFICIENT_FUNDS');
            await this.db.run("UPDATE users SET balance = balance + ? WHERE jid = ?", [char.market_price, char.owner_id]);
            await this.db.run("UPDATE characters SET owner_id = ?, market_price = NULL WHERE id = ?", [buyerJid, target.id]);
            await this.db.run("COMMIT");
            return { success: true, charName: char.name, price: char.market_price };
        } catch (e) {
            await this.db.run("ROLLBACK").catch(() => {});
            throw e;
        }
    }

    async getCharacterImage(query = null) {
        let finalName, finalTag;
        if (!query) {
            const randomChar = await this.db.get("SELECT booru_tag, name FROM characters ORDER BY RANDOM() LIMIT 1");
            if (!randomChar) throw new Error('NO_CHARACTERS_IN_DB');
            finalName = randomChar.name;
            finalTag = randomChar.booru_tag;
        } else {
            const char = await this.#resolveCharacter(query, null, 'auto');
            finalName = char.name;
            finalTag = char.booru_tag;
        }
        const url = await ImageProvider.getRandomUrl(finalTag);
        return { name: finalName, url };
    }

    async getCharacterInfo(query) {
        const char = await this.#resolveCharacter(query, null, 'auto', true);
        char.imageUrl = await ImageProvider.getRandomUrl(char.booru_tag);
        if (char.owner_id) char.ownerTag = `@${char.owner_id.split('@')[0]}`;
        return char;
    }

    async proposeTrade(sock, proposerRawJid, targetRawJid, offeredQuery, requestedQuery) {
        const proposerJid = await LidGuard.clean(sock, proposerRawJid);
        const targetJid = await LidGuard.clean(sock, targetRawJid);
        const cd = this.cooldowns.isReady(proposerJid, 'trade_propose', 60);
        if (!cd.ready) return { error: 'COOLDOWN', remaining: cd.remaining };
        const offered = await this.#resolveCharacter(offeredQuery, proposerJid, 'owned');
        const requested = await this.#resolveCharacter(requestedQuery, targetJid, 'owned');
        const trade = await TradeManager.initiate(this.db, proposerJid, targetJid, offered.id, requested.id);
        this.cooldowns.confirm(proposerJid, 'trade_propose');
        return { success: true, trade, offeredRealName: offered.name, requestedRealName: requested.name };
    }

    async confirmTrade(sock, targetRawJid, tradeId) {
        const targetJid = await LidGuard.clean(sock, targetRawJid);
        await TradeManager.confirm(this.db, tradeId, targetJid);
        return { success: true };
    }

    async cancelTrade(sock, rawJid, tradeId) {
        const jid = await LidGuard.clean(sock, rawJid);
        TradeManager.cancel(tradeId, jid);
        return { success: true };
    }

    async voteCharacter(sock, rawJid, charId) {
        const jid = await LidGuard.clean(sock, rawJid);
        const cd = this.cooldowns.isReady(jid, 'vote', 3600); 
        if (!cd.ready) return { error: 'COOLDOWN', remaining: cd.remaining };
        const result = await this.db.run("UPDATE characters SET votes = votes + 1 WHERE id = ?", [charId]);
        if (result.changes === 0) throw new Error('CHARACTER_NOT_FOUND');
        this.cooldowns.confirm(jid, 'vote');
        return { success: true };
    }

    async getRandomAvailable() {
        return await this.db.get("SELECT * FROM characters WHERE owner_id IS NULL ORDER BY RANDOM() LIMIT 1") || null;
    }

    async getTopCharacters(limit = 10) {
        return await this.db.all("SELECT id, name, series, gender, votes FROM characters WHERE votes > 0 ORDER BY votes DESC LIMIT ?", [limit]);
    }
                }
        
