import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import crypto from 'crypto';
import { LidGuard } from './middleware/LidGuard.js';

const PULL_COST       = 4000;

const HIT_RATE_RW     = 0.03;
const HIT_RATE_BANNER = 0.03;

const PITY_LIMIT_RW     = 150;
const PITY_LIMIT_BANNER = 150;

const REPEAT_CAP      = 2000;

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
                featured_id TEXT,
                expires_at INTEGER
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

            CREATE TABLE IF NOT EXISTS bank (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                balance INTEGER DEFAULT 0
            );

            INSERT OR IGNORE INTO bank (id, balance) VALUES (1, 0);
        `);
    }

    // --- MÉTODOS ADMINISTRATIVOS ---

    async addCharacter(data) {
        const existing = await this.db.get(
            `SELECT id FROM characters WHERE LOWER(name) = LOWER(?) AND LOWER(series) = LOWER(?)`,
            [data.name, data.series]
        );
        if (existing) throw new Error('DUPLICATE_CHARACTER');

        const charId = data.id || crypto.randomBytes(4).toString('hex');
        await this.db.run(
            `INSERT INTO characters (id, name, series, gender, booru_tag, value)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [charId, data.name, data.series, data.gender, data.booru_tag || data.name, data.value || 3000]
        );
        return charId;
    }

    async getCharacter(id) {
        return await this.db.get('SELECT * FROM characters WHERE id = ?', [id]);
    }

    async setBanner(title, series, featuredId, durationDays = 20) {
        const expiresAt = Date.now() + durationDays * 24 * 60 * 60 * 1000;
        await this.db.run(
            `INSERT INTO active_banner (id, title, series_target, featured_id, expires_at)
             VALUES (1, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             series_target = excluded.series_target,
             featured_id = excluded.featured_id,
             expires_at = excluded.expires_at`,
            [title, series, featuredId, expiresAt]
        );
        return expiresAt;
    }

    async getActiveBanner() {
        return await this.db.get('SELECT * FROM active_banner WHERE id = 1');
    }

    async checkAndRotateBanner() {
        const banner = await this.getActiveBanner();
        const now = Date.now();

        if (banner && banner.expires_at > now) return null;

        const randomSeries = await this.db.get(
            `SELECT series FROM characters GROUP BY series ORDER BY RANDOM() LIMIT 1`
        );
        if (!randomSeries) return null;

        const featured = await this.db.get(
            `SELECT * FROM characters WHERE series = ? ORDER BY RANDOM() LIMIT 1`,
            [randomSeries.series]
        );
        if (!featured) return null;

        const title = `✨ Banner de ${randomSeries.series}`;
        const expiresAt = await this.setBanner(title, randomSeries.series, featured.id);

        return { title, series: randomSeries.series, featured, expiresAt };
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

    // --- BANCO ---

    async getBank() {
        const row = await this.db.get('SELECT balance FROM bank WHERE id = 1');
        return row?.balance ?? 0;
    }

    async withdrawBank(amount, toJid, sock) {
        const userJid = await LidGuard.clean(sock, toJid);
        const bank = await this.getBank();
        if (bank < amount) throw new Error('BANK_INSUFFICIENT_FUNDS');

        await this.db.run('BEGIN IMMEDIATE');
        try {
            await this.db.run('UPDATE bank SET balance = balance - ? WHERE id = 1', [amount]);
            await this.db.run(
                `INSERT INTO users (jid, balance, pity_count, has_guaranteed)
                 VALUES (?, ?, 0, 0)
                 ON CONFLICT(jid) DO UPDATE SET balance = balance + ?`,
                [userJid, amount, amount]
            );
            await this.db.run('COMMIT');
        } catch (e) {
            await this.db.run('ROLLBACK').catch(() => {});
            throw e;
        }
    }

    // --- HAREM ---

    async getHarem(jid, groupId = 'global', sock) {
        const userJid = await LidGuard.clean(sock, jid);
        return await this.db.all(
            `SELECT c.id, c.name, c.series, c.gender, c.value, cl.claimed_at
             FROM claims cl
             JOIN characters c ON cl.char_id = c.id
             WHERE cl.owner_jid = ? AND cl.group_id = ?
             ORDER BY cl.claimed_at DESC`,
            [userJid, groupId]
        );
    }

    // --- INTERCAMBIO ---

    async trade(fromJid, toJid, charId, groupId = 'global', sock) {
        const from = await LidGuard.clean(sock, fromJid);
        const to   = await LidGuard.clean(sock, toJid);

        const claim = await this.db.get(
            'SELECT * FROM claims WHERE char_id = ? AND owner_jid = ? AND group_id = ?',
            [charId, from, groupId]
        );
        if (!claim) throw new Error('CHARACTER_NOT_OWNED');

        const alreadyOwned = await this.db.get(
            'SELECT 1 FROM claims WHERE char_id = ? AND owner_jid = ? AND group_id = ?',
            [charId, to, groupId]
        );
        if (alreadyOwned) throw new Error('ALREADY_CLAIMED');

        await this.db.run('BEGIN IMMEDIATE');
        try {
            await this.db.run(
                'UPDATE claims SET owner_jid = ? WHERE char_id = ? AND owner_jid = ? AND group_id = ?',
                [to, charId, from, groupId]
            );
            await this.db.run('COMMIT');
        } catch (e) {
            await this.db.run('ROLLBACK').catch(() => {});
            throw e;
        }
    }

    // --- SERIES ---

    async getSeriesCharacters(series) {
        return await this.db.all(
            `SELECT id, name, gender, value FROM characters
             WHERE LOWER(series) = LOWER(?)
             ORDER BY name ASC`,
            [series]
        );
    }

    // --- MOTOR DE TIRADAS (GACHA ENGINE) ---

    async pull10(jid, type = 'banner', options = {}) {
        const { sock, groupId = 'global' } = options;
        const userJid = await LidGuard.clean(sock, jid);

        const HIT_RATE  = type === 'banner' ? HIT_RATE_BANNER : HIT_RATE_RW;
        const PITY_LIMIT = type === 'banner' ? PITY_LIMIT_BANNER : PITY_LIMIT_RW;

        await this.db.run(
            `INSERT OR IGNORE INTO users (jid, balance, pity_count, has_guaranteed)
             VALUES (?, 0, 0, 0)`,
            [userJid]
        );

        const user = await this.db.get('SELECT * FROM users WHERE jid = ?', [userJid]);
        if (!user || user.balance < PULL_COST) throw new Error('INSUFFICIENT_FUNDS');

        const isBannerMode = type === 'banner';
        const banner = isBannerMode
            ? await this.db.get('SELECT * FROM active_banner WHERE id = 1')
            : null;

        if (isBannerMode && !banner) throw new Error('NO_ACTIVE_BANNER');

        const results = [];
        let p = user.pity_count;
        let g = user.has_guaranteed ? 1 : 0;
        let bankAccrued = 0;
        let hitOccurred = false;

        p += 10;
        const forcedHit = p >= PITY_LIMIT;

        await this.db.run('BEGIN IMMEDIATE');
        try {
            for (let i = 0; i < 10; i++) {
                let char = null;
                let isFeatured = false;
                let isRepeat = false;
                let repeatCompensation = 0;

                const isLastPull = i === 9;
                const isHit = (!hitOccurred && isLastPull && forcedHit)
                    || Math.random() < HIT_RATE;

                if (isHit) {
                    isFeatured = true;
                    hitOccurred = true;
                    if (isBannerMode) {
                        if (g === 1 || p >= PITY_LIMIT || Math.random() > 0.5) {
                            char = await this.db.get(
                                'SELECT * FROM characters WHERE id = ?',
                                [banner.featured_id]
                            );
                            p = 0;
                            g = 0;
                        } else {
                            char = await this._getRandom('global', null, banner.featured_id);
                            g = 1;
                            p = 0;
                        }
                    } else {
                        char = await this._getRandom('global', null, null);
                        p = 0;
                    }
                } else {
                    const excludeId = isBannerMode ? banner.featured_id : null;
                    char = await this._getRandom(type, banner, excludeId);
                }

                if (!char) throw new Error('EMPTY_POOL');

                if (isHit) {
                    const existing = await this.db.get(
                        'SELECT 1 FROM claims WHERE char_id = ? AND owner_jid = ? AND group_id = ?',
                        [char.id, userJid, groupId]
                    );

                    if (existing) {
                        isRepeat = true;
                        if (type === 'global') {
                            const charValue = char.value || 0;
                            if (charValue > REPEAT_CAP) {
                                repeatCompensation = REPEAT_CAP;
                                bankAccrued += charValue - REPEAT_CAP;
                            } else {
                                repeatCompensation = charValue;
                            }
                            await this.db.run(
                                'UPDATE users SET balance = balance + ? WHERE jid = ?',
                                [repeatCompensation, userJid]
                            );
                        }
                    } else {
                        await this.db.run(
                            `INSERT OR IGNORE INTO claims (char_id, owner_jid, group_id, claimed_at)
                             VALUES (?, ?, ?, ?)`,
                            [char.id, userJid, groupId, Date.now()]
                        );
                    }
                }

                results.push({ ...char, isFeatured, isRepeat, repeatCompensation });
            }

            if (bankAccrued > 0) {
                await this.db.run('UPDATE bank SET balance = balance + ? WHERE id = 1', [bankAccrued]);
            }

            await this.db.run(
                `UPDATE users
                 SET balance = balance - ?, pity_count = ?, has_guaranteed = ?
                 WHERE jid = ?`,
                [PULL_COST, p, g, userJid]
            );

            await this.db.run('COMMIT');
            return results;

        } catch (e) {
            await this.db.run('ROLLBACK').catch(() => {});
            throw e;
        }
    }

    async _getRandom(type, banner, excludeId) {
        const conditions = [];
        const params = [];

        if (type === 'banner' && banner?.series_target) {
            conditions.push('series = ?');
            params.push(banner.series_target);
        }

        if (excludeId) {
            conditions.push('id != ?');
            params.push(excludeId);
        }

        const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
        return await this.db.get(
            `SELECT * FROM characters${where} ORDER BY RANDOM() LIMIT 1`,
            params
        );
    }
}
