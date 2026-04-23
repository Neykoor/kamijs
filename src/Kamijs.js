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
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

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
            CREATE TABLE IF NOT EXISTS users (
                jid TEXT PRIMARY KEY,
                balance INTEGER DEFAULT 0,
                stress_level INTEGER DEFAULT 0,
                last_roll INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS claims (
                char_id TEXT,
                owner_jid TEXT,
                group_id TEXT,
                claimed_at INTEGER,
                PRIMARY KEY (char_id, group_id)
            );
        `);
    }

    async addCharacter(data) {
        const charId = data.id || crypto.randomBytes(4).toString('hex');
        try {
            await this.db.run(
                `INSERT INTO characters (id, name, series, gender, booru_tag, value) VALUES (?, ?, ?, ?, ?, ?)`,
                [charId, data.name, data.series, data.gender, data.booru_tag, data.value || 3000]
            );
            return charId;
        } catch (e) {
            if (e.message.includes('UNIQUE')) throw new Error('ID_ALREADY_EXISTS');
            throw e;
        }
    }

    async bulkAddCharacters(characters) {
        await this.db.run("BEGIN IMMEDIATE");
        try {
            const stmt = await this.db.prepare(
                `INSERT OR IGNORE INTO characters (id, name, series, gender, booru_tag, value) VALUES (?, ?, ?, ?, ?, ?)`
            );
            for (const char of characters) {
                const id = char.id || crypto.randomBytes(4).toString('hex');
                await stmt.run([id, char.name, char.series, char.gender, char.booru_tag, char.value || 3000]);
            }
            await stmt.finalize();
            await this.db.run("COMMIT");
        } catch (e) {
            try {
                await this.db.run("ROLLBACK");
            } catch (rollbackErr) {
                console.warn('[kamijs] bulkAddCharacters ROLLBACK failed:', rollbackErr.message);
            }
            throw e;
        }
    }
        async roll(jid, options = {}) {
        const { groupId = 'global', sock } = options;
        const userJid = await LidGuard.clean(sock, jid);

        await this.db.run(
            "INSERT OR IGNORE INTO users (jid, balance, stress_level, last_roll) VALUES (?, 0, 0, 0)",
            [userJid]
        );
        
        const user = await this.db.get("SELECT * FROM users WHERE jid = ?", [userJid]);
        const isPity = MercyIA.shouldIntervene(user);
        const query = MercyIA.getRollQuery(isPity, user.balance, groupId);
        
        const character = await this.db.get(query.sql, query.params);
        if (!character) throw new Error('CHARACTER_NOT_FOUND');

        const image = await ImageProvider.getRandomUrl(character.booru_tag);
        
        // Actualización atómica de estrés y timestamp
        await this.db.run(
            `UPDATE users 
             SET stress_level = CASE WHEN ? THEN 0 ELSE stress_level + 1 END,
                 last_roll = ?
             WHERE jid = ?`,
            [isPity ? 1 : 0, Date.now(), userJid]
        );

        return { character, image, isPity };
    }

    async claimCharacter(jid, query, options = {}) {
        const { groupId = 'global', sock } = options;
        const userJid = await LidGuard.clean(sock, jid);

        await this.db.run("BEGIN IMMEDIATE");
        try {
            const character = await this.#resolveCharacter(query, null, 'free', groupId);
            
            const user = await this.db.get("SELECT balance FROM users WHERE jid = ?", [userJid]);
            if (!user || user.balance < character.value) throw new Error('INSUFFICIENT_FUNDS');

            const result = await this.db.run(
                `UPDATE users SET balance = balance - ? WHERE jid = ? AND balance >= ?`,
                [character.value, userJid, character.value]
            );
            if (result.changes === 0) throw new Error('INSUFFICIENT_FUNDS');

            await this.db.run(
                "INSERT INTO claims (char_id, owner_jid, group_id, claimed_at) VALUES (?, ?, ?, ?)",
                [character.id, userJid, groupId, Date.now()]
            );
            
            await this.db.run("COMMIT");
            return character;
        } catch (e) {
            try { await this.db.run("ROLLBACK"); } catch (rE) { console.warn('[kamijs] ROLLBACK failed:', rE.message); }
            if (e.message?.includes('UNIQUE')) throw new Error('ALREADY_CLAIMED');
            throw e;
        }
    }

    async deposit(jid, amount, options = {}) {
        if (!Number.isInteger(amount) || amount <= 0) throw new Error('INVALID_AMOUNT');
        const userJid = await LidGuard.clean(options.sock, jid);
        await this.db.run(
            "INSERT INTO users (jid, balance) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET balance = balance + ?",
            [userJid, amount, amount]
        );
    }

    async #resolveCharacter(query, ownerJid = null, forceMode = 'auto', groupId = 'global') {
        const select = "SELECT c.*, cl.owner_jid";
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
}
