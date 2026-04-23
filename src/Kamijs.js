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

            -- 1. Tabla de Personajes (Aquí viven todos los datos de la ficha)
            CREATE TABLE IF NOT EXISTS characters (
                id TEXT PRIMARY KEY, 
                name TEXT, 
                series TEXT, 
                gender TEXT, 
                booru_tag TEXT,
                value INTEGER DEFAULT 3000
            );

            -- 2. Banner Activo
            CREATE TABLE IF NOT EXISTS active_banner (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                title TEXT,
                series_target TEXT,
                featured_id TEXT
            );

            -- 3. Usuarios y Economía
            CREATE TABLE IF NOT EXISTS users (
                jid TEXT PRIMARY KEY,
                balance INTEGER DEFAULT 0,
                pity_count INTEGER DEFAULT 0,
                has_guaranteed INTEGER DEFAULT 0
            );
        `);
    }

    /**
     * Añadir personaje asegurando que todos los campos de la ficha técnica existan.
     */
    async addCharacter(data) {
        const charId = data.id || crypto.randomBytes(4).toString('hex');
        await this.db.run(
            `INSERT INTO characters (id, name, series, gender, booru_tag, value) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                charId, 
                data.name, 
                data.series, 
                data.gender, 
                data.booru_tag || data.name, 
                data.value || 3000
            ]
        );
        return charId;
    }

    /**
     * Sistema de Depósito con validación de seguridad.
     */
    async deposit(jid, amount, sock) {
        if (!Number.isInteger(amount) || amount <= 0) throw new Error('INVALID_AMOUNT');
        const userJid = await LidGuard.clean(sock, jid);
        await this.db.run(
            `INSERT INTO users (jid, balance) VALUES (?, ?) 
             ON CONFLICT(jid) DO UPDATE SET balance = balance + ?`,
            [userJid, amount, amount]
        );
    }

    async setBanner(title, series, featuredId) {
        await this.db.run(
            `INSERT INTO active_banner (id, title, series_target, featured_id) 
             VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET 
             title=excluded.title, series_target=excluded.series_target, featured_id=excluded.featured_id`,
            [title, series, featuredId]
        );
    }

    /**
     * El motor de 10 tiradas. 
     * Devuelve objetos completos con ID, Nombre, Serie, Género y Valor.
     */
    async pull10(jid, type = 'banner', sock) {
        const userJid = await LidGuard.clean(sock, jid);
        
        await this.db.run("INSERT OR IGNORE INTO users (jid, balance) VALUES (?, 0)", [userJid]);
        const user = await this.db.get("SELECT * FROM users WHERE jid = ?", [userJid]);
        
        if (user.balance < 4000) throw new Error('INSUFFICIENT_FUNDS');

        const banner = await this.db.get("SELECT * FROM active_banner WHERE id = 1");
        if (!banner && type === 'banner') throw new Error('NO_ACTIVE_BANNER');

        let results = [];
        let p = user.pity_count;
        let g = user.has_guaranteed;

        for (let i = 0; i < 10; i++) {
            p++;
            let char;
            let isFeatured = false;

            // Lógica de Suerte: 3% o Pity de 160
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
            
            if (char) results.push({ ...char, isFeatured });
        }

        // Actualización atómica de la cuenta del usuario
        await this.db.run(
            `UPDATE users SET balance = balance - 4000, pity_count = ?, has_guaranteed = ? WHERE jid = ?`,
            [p, g, userJid]
        );

        return results;
    }

    /**
     * Selector aleatorio con SELECT * para no olvidar ningún dato.
     */
    async _getRandom(type, banner, excludeFeatured) {
        let sql = "SELECT * FROM characters";
        let params = [];
        
        if (type === 'banner') {
            sql += " WHERE series = ?";
            params.push(banner.series_target);
            if (excludeFeatured) { 
                sql += " AND id != ?"; 
                params.push(banner.featured_id); 
            }
        } else if (excludeFeatured) {
            sql += " WHERE id != ?";
            params.push(banner.featured_id);
        }
        
        return await this.db.get(`${sql} ORDER BY RANDOM() LIMIT 1`, params);
    }
}
