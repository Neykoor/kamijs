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

            -- Tabla de inventario
            CREATE TABLE IF NOT EXISTS claims (
                char_id TEXT,
                owner_jid TEXT,
                group_id TEXT,
                claimed_at INTEGER,
                PRIMARY KEY (char_id, group_id)
            );
        `);
    }

    /**
     * Motor de 10 tiradas con registro automático de propiedad.
     */
    async pull10(jid, type = 'banner', options = {}) {
        const { sock, groupId = 'global' } = options;
        const userJid = await LidGuard.clean(sock, jid);
        
        const user = await this.db.get("SELECT * FROM users WHERE jid = ?", [userJid]);
        if (!user || user.balance < 4000) throw new Error('INSUFFICIENT_FUNDS');

        const banner = await this.db.get("SELECT * FROM active_banner WHERE id = 1");
        if (!banner && type === 'banner') throw new Error('NO_ACTIVE_BANNER');

        let results = [];
        let p = user.pity_count;
        let g = user.has_guaranteed;

        // Iniciamos transacción para que todo sea atómico
        await this.db.run("BEGIN IMMEDIATE");
        try {
            for (let i = 0; i < 10; i++) {
                p++;
                let char;
                let isFeatured = false;

                // Lógica de Suerte / Pity
                if (p >= 160 || Math.random() < 0.03) {
                    if (g === 1 || p >= 160 || Math.random() > 0.5) {
                        char = await this.db.get("SELECT * FROM characters WHERE id = ?", [banner.featured_id]);
                        isFeatured = true;
                        p = 0; g = 0;
                    } else {
                        char = await this._getRandom(type, banner, true);
                        g = 1; p = 0;
                    }
                } else {
                    char = await this._getRandom(type, banner, false);
                }

                if (char) {
                    // ¡AJUSTE CLAVE!: Registrar el personaje automáticamente para el usuario
                    // Usamos INSERT OR IGNORE por si ya lo tenía de un pull anterior
                    await this.db.run(
                        `INSERT OR IGNORE INTO claims (char_id, owner_jid, group_id, claimed_at) VALUES (?, ?, ?, ?)`,
                        [char.id, userJid, groupId, Date.now()]
                    );
                    results.push({ ...char, isFeatured });
                }
            }

            // Descontar saldo y actualizar contadores
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

    async _getRandom(type, banner, excludeFeatured) {
        let sql = "SELECT * FROM characters";
        let params = [];
        if (type === 'banner') {
            sql += " WHERE series = ?";
            params.push(banner.series_target);
            if (excludeFeatured) { sql += " AND id != ?"; params.push(banner.featured_id); }
        } else if (excludeFeatured) {
            sql += " WHERE id != ?";
            params.push(banner.featured_id);
        }
        return await this.db.get(sql + " ORDER BY RANDOM() LIMIT 1", params);
    }
}
