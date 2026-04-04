import { LidGuard } from './middleware/LidGuard.js';
import { ImageProvider } from './core/ImageProvider.js';
import { MercyIA } from './core/MercyIA.js';
import { EconomyManager } from './core/EconomyManager.js';
import { Cooldowns } from './utils/Cooldowns.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fs from 'fs-extra';

export class Kamijs {
    constructor(config = {}) {
        this.dbPath = config.dbPath || './gacha.db';
        this.jsonPath = config.jsonPath || './characters.json';
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
                id TEXT PRIMARY KEY, name TEXT, series TEXT, 
                gender TEXT, booru_tag TEXT, value INTEGER DEFAULT 3000, 
                owner_id TEXT DEFAULT NULL, votes INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS users (
                jid TEXT PRIMARY KEY, balance INTEGER DEFAULT 0, 
                stress_level INTEGER DEFAULT 0, last_interaction INTEGER
            );
        `);
        
        if (!fs.existsSync(this.jsonPath)) {
            await fs.writeJson(this.jsonPath, { characters: [] });
        }
    }

    async addCharacter(data) {
        const { id, name, series, gender, booru_tag, value = 3000 } = data;
        await this.db.run(
            "INSERT OR IGNORE INTO characters (id, name, series, gender, booru_tag, value) VALUES (?, ?, ?, ?, ?, ?)",
            [id, name, series, gender, booru_tag, value]
        );
        
        const backup = await fs.readJson(this.jsonPath);
        if (!backup.characters.find(c => c.id === id)) {
            backup.characters.push({ id, name, series, gender, booru_tag, value });
            await fs.writeJson(this.jsonPath, backup, { spaces: 2 });
        }
    }

    async reportMissedClaim(sock, rawJid) {
        const jid = await LidGuard.clean(sock, rawJid);
        await this.db.run(
            "UPDATE users SET stress_level = MIN(stress_level + 1, 5) WHERE jid = ?", 
            [jid]
        );
    }

    async claim(sock, rawJid, charId) {
        const jid = await LidGuard.clean(sock, rawJid);
        return await EconomyManager.processClaim(this.db, jid, charId);
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
        const char = await this.db.get(sql, params);

        if (!char) return { error: 'NOT_FOUND' };

        await this.db.run("UPDATE users SET last_interaction = ? WHERE jid = ?", [Date.now(), resolvedJid]);

        return {
            id: char.id,
            name: char.name,
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
}
