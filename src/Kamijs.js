import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import crypto from 'crypto';
import { LidGuard } from './middleware/LidGuard.js';

const PULL_COST       = 4000;
const HIT_RATE_RW     = 0.015;
const HIT_RATE_BANNER = 0.015;
const PITY_LIMIT_RW     = 100;
const PITY_LIMIT_BANNER = 100;

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
                value INTEGER DEFAULT 3000,
                global_limit INTEGER DEFAULT 15
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
                luck REAL DEFAULT 0,
                last_active INTEGER DEFAULT 0,
                has_starter INTEGER DEFAULT 0,
                tickets INTEGER DEFAULT 0,
                premium_tickets INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS claims (
                char_id TEXT,
                owner_jid TEXT,
                claimed_at INTEGER
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

            /* TABLA DEL MERCADO GLOBAL */
            CREATE TABLE IF NOT EXISTS market (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                seller_jid TEXT,
                char_id TEXT,
                price INTEGER,
                listed_at INTEGER
            );

            INSERT OR IGNORE INTO bank (id, balance) VALUES (1, 0);
        `);

        // Migraciones y actualizaciones de columnas
        await this.db.run(`UPDATE characters SET value = 3000 WHERE value IS NULL`);
        await this.db.run(`ALTER TABLE users ADD COLUMN luck REAL DEFAULT 0`).catch(() => {});
        await this.db.run(`ALTER TABLE characters ADD COLUMN global_limit INTEGER DEFAULT 15`).catch(() => {});
        await this.db.run(`UPDATE characters SET global_limit = 15 WHERE global_limit IS NULL`).catch(() => {});
        await this.db.run(`ALTER TABLE users ADD COLUMN last_active INTEGER DEFAULT 0`).catch(() => {});
        await this.db.run(`ALTER TABLE users ADD COLUMN has_starter INTEGER DEFAULT 0`).catch(() => {});
        await this.db.run(`ALTER TABLE users ADD COLUMN tickets INTEGER DEFAULT 0`).catch(() => {});
        await this.db.run(`ALTER TABLE users ADD COLUMN premium_tickets INTEGER DEFAULT 0`).catch(() => {});
        
        // Migración a Inventario Global
        const claimsInfo = await this.db.all("PRAGMA table_info(claims)");
        const hasGroupId = claimsInfo.some(col => col.name === 'group_id');
        if (hasGroupId) {
            await this.db.exec(`
                CREATE TABLE claims_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    char_id TEXT,
                    owner_jid TEXT,
                    claimed_at INTEGER
                );
                INSERT INTO claims_new (char_id, owner_jid, claimed_at)
                SELECT char_id, owner_jid, MAX(claimed_at) FROM claims GROUP BY char_id, owner_jid;
                DROP TABLE claims;
                ALTER TABLE claims_new RENAME TO claims;
            `);
            console.log("[Kamijs] Migración a inventario global completada.");
        }
    }

    // --- SISTEMA DE PRESENCIA Y LIMPIEZA ---

    async updatePresence(sock, jid) {
        if (!jid) return;
        const userJid = await LidGuard.clean(sock, jid);
        const now = Date.now();
        await this.db.run(
            `INSERT INTO users (jid, balance, last_active) VALUES (?, 0, ?)
             ON CONFLICT(jid) DO UPDATE SET last_active = ?`,
            [userJid, now, now]
        );
    }

    async cleanInactiveUsers() {
        const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
        const cutoff = Date.now() - TWO_WEEKS;
        const result = await this.db.run(
            `DELETE FROM claims 
             WHERE owner_jid IN (SELECT jid FROM users WHERE last_active > 0 AND last_active < ?)`,
            [cutoff]
        );
        if (result.changes > 0) {
            console.log(`[Kamijs] Se liberaron ${result.changes} personajes de usuarios inactivos.`);
        }
    }

    // --- SISTEMA DE STARTER Y TICKETS ---

    async claimStarter(jid, charId, sock) {
        const userJid = await LidGuard.clean(sock, jid);
        await this.updatePresence(sock, jid);

        await this.db.run(`INSERT OR IGNORE INTO users (jid) VALUES (?)`, [userJid]);
        const user = await this.db.get('SELECT has_starter FROM users WHERE jid = ?', [userJid]);
        
        if (user.has_starter) throw new Error('ALREADY_CLAIMED_STARTER');

        const char = await this.db.get('SELECT * FROM characters WHERE id = ? COLLATE NOCASE OR LOWER(name) = LOWER(?)', [charId, charId]);
        if (!char) throw new Error('CHARACTER_NOT_FOUND');

        const claimsCount = await this.db.get('SELECT COUNT(*) as count FROM claims WHERE char_id = ?', [char.id]);
        if (char.global_limit && claimsCount.count >= char.global_limit) {
            throw new Error('OUT_OF_STOCK');
        }

        await this.db.run('BEGIN IMMEDIATE');
        try {
            await this.db.run(`INSERT INTO claims (char_id, owner_jid, claimed_at) VALUES (?, ?, ?)`, [char.id, userJid, Date.now()]);
            await this.db.run(`UPDATE users SET has_starter = 1 WHERE jid = ?`, [userJid]);
            await this.db.run('COMMIT');
            return char;
        } catch (e) {
            await this.db.run('ROLLBACK').catch(() => {});
            throw e;
        }
    }

    async useTicket(jid, charId, usePremium = false, sock) {
        const userJid = await LidGuard.clean(sock, jid);
        await this.updatePresence(sock, jid);

        const user = await this.db.get('SELECT tickets, premium_tickets FROM users WHERE jid = ?', [userJid]);
        if (!user) throw new Error('USER_NOT_FOUND');

        if (usePremium && user.premium_tickets <= 0) throw new Error('NO_PREMIUM_TICKETS');
        if (!usePremium && user.tickets <= 0) throw new Error('NO_TICKETS');

        const char = await this.db.get('SELECT * FROM characters WHERE id = ? COLLATE NOCASE OR LOWER(name) = LOWER(?)', [charId, charId]);
        if (!char) throw new Error('CHARACTER_NOT_FOUND');

        const claimsCount = await this.db.get('SELECT COUNT(*) as count FROM claims WHERE char_id = ?', [char.id]);
        if (!usePremium && char.global_limit && claimsCount.count >= char.global_limit) {
            throw new Error('OUT_OF_STOCK');
        }

        const alreadyOwns = await this.db.get('SELECT * FROM claims WHERE char_id = ? AND owner_jid = ?', [char.id, userJid]);
        if (alreadyOwns) throw new Error('ALREADY_OWNS');

        await this.db.run('BEGIN IMMEDIATE');
        try {
            await this.db.run(`INSERT INTO claims (char_id, owner_jid, claimed_at) VALUES (?, ?, ?)`, [char.id, userJid, Date.now()]);
            
            if (usePremium) {
                await this.db.run(`UPDATE users SET premium_tickets = premium_tickets - 1 WHERE jid = ?`, [userJid]);
            } else {
                await this.db.run(`UPDATE users SET tickets = tickets - 1 WHERE jid = ?`, [userJid]);
            }
            
            await this.db.run('COMMIT');
            return char;
        } catch (e) {
            await this.db.run('ROLLBACK').catch(() => {});
            throw e;
        }
    }

    async addTickets(jid, amount, isPremium = false, sock) {
        const userJid = await LidGuard.clean(sock, jid);
        const column = isPremium ? 'premium_tickets' : 'tickets';
        await this.db.run(`INSERT OR IGNORE INTO users (jid) VALUES (?)`, [userJid]);
        await this.db.run(`UPDATE users SET ${column} = ${column} + ? WHERE jid = ?`, [amount, userJid]);
    }

    // --- MERCADO GLOBAL ---

    async listMarket(jid, charId, price, sock) {
        if (price <= 0) throw new Error('INVALID_PRICE');
        const userJid = await LidGuard.clean(sock, jid);
        
        const claim = await this.db.get('SELECT * FROM claims WHERE char_id = ? AND owner_jid = ?', [charId, userJid]);
        if (!claim) throw new Error('CHARACTER_NOT_OWNED');

        const existing = await this.db.get('SELECT * FROM market WHERE char_id = ? AND seller_jid = ?', [charId, userJid]);
        if (existing) throw new Error('ALREADY_LISTED');

        await this.db.run(`INSERT INTO market (seller_jid, char_id, price, listed_at) VALUES (?, ?, ?, ?)`, [userJid, charId, price, Date.now()]);
    }

    async buyFromMarket(jid, marketId, sock) {
        const userJid = await LidGuard.clean(sock, jid);
        
        const listing = await this.db.get('SELECT * FROM market WHERE id = ?', [marketId]);
        if (!listing) throw new Error('LISTING_NOT_FOUND');
        if (listing.seller_jid === userJid) throw new Error('CANNOT_BUY_OWN');

        const user = await this.db.get('SELECT balance FROM users WHERE jid = ?', [userJid]);
        if (!user || user.balance < listing.price) throw new Error('INSUFFICIENT_FUNDS');

        const claim = await this.db.get('SELECT * FROM claims WHERE char_id = ? AND owner_jid = ?', [listing.char_id, listing.seller_jid]);
        if (!claim) {
            await this.db.run('DELETE FROM market WHERE id = ?', [marketId]);
            throw new Error('SELLER_NO_LONGER_OWNS');
        }

        const buyerClaim = await this.db.get('SELECT * FROM claims WHERE char_id = ? AND owner_jid = ?', [listing.char_id, userJid]);
        if (buyerClaim) throw new Error('ALREADY_OWNS');

        await this.db.run('BEGIN IMMEDIATE');
        try {
            const tax = Math.floor(listing.price * 0.05);
            const net = listing.price - tax;

            await this.db.run('UPDATE users SET balance = balance - ? WHERE jid = ?', [listing.price, userJid]);
            await this.db.run('UPDATE users SET balance = balance + ? WHERE jid = ?', [net, listing.seller_jid]);
            await this.db.run('UPDATE bank SET balance = balance + ? WHERE id = 1', [tax]);

            await this.db.run('UPDATE claims SET owner_jid = ? WHERE char_id = ? AND owner_jid = ?', [userJid, listing.char_id, listing.seller_jid]);
            await this.db.run('DELETE FROM market WHERE id = ?', [marketId]);

            await this.db.run('COMMIT');
        } catch (e) {
            await this.db.run('ROLLBACK').catch(() => {});
            throw e;
        }
    }
        // --- MÉTODOS BASE DEL GACHA ---

    async addCharacter(data) {
        const existing = await this.db.get(
            `SELECT id FROM characters WHERE LOWER(name) = LOWER(?) AND LOWER(series) = LOWER(?)`,
            [data.name, data.series]
        );
        if (existing) throw new Error('DUPLICATE_CHARACTER');

        const charId = data.id || crypto.randomBytes(4).toString('hex');
        await this.db.run(
            `INSERT INTO characters (id, name, series, gender, booru_tag, value, global_limit)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [charId, data.name, data.series, data.gender, data.booru_tag || data.name, data.value || 3000, data.global_limit ?? 15]
        );
        return charId;
    }

    async getRandomCharacterBySeries(series) {
        return await this.db.get(`SELECT * FROM characters WHERE LOWER(series) = LOWER(?) ORDER BY RANDOM() LIMIT 1`, [series]);
    }

    async getCharacter(id) {
        return await this.db.get('SELECT * FROM characters WHERE id = ?', [id]);
    }

    async setBanner(title, series, featuredId, durationDays = 20) {
        const expiresAt = Date.now() + durationDays * 24 * 60 * 60 * 1000;
        await this.db.run(
            `INSERT INTO active_banner (id, title, series_target, featured_id, expires_at)
             VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
             title = excluded.title, series_target = excluded.series_target,
             featured_id = excluded.featured_id, expires_at = excluded.expires_at`,
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

        const history = await this.db.all(`SELECT series FROM banner_history ORDER BY used_at DESC LIMIT 3`);
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
            randomSeries = await this.db.get(`SELECT series FROM characters GROUP BY series ORDER BY RANDOM() LIMIT 1`);
        }

        if (!randomSeries) return null;

        const featured = await this.db.get(`SELECT * FROM characters WHERE series = ? ORDER BY RANDOM() LIMIT 1`, [randomSeries.series]);
        if (!featured) return null;

        const title = `✨ Banner de ${randomSeries.series}`;
        const expiresAt = await this.setBanner(title, randomSeries.series, featured.id);

        await this.db.run(`INSERT INTO banner_history (series, used_at) VALUES (?, ?)`, [randomSeries.series, now]);
        await this.db.run(`DELETE FROM banner_history WHERE id NOT IN (SELECT id FROM banner_history ORDER BY used_at DESC LIMIT 3)`);

        return { title, series: randomSeries.series, featured, expiresAt };
    }

    async deposit(jid, amount, sock) {
        if (amount <= 0) throw new Error('INVALID_AMOUNT');
        const userJid = await LidGuard.clean(sock, jid);
        await this.db.run(
            `INSERT INTO users (jid, balance, pity_count, has_guaranteed) VALUES (?, ?, 0, 0)
             ON CONFLICT(jid) DO UPDATE SET balance = balance + ?`,
            [userJid, amount, amount]
        );
    }

    async getBank() {
        const row = await this.db.get('SELECT balance FROM bank WHERE id = 1');
        return row?.balance ?? 0;
    }

    async withdrawBank(amount, toJid, sock) {
        if (amount <= 0) throw new Error('INVALID_AMOUNT');
        const userJid = await LidGuard.clean(sock, toJid);
        const bank = await this.getBank();
        if (bank < amount) throw new Error('BANK_INSUFFICIENT_FUNDS');

        await this.db.run('BEGIN IMMEDIATE');
        try {
            await this.db.run('UPDATE bank SET balance = balance - ? WHERE id = 1', [amount]);
            await this.db.run(
                `INSERT INTO users (jid, balance, pity_count, has_guaranteed) VALUES (?, ?, 0, 0)
                 ON CONFLICT(jid) DO UPDATE SET balance = balance + ?`,
                [userJid, amount, amount]
            );
            await this.db.run('COMMIT');
        } catch (e) {
            await this.db.run('ROLLBACK').catch(() => {});
            throw e;
        }
    }

    async getHarem(jid, sock) {
        const userJid = await LidGuard.clean(sock, jid);
        await this.updatePresence(sock, jid);
        return await this.db.all(
            `SELECT c.id, c.name, c.series, c.gender, c.value, cl.claimed_at
             FROM claims cl JOIN characters c ON cl.char_id = c.id
             WHERE cl.owner_jid = ? ORDER BY cl.claimed_at DESC`,
            [userJid]
        );
    }

    async trade(fromJid, toJid, charId, sock) {
        const from = await LidGuard.clean(sock, fromJid);
        const to   = await LidGuard.clean(sock, toJid);
        await this.updatePresence(sock, fromJid);

        const claim = await this.db.get('SELECT * FROM claims WHERE char_id = ? AND owner_jid = ?', [charId, from]);
        if (!claim) throw new Error('CHARACTER_NOT_OWNED');
        if (from === to) throw new Error('SELF_TRADE');

        const receiverClaim = await this.db.get('SELECT * FROM claims WHERE char_id = ? AND owner_jid = ?', [charId, to]);
        if (receiverClaim) throw new Error('RECEIVER_ALREADY_OWNS');

        await this.db.run('BEGIN IMMEDIATE');
        try {
            const result = await this.db.run('UPDATE claims SET owner_jid = ? WHERE char_id = ? AND owner_jid = ?', [to, charId, from]);
            if (result.changes === 0) throw new Error('CHARACTER_NOT_OWNED');
            await this.db.run('COMMIT');
        } catch (e) {
            await this.db.run('ROLLBACK').catch(() => {});
            throw e;
        }
    }

    async getSeriesCharacters(series) {
        return await this.db.all(
            `SELECT c.id, c.name, c.gender, c.series, c.global_limit,
                    GROUP_CONCAT(cl.owner_jid) as global_owners,
                    (SELECT COUNT(*) FROM claims WHERE char_id = c.id) as total_claims
             FROM characters c
             LEFT JOIN claims cl ON cl.char_id = c.id
             WHERE LOWER(c.series) = LOWER(?)
             GROUP BY c.id ORDER BY c.name ASC`,
            [series]
        );
    }

    async pull10(jid, type = 'banner', options = {}) {
        const { sock } = options;
        const userJid = await LidGuard.clean(sock, jid);

        await this.updatePresence(sock, jid);

        const HIT_RATE   = type === 'banner' ? HIT_RATE_BANNER : HIT_RATE_RW;
        const PITY_LIMIT = type === 'banner' ? PITY_LIMIT_BANNER : PITY_LIMIT_RW;

        await this.db.run(
            `INSERT OR IGNORE INTO users (jid, balance, pity_count, has_guaranteed) VALUES (?, 0, 0, 0)`,
            [userJid]
        );

        const user = await this.db.get('SELECT * FROM users WHERE jid = ?', [userJid]);
        if (!user || user.balance < PULL_COST) throw new Error('INSUFFICIENT_FUNDS');

        const isBannerMode = type === 'banner';
        const banner = await this.db.get('SELECT * FROM active_banner WHERE id = 1');
        if (isBannerMode && !banner) throw new Error('NO_ACTIVE_BANNER');

        const results = [];
        let p = user.pity_count;
        let luck = user.luck ?? 0;
        let bankAccrued = 0;
        let hitOccurred = false;
        const pulledThisSession = new Set();

        await this.db.run('BEGIN IMMEDIATE');
        try {
            for (let i = 0; i < 10; i++) {
                p++;
                let char = null;
                let isRepeat = false;
                let repeatCompensation = 0;
                let jackpotBonus = 0;

                const pityHit = p >= PITY_LIMIT;
                const softRate = p >= 80 ? 0.06 : p >= 60 ? 0.04 : p >= 40 ? 0.025 : HIT_RATE;
                const effectiveRate = Math.min(softRate + luck, 1);
                const isHit = (pityHit && !hitOccurred) || Math.random() < effectiveRate;

                if (isHit) {
                    hitOccurred = true;
                    luck = 0;
                    p = 0;

                    char = await this._getRandom(type, banner, null, pulledThisSession);
                    if (!char) throw new Error('EMPTY_POOL');

                    if (Math.random() < 0.01) {
                        const bankBalance = await this.getBank();
                        if (bankBalance > 0) {
                            const maxJackpot = 20000;
                            jackpotBonus = Math.min(Math.floor(bankBalance * 0.05), maxJackpot);
                            await this.db.run('UPDATE bank SET balance = MAX(0, balance - ?) WHERE id = 1', [jackpotBonus]);
                            await this.db.run('UPDATE users SET balance = balance + ? WHERE jid = ?', [jackpotBonus, userJid]);
                        }
                    }

                    const existingClaim = await this.db.get('SELECT owner_jid FROM claims WHERE char_id = ? AND owner_jid = ?', [char.id, userJid]);
                    const existingInSession = pulledThisSession.has(char.id);

                    if (existingClaim || existingInSession) {
                        isRepeat = true;
                        char.currentOwnerJid = userJid;
                        const charValue = char.value || 0;
                        repeatCompensation = Math.floor(charValue * 0.30);
                        bankAccrued += charValue - repeatCompensation;
                        await this.db.run('UPDATE users SET balance = balance + ? WHERE jid = ?', [repeatCompensation, userJid]);
                        pulledThisSession.add(char.id);
                    } else {
                        pulledThisSession.add(char.id);
                        await this.db.run(`INSERT INTO claims (char_id, owner_jid, claimed_at) VALUES (?, ?, ?)`, [char.id, userJid, Date.now()]);
                    }
                } else {
                    luck = Math.min(luck + 0.001, 0.02);
                }

                // 🎟️ Probabilidad del 2% de soltar un Ticket de Selección Normal
                let droppedTicket = false;
                if (Math.random() < 0.02) { 
                    droppedTicket = true;
                    await this.db.run(`UPDATE users SET tickets = tickets + 1 WHERE jid = ?`, [userJid]);
                }

                results.push({ 
                    ...(char || {}), 
                    isRepeat, 
                    repeatCompensation, 
                    jackpotBonus, 
                    droppedTicket,
                    pity: p, 
                    luck: parseFloat(luck.toFixed(4)) 
                });
            }

            if (bankAccrued > 0) {
                await this.db.run('UPDATE bank SET balance = balance + ? WHERE id = 1', [bankAccrued]);
            }

            const result = await this.db.run(
                `UPDATE users SET balance = balance - ?, pity_count = ?, luck = ? WHERE jid = ? AND balance >= ?`,
                [PULL_COST, p, luck, userJid, PULL_COST]
            );

            if (result.changes === 0) throw new Error('INSUFFICIENT_FUNDS');
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
        conditions.push('(c.global_limit IS NULL OR c.global_limit > (SELECT COUNT(*) FROM claims WHERE char_id = c.id))');

        if (type === 'banner' && banner?.series_target) {
            conditions.push('LOWER(c.series) = LOWER(?)');
            params.push(banner.series_target);
        }
        if (type === 'global' && banner?.series_target) {
            conditions.push('LOWER(c.series) != LOWER(?)');
            params.push(banner.series_target);
        }
        if (excludeId) {
            conditions.push('c.id != ?');
            params.push(excludeId);
        }
        if (excludeSet.size > 0) {
            const placeholders = Array.from(excludeSet).map(() => '?').join(', ');
            conditions.push(`c.id NOT IN (${placeholders})`);
            params.push(...excludeSet);
        }

        const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
        return await this.db.get(`SELECT c.* FROM characters c${where} ORDER BY RANDOM() LIMIT 1`, params);
    }
                }
                        
