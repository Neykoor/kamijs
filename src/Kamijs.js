import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import crypto from 'crypto';
import { LidGuard } from './middleware/LidGuard.js';

const PULL_COST = 4000;
const PITY_LIMIT = 160;
const HIT_RATE = 0.03;

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
            `INSERT INTO characters (id, name, series, gender, booru_tag, value)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [charId, data.name, data.series, data.gender, data.booru_tag || data.name, data.value || 3000]
        );
        return charId;
    }

    async setBanner(title, series, featuredId) {
        await this.db.run(
            `INSERT INTO active_banner (id, title, series_target, featured_id)
             VALUES (1, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             series_target = excluded.series_target,
             featured_id = excluded.featured_id`,
            [title, series, featuredId]
        );
    }

    async deposit(jid, amount, sock) {
        const userJid = await LidGuard.clean(sock, jid);
        await this.db.run(
            `INSERT INTO users (jid, balance, pity_count, has_guaranteed)
             VALUES (?, ?, 0, 0)
             ON CONFLICT(jid) DO UPDATE SET balance = balance + ?`,
            [userJid, amount, amount]
        );
    }

    // --- MOTOR DE TIRADAS (GACHA ENGINE) ---

    async pull10(jid, type = 'banner', options = {}) {
        const { sock, groupId = 'global' } = options;
        const userJid = await LidGuard.clean(sock, jid);

        // Asegurar que el usuario exista con todos los campos correctos
        await this.db.run(
            `INSERT OR IGNORE INTO users (jid, balance, pity_count, has_guaranteed)
             VALUES (?, 0, 0, 0)`,
            [userJid]
        );

        const user = await this.db.get("SELECT * FROM users WHERE jid = ?", [userJid]);
        if (!user || user.balance < PULL_COST) throw new Error('INSUFFICIENT_FUNDS');

        const isBannerMode = type === 'banner';
        const banner = isBannerMode
            ? await this.db.get("SELECT * FROM active_banner WHERE id = 1")
            : null;

        if (isBannerMode && !banner) throw new Error('NO_ACTIVE_BANNER');

        const results = [];
        let p = user.pity_count;
        // Coerción explícita: SQLite devuelve 0/1 como número, forzamos booleano numérico
        let g = user.has_guaranteed ? 1 : 0;

        await this.db.run("BEGIN IMMEDIATE");
        try {
            for (let i = 0; i < 10; i++) {
                p++;
                let char = null;
                let isFeatured = false;

                const isHit = p >= PITY_LIMIT || Math.random() < HIT_RATE;

                if (isHit) {
                    isFeatured = true;
                    if (isBannerMode) {
                        if (g === 1 || p >= PITY_LIMIT || Math.random() > 0.5) {
                            // Gana 50/50 o garantizado
                            char = await this.db.get(
                                "SELECT * FROM characters WHERE id = ?",
                                [banner.featured_id]
                            );
                            p = 0;
                            g = 0;
                        } else {
                            // Pierde 50/50: personaje global excluyendo al featured
                            char = await this._getRandom('global', null, banner.featured_id);
                            g = 1;
                            p = 0;
                        }
                    } else {
                        // Modo RW: cualquier personaje del pool global
                        char = await this._getRandom('global', null, null);
                        p = 0;
                    }
                } else {
                    // Tirada normal
                    const excludeId = isBannerMode ? banner.featured_id : null;
                    char = await this._getRandom(type, banner, excludeId);
                }

                if (!char) {
                    // Pool vacío o serie sin personajes: abortar para no retornar resultados incompletos
                    throw new Error('EMPTY_POOL');
                }

                await this.db.run(
                    `INSERT OR IGNORE INTO claims (char_id, owner_jid, group_id, claimed_at)
                     VALUES (?, ?, ?, ?)`,
                    [char.id, userJid, groupId, Date.now()]
                );

                results.push({ ...char, isFeatured });
            }

            await this.db.run(
                `UPDATE users
                 SET balance = balance - ?, pity_count = ?, has_guaranteed = ?
                 WHERE jid = ?`,
                [PULL_COST, p, g, userJid]
            );

            await this.db.run("COMMIT");
            return results;

        } catch (e) {
            try {
                await this.db.run("ROLLBACK");
            } catch (rollbackErr) {
                console.warn('[Kamijs] ROLLBACK falló:', rollbackErr.message);
            }
            throw e;
        }
    }

    /**
     * Selector de personajes aleatorios.
     * @param {string} type - 'banner' filtra por serie, 'global' usa todo el pool
     * @param {object|null} banner - datos del banner activo
     * @param {string|null} excludeId - ID a excluir del resultado
     */
    async _getRandom(type, banner, excludeId) {
        const conditions = [];
        const params = [];

        if (type === 'banner' && banner?.series_target) {
            conditions.push("series = ?");
            params.push(banner.series_target);
        }

        if (excludeId) {
            conditions.push("id != ?");
            params.push(excludeId);
        }

        const where = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";
        return await this.db.get(
            `SELECT * FROM characters${where} ORDER BY RANDOM() LIMIT 1`,
            params
        );
    }
}
