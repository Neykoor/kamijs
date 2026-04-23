import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import crypto from 'crypto';
import { LidGuard } from './middleware/LidGuard.js';

const PULL_COST       = 4000;

const HIT_RATE_RW     = 0.025;
const HIT_RATE_BANNER = 0.025;

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
                has_guaranteed INTEGER DEFAULT 0,
                luck REAL DEFAULT 0
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

            CREATE TABLE IF NOT EXISTS banner_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                series TEXT,
                used_at INTEGER
            );

            INSERT OR IGNORE INTO bank (id, balance) VALUES (1, 0);
        `);

        await this.db.run(`UPDATE characters SET value = 3000 WHERE value IS NULL`);
        await this.db.run(`ALTER TABLE users ADD COLUMN luck REAL DEFAULT 0`).catch(() => {});
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

    async getRandomCharacterBySeries(series) {
        return await this.db.get(
            `SELECT * FROM characters WHERE LOWER(series) = LOWER(?) ORDER BY RANDOM() LIMIT 1`,
            [series]
        );
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

        const history = await this.db.all(
            `SELECT series FROM banner_history ORDER BY used_at DESC LIMIT 3`
        );
        const excluded = history.map(r => r.series);

        let randomSeries;
        if (excluded.length > 0) {
            const placeholders = excluded.map(() => '?').join(', ');
            randomSeries = await this.db.get(
                `SELECT series FROM characters WHERE series NOT IN (${placeholders}) GROUP BY series ORDER BY RANDOM() LIMIT 1`,
                excluded
            );
        }

        if (!randomSeries) {
            randomSeries = await this.db.get(
                `SELECT series FROM characters GROUP BY series ORDER BY RANDOM() LIMIT 1`
            );
        }

        if (!randomSeries) return null;

        const featured = await this.db.get(
            `SELECT * FROM characters WHERE series = ? ORDER BY RANDOM() LIMIT 1`,
            [randomSeries.series]
        );
        if (!featured) return null;

        const title = `✨ Banner de ${randomSeries.series}`;
        const expiresAt = await this.setBanner(title, randomSeries.series, featured.id);

        await this.db.run(
            `INSERT INTO banner_history (series, used_at) VALUES (?, ?)`,
            [randomSeries.series, now]
        );
        await this.db.run(
            `DELETE FROM banner_history WHERE id NOT IN (
                SELECT id FROM banner_history ORDER BY used_at DESC LIMIT 3
            )`
        );

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
        let luck = user.luck ?? 0;
        let bankAccrued = 0;
        let hitOccurred = false;
        // IDs obtenidos en ESTA tirada para evitar duplicados intra-pull
        const pulledThisSession = new Set();

        await this.db.run('BEGIN IMMEDIATE');
        try {
            for (let i = 0; i < 10; i++) {
                p++;
                let char = null;
                let isFeatured = false;
                let isRepeat = false;
                let repeatCompensation = 0;
                let jackpotBonus = 0;

                const isLastPull = i === 9;
                const pityHit = p >= PITY_LIMIT;
                const multiGuarantee = isLastPull && !hitOccurred;

                const softRate =
                    p >= 110 ? 0.08 :
                    p >= 90  ? 0.05 :
                    p >= 70  ? 0.04 :
                    HIT_RATE;
                const effectiveRate = Math.min(softRate + luck, 1);

                const isHit =
                    (pityHit && !hitOccurred) ||
                    multiGuarantee ||
                    Math.random() < effectiveRate;

                if (isHit) {
                    hitOccurred = true;
                    luck = 0;

                    if (isBannerMode) {
                        const win50 = Math.random() < 0.5;
                        if (g === 1 || pityHit || win50) {
                            isFeatured = true;
                            char = await this.db.get(
                                'SELECT * FROM characters WHERE id = ?',
                                [banner.featured_id]
                            );
                            if (!char) char = await this._getRandom('global', null, null, pulledThisSession);
                            p = 0;
                            g = 0;
                        } else {
                            char = await this._getRandom('global', null, banner.featured_id, pulledThisSession);
                            g = 1;
                            p = 0;
                        }
                    } else {
                        char = await this._getRandom('global', null, null, pulledThisSession);
                        p = 0;
                    }

                    if (Math.random() < 0.01) {
                        const bankBalance = await this.getBank();
                        if (bankBalance > 0) {
                            const maxJackpot = 20000;
                            jackpotBonus = Math.min(Math.floor(bankBalance * 0.05), maxJackpot);
                            bankAccrued -= jackpotBonus;
                            await this.db.run(
                                'UPDATE users SET balance = balance + ? WHERE jid = ?',
                                [jackpotBonus, userJid]
                            );
                        }
                    }
                } else {
                    luck = Math.min(luck + 0.001, 0.02);
                    const excludeId = isBannerMode ? banner.featured_id : null;
                    char = await this._getRandom(type, banner, excludeId, pulledThisSession);
                }

                if (!char) throw new Error('EMPTY_POOL');

                if (isHit) {
                    const existingInDb = await this.db.get(
                        'SELECT 1 FROM claims WHERE char_id = ? AND owner_jid = ? AND group_id = ?',
                        [char.id, userJid, groupId]
                    );
                    // También es repetido si ya salió en esta misma tirada
                    const existingInSession = pulledThisSession.has(char.id);

                    if (existingInDb || existingInSession) {
                        isRepeat = true;
                        const charValue = char.value || 0;
                        repeatCompensation = Math.floor(charValue * 0.30);
                        bankAccrued += charValue - repeatCompensation;
                        await this.db.run(
                            'UPDATE users SET balance = balance + ? WHERE jid = ?',
                            [repeatCompensation, userJid]
                        );
                    } else {
                        pulledThisSession.add(char.id);
                        await this.db.run(
                            `INSERT INTO claims (char_id, owner_jid, group_id, claimed_at)
                             VALUES (?, ?, ?, ?)`,
                            [char.id, userJid, groupId, Date.now()]
                        );
                    }
                }

                results.push({ ...char, isFeatured, isRepeat, repeatCompensation, jackpotBonus, pity: p, luck: parseFloat(luck.toFixed(4)) });
            }

            if (bankAccrued > 0) {
                await this.db.run('UPDATE bank SET balance = balance + ? WHERE id = 1', [bankAccrued]);
            } else if (bankAccrued < 0) {
                await this.db.run('UPDATE bank SET balance = MAX(0, balance + ?) WHERE id = 1', [bankAccrued]);
            }

            await this.db.run(
                `UPDATE users
                 SET balance = balance - ?, pity_count = ?, has_guaranteed = ?, luck = ?
                 WHERE jid = ?`,
                [PULL_COST, p, g, luck, userJid]
            );

            await this.db.run('COMMIT');
            return results;

        } catch (e) {
            await this.db.run('ROLLBACK').catch(() => {});
            throw e;
        }
    }

    async _getRandom(type, banner, excludeId, excludeSet = new Set()) {
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

        // Excluir personajes ya obtenidos en esta tirada
        if (excludeSet.size > 0) {
            const placeholders = Array.from(excludeSet).map(() => '?').join(', ');
            conditions.push(`id NOT IN (${placeholders})`);
            params.push(...excludeSet);
        }

        const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
        return await this.db.get(
            `SELECT * FROM characters${where} ORDER BY RANDOM() LIMIT 1`,
            params
        );
    }
}

        
