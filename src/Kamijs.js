import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import crypto from 'crypto';
import { LidGuard } from './middleware/LidGuard.js';
import { ImageProvider } from './core/ImageProvider.js';
import { MercyIA } from './core/MercyIA.js';
import { Cooldowns } from './utils/Cooldowns.js';

export class Kamijs {
    constructor(config = {}) {
        this.dbPath = config.dbPath || './database/gacha.db';
        this.currency = config.currency || 'yenes';
        this.db = null;
        this.cooldowns = new Cooldowns();
    }

    async init() {
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

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
            CREATE TABLE IF NOT EXISTS groups (
                id TEXT PRIMARY KEY, 
                mode TEXT DEFAULT 'global'
            );
            CREATE TABLE IF NOT EXISTS group_users (
                jid TEXT, 
                group_id TEXT, 
                balance INTEGER DEFAULT 0, 
                stress_level INTEGER DEFAULT 0, 
                last_interaction INTEGER,
                claim_msg TEXT DEFAULT NULL, 
                PRIMARY KEY (jid, group_id)
            );
            CREATE TABLE IF NOT EXISTS claims (
                char_id TEXT, 
                group_id TEXT, 
                owner_jid TEXT, 
                market_price INTEGER DEFAULT NULL,
                PRIMARY KEY (char_id, group_id), 
                FOREIGN KEY(char_id) REFERENCES characters(id) ON DELETE CASCADE
            );
        `);
    }

    static parseName(tags, inputTag = '') {
        const blackList = [
            'no_bra', 'breasts', 'large_breasts', 'highres', 'cleavage', 
            'nipples', 'clothed', 'solo', 'looking_at_viewer', 'navel', 
            'panties', 'underwear', 'thighhighs', 'smile', 'blush'
        ];
        
        const tagsArray = Array.isArray(tags) ? tags : tags.split(' ');
        let target = tagsArray[0];

        if (inputTag) {
            const match = tagsArray.find(t => t.includes(inputTag.toLowerCase().trim()));
            if (match) target = match;
        } else {
            target = tagsArray.find(t => t.includes('_') && !blackList.some(b => t.includes(b))) || target;
        }

        return this.#formatName(target);
    }

    static #formatName(tag) {
        return tag.split('(')[0]
            .replace(/_/g, ' ')
            .trim()
            .split(' ')
            .map(w => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');
    }

    static computeValue(score) {
        const bonus = Math.min(Math.max(0, score * 10), 7000);
        return 3000 + bonus;
    }

    async addCharacter(data) {
        const finalName = data.tags ? Kamijs.parseName(data.tags, data.searchTag) : data.name;
        const finalValue = (data.score !== undefined) ? Kamijs.computeValue(data.score) : (data.value || 3000);
        const charId = data.id || crypto.randomBytes(4).toString('hex');

        await this.db.run(
            "INSERT OR IGNORE INTO characters (id, name, series, gender, booru_tag, value) VALUES (?, ?, ?, ?, ?, ?)",
            [charId, finalName, data.series, data.gender, data.booru_tag, finalValue]
        );
    }

    async deleteCharacter(query) {
        const chars = await this.db.all(
            "SELECT id, name, series FROM characters WHERE id = ? OR LOWER(name) = LOWER(?)", 
            [query, query]
        );
        
        if (chars.length === 0) throw new Error('CHARACTER_NOT_FOUND');

        if (chars.length > 1) {
            const list = chars.map(c => `[ID: ${c.id}] ${c.name} (${c.series})`).join('\n');
            throw new Error(`AMBIGUOUS_QUERY:\n${list}`);
        }

        const char = chars[0];
        await this.db.run("BEGIN IMMEDIATE");

        try {
            await this.db.run("DELETE FROM claims WHERE char_id = ?", [char.id]);
            await this.db.run("DELETE FROM characters WHERE id = ?", [char.id]);
            await this.db.run("COMMIT");
            return { success: true, name: char.name, id: char.id };
        } catch (e) {
            await this.db.run("ROLLBACK");
            throw e;
        }
    }

    async roll(sock, rawJid, rawGroupId = 'global') {
        const jid = await LidGuard.clean(sock, rawJid);
        const groupId = await this.#resolveGroup(rawGroupId);
        
        const cd = this.cooldowns.isReady(jid);
        if (!cd.ready) {
            throw new Error(`COOLDOWN:${cd.remaining}`);
        }

        const now = Date.now();
        await this.db.run("BEGIN IMMEDIATE");

        try {
            let user = await this.db.get(
                "SELECT * FROM group_users WHERE jid = ? AND group_id = ?", 
                [jid, groupId]
            );
            
            if (!user) {
                await this.db.run(
                    "INSERT INTO group_users (jid, group_id, balance, stress_level, last_interaction) VALUES (?, ?, 0, 0, ?)", 
                    [jid, groupId, now]
                );
                user = { jid, balance: 0, stress_level: 0, last_interaction: now };
            } else {
                const hours = (now - user.last_interaction) / 3600000;
                if (hours >= 24) {
                    user.stress_level = Math.max(0, user.stress_level - Math.floor(hours / 24));
                }
            }

            const isPity = MercyIA.shouldIntervene(user);
            const queryData = MercyIA.getRollQuery(isPity, user.balance, groupId);

            let char = await this.db.get(queryData.sql, queryData.params);
            
            if (!char) {
                char = await this.db.get("SELECT * FROM characters ORDER BY RANDOM() LIMIT 1");
            }

            await this.db.run(
                "UPDATE group_users SET stress_level = ?, last_interaction = ? WHERE jid = ? AND group_id = ?", 
                [user.stress_level, now, jid, groupId]
            );
            
            await this.db.run("COMMIT");
            
            return { 
                ...char, 
                currencyName: this.currency, 
                imageUrl: await ImageProvider.getRandomUrl(char.booru_tag), 
                pityActive: isPity, 
                jid, 
                groupId 
            };
        } catch (e) {
            await this.db.run("ROLLBACK");
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

    async buyCharacter(sock, rawJid, query, rawGroupId = 'global') {
        const buyerJid = await LidGuard.clean(sock, rawJid);
        const groupId = await this.#resolveGroup(rawGroupId);
        
        await this.db.run("BEGIN IMMEDIATE");

        try {
            const candidates = await this.db.all(`
                SELECT c.id, c.name, cl.owner_jid, cl.market_price 
                FROM characters c 
                JOIN claims cl ON c.id = cl.char_id AND cl.group_id = ? 
                WHERE (c.id = ? OR LOWER(c.name) = LOWER(?)) 
                AND cl.market_price IS NOT NULL`, 
                [groupId, query, query]
            );

            if (candidates.length === 0) throw new Error('NOT_FOR_SALE');

            if (candidates.length > 1) {
                const list = candidates.map(c => `[ID: ${c.id}] ${c.name} - ${c.market_price}¥`).join('\n');
                throw new Error(`AMBIGUOUS_BUY:\n${list}`);
            }

            const target = candidates[0];
            const buyer = await this.db.get(
                "SELECT balance FROM group_users WHERE jid = ? AND group_id = ?", 
                [buyerJid, groupId]
            );
            
            if ((buyer?.balance || 0) < target.market_price) throw new Error('INSUFFICIENT_FUNDS');
            if (target.owner_jid === buyerJid) throw new Error('ALREADY_OWNED_BY_YOU');

            await this.db.run("UPDATE group_users SET balance = balance - ? WHERE jid = ? AND group_id = ?", [target.market_price, buyerJid, groupId]);
            await this.db.run("UPDATE group_users SET balance = balance + ? WHERE jid = ? AND group_id = ?", [target.market_price, target.owner_jid, groupId]);
            await this.db.run("UPDATE claims SET owner_jid = ?, market_price = NULL WHERE char_id = ? AND group_id = ?", [buyerJid, target.id, groupId]);
            
            await this.db.run("COMMIT");
            return { success: true, name: target.name, price: target.market_price };
        } catch (e) {
            await this.db.run("ROLLBACK");
            throw e;
        }
    }

    async claim(sock, rawJid, query, rawGroupId = 'global') {
        const jid = await LidGuard.clean(sock, rawJid);
        const groupId = await this.#resolveGroup(rawGroupId);

        await this.db.run("BEGIN IMMEDIATE");

        try {
            const char = await this.#resolveCharacter(query, null, 'free', groupId);
            const user = await this.db.get(
                "SELECT balance FROM group_users WHERE jid = ? AND group_id = ?", 
                [jid, groupId]
            );
            
            if ((user?.balance || 0) < char.value) throw new Error('INSUFFICIENT_FUNDS');

            await this.db.run(
                "INSERT INTO claims (char_id, group_id, owner_jid) VALUES (?, ?, ?)", 
                [char.id, groupId, jid]
            );
            
            await this.db.run(
                "UPDATE group_users SET balance = balance - ?, stress_level = 0 WHERE jid = ? AND group_id = ?", 
                [char.value, jid, groupId]
            );
            
            await this.db.run("COMMIT");
            return { success: true, charId: char.id, charName: char.name };
        } catch (e) {
            await this.db.run("ROLLBACK");
            if (e.message?.includes('UNIQUE')) throw new Error('ALREADY_CLAIMED');
            throw e;
        }
    }

    async #resolveCharacter(query, ownerJid = null, forceMode = 'auto', groupId = 'global') {
        const select = "SELECT c.id, c.name, c.booru_tag, c.value, cl.owner_jid";
        const from = "FROM characters c LEFT JOIN claims cl ON c.id = cl.char_id AND cl.group_id = ?";
        let where = "";
        let params = [groupId, query, query];

        if (forceMode === 'free') {
            where = "WHERE (c.id = ? OR LOWER(c.name) = LOWER(?)) AND cl.owner_jid IS NULL";
        } else if (forceMode === 'owned') {
            where = "WHERE (c.id = ? OR LOWER(c.name) = LOWER(?)) AND cl.owner_jid = ?";
            params.push(ownerJid);
        } else {
            where = "WHERE (c.id = ? OR LOWER(c.name) = LOWER(?))";
        }

        const chars = await this.db.all(`${select} ${from} ${where}`, params);
        
        if (chars.length === 0) throw new Error('CHARACTER_NOT_FOUND');

        if (chars.length > 1) {
            const list = chars.map(c => `[ID: ${c.id}] ${c.name}`).join('\n');
            throw new Error(`AMBIGUOUS_QUERY:\n${list}`);
        }

        return chars[0];
    }

    async #resolveGroup(rawGroupId) {
        if (!rawGroupId?.endsWith('@g.us')) return 'global';
        const group = await this.db.get("SELECT mode FROM groups WHERE id = ?", [rawGroupId]);
        return group?.mode === 'private' ? rawGroupId : 'global';
    }
            }
