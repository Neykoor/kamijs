import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import crypto from 'crypto';
import { LidGuard } from './middleware/LidGuard.js';

export class Kamijs {
    constructor(config = {}) {
        this.dbPath = config.dbPath || './database/gacha.db';
        this.db = null;
    }

    async init() {
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        this.db = await open({ filename: this.dbPath, driver: sqlite3.Database });
        
        await this.db.exec(`
            PRAGMA busy_timeout = 5000;
            PRAGMA journal_mode = WAL;

            CREATE TABLE IF NOT EXISTS characters (
                id TEXT PRIMARY KEY, 
                name TEXT, 
                series TEXT, 
                gender TEXT, 
                booru_tag TEXT,
                value INTEGER DEFAULT 3000
            );

            CREATE TABLE IF NOT EXISTS active_banner (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                title TEXT,
                series_target TEXT,
                featured_id TEXT
            );

            CREATE TABLE IF NOT EXISTS users (
                jid TEXT PRIMARY KEY,
                balance INTEGER DEFAULT 0,
                pity_count INTEGER DEFAULT 0,
                has_guaranteed INTEGER DEFAULT 0
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

    // --- MÉTODOS ADMINISTRATIVOS ---

    async addCharacter(data) {
        const charId = data.id || crypto.randomBytes(4).toString('hex');
        await this.db.run(
            `INSERT INTO characters (id, name, series, gender, booru_tag, value) VALUES (?, ?, ?, ?, ?, ?)`,
            [charId, data.name, data.series, data.gender, data.booru_tag || data.name, data.value || 3000]
        );
        return charId;
    }

    async setBanner(title, series, featuredId) {
        await this.db.run(
            `INSERT INTO active_banner (id, title, series_target, featured_id) 
             VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET 
             title=excluded.title, series_target=excluded.series_target, featured_id=excluded.featured_id`,
            [title, series, featuredId]
        );
    }

    async deposit(jid, amount, sock) {
        const userJid = await LidGuard.clean(sock, jid);
        await this.db.run(
            `INSERT INTO users (jid, balance) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET balance = balance + ?`,
            [userJid, amount, amount]
        );
    }

    // --- MOTOR DE TIRADAS ---

    async pull10(jid, type = 'banner', options = {}) {
        const { sock, groupId = 'global' } = options;
        const userJid = await LidGuard.clean(sock, jid);
        
        await this.db.run("INSERT OR IGNORE INTO users (jid, balance) VALUES (?, 0)", [userJid]);
        const user = await this.db.get("SELECT * FROM users WHERE jid = ?", [userJid]);
        
        if (user.balance < 4000) throw new Error('INSUFFICIENT_FUNDS');

        const banner = await this.db.get("SELECT * FROM active_banner WHERE id = 1");
        if (!banner && type === 'banner') throw new Error('NO_ACTIVE_BANNER');

        let results = [];
        let p = user.pity_count;
        let g = user.has_guaranteed;

        await this.db.run("BEGIN IMMEDIATE");
        try {
            for (let i = 0; i < 10; i++) {
                p++;
                let char;
                let isFeatured = false;

                // Lógica de Suerte (3%) o Pity (160)
                if (p >= 160 || Math.random() < 0.03) {
                    if (type === 'banner') {
                        // MODO BANNER: 50/50 contra el destacado del mes
                        if (g === 1 || p >= 160 || Math.random() > 0.5) {
                            char = await this.db.get("SELECT * FROM characters WHERE id = ?", [banner.featured_id]);
                            isFeatured = true;
                            p = 0; g = 0;
                        } else {
                            // Perdió 50/50: Saca cualquier otro personaje y activa garantizado
                            char = await this._getRandom('global', banner, true);
                            g = 1; p = 0;
                            isFeatured = true; // Sigue siendo un "Hit" (✔️) aunque no sea el principal
                        }
                    } else {
                        // MODO RW: Cualquier personaje puede ser un "Hit" (✔️)
                        char = await this._getRandom('global', banner, false);
                        isFeatured = true;
                        p = 0; 
                    }
                } else {
                    // Tirada Normal (❌)
                    char = await this._getRandom(type, banner, false);
                }

                if (char) {
                    await this.db.run(
                        `INSERT OR IGNORE INTO claims (char_id, owner_jid, group_id, claimed_at) VALUES (?, ?, ?, ?)`,
                        [char.id, userJid, groupId, Date.now()]
                    );
                    results.push({ ...char, isFeatured });
                }
            }

            await this.db.run(
                "UPDATE users SET balance = balance - 4000, pity_count = ?, has_guaranteed = ? WHERE jid = ?",
                [p, g, userJid]
            );

            await this.db.run("COMMIT");
            return results;
        } catch (e) {
            await this.db.run("ROLLBACK");
            throw e;
        }
    }

    /**
     * Selector aleatorio inteligente
     */
    async _getRandom(type, banner, excludeFeatured) {
        let sql = "SELECT * FROM characters";
        let params = [];
        let conditions = [];

        if (type === 'banner' && banner) {
            // Solo personajes de la serie del banner
            conditions.push("series = ?");
            params.push(banner.series_target);
        }

        if (excludeFeatured && banner?.featured_id) {
            conditions.push("id != ?");
            params.push(banner.featured_id);
        }

        if (conditions.length > 0) {
            sql += " WHERE " + conditions.join(" AND ");
        }

        return await this.db.get(sql + " ORDER BY RANDOM() LIMIT 1", params);
    }
}
