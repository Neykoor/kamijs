import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import crypto from "crypto";
import { LidGuard } from "./middleware/LidGuard.js";

const PULL_COST = 4000;
const HIT_RATE_RW = 0.015;
const PITY_LIMIT_RW = 100;
const MAX_MARKET_PRICE = 1000000000;

export class Kamijs {
    constructor(config = {}) {
        this.dbPath = config.dbPath || "./database/gacha.db";
        this.db = null;
    }

    init() {
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        this.db = new Database(this.dbPath);
        this.db.pragma("busy_timeout = 5000");
        this.db.pragma("journal_mode = WAL");

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS characters (id TEXT PRIMARY KEY, name TEXT NOT NULL, series TEXT NOT NULL, gender TEXT, booru_tag TEXT, value INTEGER DEFAULT 3000, global_limit INTEGER DEFAULT 15);
            CREATE TABLE IF NOT EXISTS users (jid TEXT PRIMARY KEY, balance INTEGER DEFAULT 0, pity_count INTEGER DEFAULT 0, luck REAL DEFAULT 0, last_active INTEGER DEFAULT 0, has_starter INTEGER DEFAULT 0, tickets INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS claims (id INTEGER PRIMARY KEY AUTOINCREMENT, char_id TEXT, owner_jid TEXT, claimed_at INTEGER);
            CREATE TABLE IF NOT EXISTS bank (id INTEGER PRIMARY KEY CHECK (id = 1), balance INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS market (id INTEGER PRIMARY KEY AUTOINCREMENT, seller_jid TEXT, char_id TEXT, price INTEGER, listed_at INTEGER);
            CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY);
            INSERT OR IGNORE INTO bank (id, balance) VALUES (1, 0);
        `);

        const currentVersion = this.db.prepare("SELECT MAX(version) as v FROM migrations").get()?.v || 0;

        if (currentVersion < 1) {
            this.db.prepare("UPDATE characters SET value = 3000 WHERE value IS NULL").run();
            const userCols = this.db.pragma("table_info(users)");
            if (!userCols.some((col) => col.name === "luck")) {
                this.db.exec("ALTER TABLE users ADD COLUMN luck REAL DEFAULT 0; ALTER TABLE users ADD COLUMN last_active INTEGER DEFAULT 0; ALTER TABLE users ADD COLUMN has_starter INTEGER DEFAULT 0; ALTER TABLE users ADD COLUMN tickets INTEGER DEFAULT 0;");
            }
            const charCols = this.db.pragma("table_info(characters)");
            if (!charCols.some((col) => col.name === "global_limit")) {
                this.db.exec("ALTER TABLE characters ADD COLUMN global_limit INTEGER DEFAULT 15; UPDATE characters SET global_limit = 15 WHERE global_limit IS NULL;");
            }
            const claimsInfo = this.db.pragma("table_info(claims)");
            if (claimsInfo.some((col) => col.name === "group_id")) {
                this.db.exec("CREATE TABLE claims_new (id INTEGER PRIMARY KEY AUTOINCREMENT, char_id TEXT, owner_jid TEXT, claimed_at INTEGER); INSERT INTO claims_new (char_id, owner_jid, claimed_at) SELECT char_id, owner_jid, MAX(claimed_at) FROM claims GROUP BY char_id, owner_jid; DROP TABLE claims; ALTER TABLE claims_new RENAME TO claims;");
            }
            this.db.prepare("INSERT INTO migrations (version) VALUES (1)").run();
        }
    }

    async updatePresence(sock, jid) {
        if (!jid) return;
        const userJid = await LidGuard.clean(sock, jid);
        const now = Date.now();
        this.db.prepare("INSERT INTO users (jid, balance, last_active) VALUES (?, 0, ?) ON CONFLICT(jid) DO UPDATE SET last_active = ?").run(userJid, now, now);
    }

    cleanInactiveUsers() {
        const cutoff = Date.now() - 1209600000;
        this.db.prepare("DELETE FROM claims WHERE owner_jid IN (SELECT jid FROM users WHERE last_active > 0 AND last_active < ?)").run(cutoff);
        this.db.prepare("DELETE FROM users WHERE last_active > 0 AND last_active < ?").run(cutoff);
    }

    async claimStarter(jid, charId, sock) {
        const userJid = await LidGuard.clean(sock, jid);
        await this.updatePresence(sock, jid);
        this.db.prepare("INSERT OR IGNORE INTO users (jid) VALUES (?)").run(userJid);
        
        return this.db.transaction(() => {
            if (this.db.prepare("SELECT has_starter FROM users WHERE jid = ?").get(userJid).has_starter) throw new Error("ALREADY_CLAIMED_STARTER");
            const char = this.db.prepare("SELECT * FROM characters WHERE id = ? COLLATE NOCASE OR LOWER(name) = LOWER(?)").get(charId, charId);
            if (!char) throw new Error("CHARACTER_NOT_FOUND");
            if (char.global_limit && this.db.prepare("SELECT COUNT(*) as count FROM claims WHERE char_id = ?").get(char.id).count >= char.global_limit) throw new Error("OUT_OF_STOCK");
            
            this.db.prepare("INSERT INTO claims (char_id, owner_jid, claimed_at) VALUES (?, ?, ?)").run(char.id, userJid, Date.now());
            this.db.prepare("UPDATE users SET has_starter = 1 WHERE jid = ?").run(userJid);
            return char;
        })();
    }

    async useTicket(jid, charId, sock) {
        const userJid = await LidGuard.clean(sock, jid);
        await this.updatePresence(sock, jid);
        
        return this.db.transaction(() => {
            const user = this.db.prepare("SELECT tickets FROM users WHERE jid = ?").get(userJid);
            if (!user || user.tickets <= 0) throw new Error(user ? "NO_TICKETS" : "USER_NOT_FOUND");
            
            const char = this.db.prepare("SELECT * FROM characters WHERE id = ? COLLATE NOCASE OR LOWER(name) = LOWER(?)").get(charId, charId);
            if (!char) throw new Error("CHARACTER_NOT_FOUND");
            if (char.global_limit && this.db.prepare("SELECT COUNT(*) as count FROM claims WHERE char_id = ?").get(char.id).count >= char.global_limit) throw new Error("OUT_OF_STOCK");
            if (this.db.prepare("SELECT * FROM claims WHERE char_id = ? AND owner_jid = ?").get(char.id, userJid)) throw new Error("ALREADY_OWNS");

            const isSuccess = Math.random() < 0.30;
            this.db.prepare("UPDATE users SET tickets = tickets - 1 WHERE jid = ?").run(userJid);
            if (isSuccess) this.db.prepare("INSERT INTO claims (char_id, owner_jid, claimed_at) VALUES (?, ?, ?)").run(char.id, userJid, Date.now());
            if (!isSuccess) throw new Error("TICKET_FAILED");
            return char;
        })();
    }

    async addTickets(jid, amount, sock) {
        const userJid = await LidGuard.clean(sock, jid);
        this.db.transaction(() => {
            this.db.prepare("INSERT OR IGNORE INTO users (jid) VALUES (?)").run(userJid);
            this.db.prepare("UPDATE users SET tickets = tickets + ? WHERE jid = ?").run(amount, userJid);
        })();
    }

    async listMarket(jid, charId, price, sock) {
        if (price <= 0 || price > MAX_MARKET_PRICE) throw new Error("INVALID_PRICE");
        const userJid = await LidGuard.clean(sock, jid);
        this.db.transaction(() => {
            if (!this.db.prepare("SELECT * FROM claims WHERE char_id = ? AND owner_jid = ?").get(charId, userJid)) throw new Error("CHARACTER_NOT_OWNED");
            if (this.db.prepare("SELECT * FROM market WHERE char_id = ? AND seller_jid = ?").get(charId, userJid)) throw new Error("ALREADY_LISTED");
            this.db.prepare("INSERT INTO market (seller_jid, char_id, price, listed_at) VALUES (?, ?, ?, ?)").run(userJid, charId, price, Date.now());
        })();
    }

    async buyFromMarket(jid, marketId, sock) {
        const userJid = await LidGuard.clean(sock, jid);
        this.db.transaction(() => {
            const listing = this.db.prepare("SELECT * FROM market WHERE id = ?").get(marketId);
            if (!listing) throw new Error("LISTING_NOT_FOUND");
            if (listing.seller_jid === userJid) throw new Error("CANNOT_BUY_OWN");
            
            const user = this.db.prepare("SELECT balance FROM users WHERE jid = ?").get(userJid);
            if (!user || user.balance < listing.price) throw new Error("INSUFFICIENT_FUNDS");
            
            if (!this.db.prepare("SELECT * FROM claims WHERE char_id = ? AND owner_jid = ?").get(listing.char_id, listing.seller_jid)) {
                this.db.prepare("DELETE FROM market WHERE id = ?").run(marketId);
                throw new Error("SELLER_NO_LONGER_OWNS");
            }
            if (this.db.prepare("SELECT * FROM claims WHERE char_id = ? AND owner_jid = ?").get(listing.char_id, userJid)) throw new Error("ALREADY_OWNS");
            
            const tax = Math.floor(listing.price * 0.05);
            this.db.prepare("UPDATE users SET balance = balance - ? WHERE jid = ?").run(listing.price, userJid);
            this.db.prepare("UPDATE users SET balance = balance + ? WHERE jid = ?").run(listing.price - tax, listing.seller_jid);
            this.db.prepare("UPDATE bank SET balance = balance + ? WHERE id = 1").run(tax);
            this.db.prepare("UPDATE claims SET owner_jid = ? WHERE char_id = ? AND owner_jid = ?").run(userJid, listing.char_id, listing.seller_jid);
            this.db.prepare("DELETE FROM market WHERE id = ?").run(marketId);
        })();
    }

    addCharacter(data) {
        if (!data.name || !data.series) throw new Error("MISSING_REQUIRED_FIELDS");
        if (this.db.prepare("SELECT id FROM characters WHERE LOWER(name) = LOWER(?) AND LOWER(series) = LOWER(?)").get(data.name, data.series)) throw new Error("DUPLICATE_CHARACTER");
        
        const charId = data.id || crypto.randomBytes(4).toString("hex");
        this.db.prepare("INSERT INTO characters (id, name, series, gender, booru_tag, value, global_limit) VALUES (?, ?, ?, ?, ?, ?, ?)").run(charId, data.name, data.series, data.gender, data.booru_tag || data.name, data.value || 3000, data.global_limit ?? 15);
        return charId;
    }

    getRandomCharacterBySeries(series) {
        const chars = this.db.prepare("SELECT id FROM characters WHERE LOWER(series) = LOWER(?)").all(series);
        if (!chars.length) return null;
        return this.db.prepare("SELECT * FROM characters WHERE id = ?").get(chars[Math.floor(Math.random() * chars.length)].id);
    }

    getCharacter(id) {
        return this.db.prepare("SELECT * FROM characters WHERE id = ?").get(id);
    }

    async deposit(jid, amount, sock) {
        if (amount <= 0) throw new Error("INVALID_AMOUNT");
        const userJid = await LidGuard.clean(sock, jid);
        this.db.prepare("INSERT INTO users (jid, balance) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET balance = balance + ?").run(userJid, amount, amount);
    }

    getBank() {
        return this.db.prepare("SELECT balance FROM bank WHERE id = 1").get()?.balance ?? 0;
    }

    async withdrawBank(amount, toJid, sock) {
        if (amount <= 0) throw new Error("INVALID_AMOUNT");
        const userJid = await LidGuard.clean(sock, toJid);
        this.db.transaction(() => {
            if (this.getBank() < amount) throw new Error("BANK_INSUFFICIENT_FUNDS");
            this.db.prepare("UPDATE bank SET balance = balance - ? WHERE id = 1").run(amount);
            this.db.prepare("INSERT INTO users (jid, balance) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET balance = balance + ?").run(userJid, amount, amount);
        })();
    }

    async getHarem(jid, sock) {
        const userJid = await LidGuard.clean(sock, jid);
        await this.updatePresence(sock, jid);
        return this.db.prepare("SELECT c.id, c.name, c.series, c.gender, c.value, cl.claimed_at FROM claims cl JOIN characters c ON cl.char_id = c.id WHERE cl.owner_jid = ? ORDER BY cl.claimed_at DESC").all(userJid);
    }

    async trade(fromJid, toJid, charId, sock) {
        const from = await LidGuard.clean(sock, fromJid);
        const to = await LidGuard.clean(sock, toJid);
        await this.updatePresence(sock, fromJid);
        this.db.transaction(() => {
            if (!this.db.prepare("SELECT * FROM claims WHERE char_id = ? AND owner_jid = ?").get(charId, from)) throw new Error("CHARACTER_NOT_OWNED");
            if (from === to) throw new Error("SELF_TRADE");
            if (this.db.prepare("SELECT * FROM claims WHERE char_id = ? AND owner_jid = ?").get(charId, to)) throw new Error("RECEIVER_ALREADY_OWNS");
            if (this.db.prepare("UPDATE claims SET owner_jid = ? WHERE char_id = ? AND owner_jid = ?").run(to, charId, from).changes === 0) throw new Error("CHARACTER_NOT_OWNED");
        })();
    }

    getSeriesCharacters(series) {
        return this.db.prepare("SELECT c.id, c.name, c.gender, c.series, c.global_limit, GROUP_CONCAT(cl.owner_jid) as global_owners, (SELECT COUNT(*) FROM claims WHERE char_id = c.id) as total_claims FROM characters c LEFT JOIN claims cl ON cl.char_id = c.id WHERE LOWER(c.series) = LOWER(?) GROUP BY c.id ORDER BY c.name ASC").all(series);
    }

    async pull10(jid, options = {}) {
        const { sock, chatId } = options;
        const userJid = await LidGuard.clean(sock, jid);
        await this.updatePresence(sock, jid);
        this.db.prepare("INSERT OR IGNORE INTO users (jid) VALUES (?)").run(userJid);
        
        return this.db.transaction(() => {
            const user = this.db.prepare("SELECT * FROM users WHERE jid = ?").get(userJid);
            if (!user || user.balance < PULL_COST) throw new Error("INSUFFICIENT_FUNDS");

            const results = [];
            let p = user.pity_count, luck = user.luck ?? 0, currentTickets = user.tickets ?? 0;
            let bankAccrued = 0, jackpotTotal = 0, hitOccurred = false;
            const pulledThisSession = new Set(), newClaims = [];
            let currentBank = this.getBank();

            for (let i = 0; i < 10; i++) {
                p++;
                let char = null, isRepeat = false, repeatCompensation = 0, jackpotBonus = 0;
                const effectiveRate = Math.min((p >= 80 ? 0.06 : p >= 60 ? 0.04 : p >= 40 ? 0.025 : HIT_RATE_RW) + luck, 1);

                if ((p >= PITY_LIMIT_RW && !hitOccurred) || Math.random() < effectiveRate) {
                    hitOccurred = true; luck = 0; p = 0;
                    char = this._getRandomSync(pulledThisSession);
                    if (!char) throw new Error("EMPTY_POOL");
                    
                    if (Math.random() < 0.01 && currentBank > 0) {
                        jackpotBonus = Math.min(Math.floor(currentBank * 0.05), 20000);
                        currentBank -= jackpotBonus;
                        jackpotTotal += jackpotBonus;
                    }
                    
                    if (this.db.prepare("SELECT owner_jid FROM claims WHERE char_id = ? AND owner_jid = ?").get(char.id, userJid) || pulledThisSession.has(char.id)) {
                        isRepeat = true;
                        char.currentOwnerJid = userJid;
                        repeatCompensation = Math.floor((char.value || 0) * 0.30);
                        bankAccrued += (char.value || 0) - repeatCompensation;
                    } else {
                        newClaims.push({ char_id: char.id, owner_jid: userJid, claimed_at: Date.now() });
                    }
                    pulledThisSession.add(char.id);
                } else {
                    luck = Math.min(luck + 0.001, 0.02);
                }

                let droppedTicket = false;
                if (Math.random() < 0.02) {
                    droppedTicket = true; currentTickets++;
                    if (sock && chatId) sock.sendMessage(chatId, { text: `🎟️ *¡TICKET OBTENIDO!*\n\n@${userJid.split("@")[0]} consiguió un Ticket de Selección. 🎉\n📦 *Tickets:* ${currentTickets}`, mentions: [userJid] }).catch(() => {});
                }
                results.push({ ...(char || {}), isRepeat, repeatCompensation, jackpotBonus, droppedTicket, pity: p, luck: parseFloat(luck.toFixed(4)) });
            }

            for (const claim of newClaims) this.db.prepare("INSERT INTO claims (char_id, owner_jid, claimed_at) VALUES (?, ?, ?)").run(claim.char_id, claim.owner_jid, claim.claimed_at);
            if (bankAccrued - jackpotTotal !== 0) this.db.prepare("UPDATE bank SET balance = MAX(0, balance + ?) WHERE id = 1").run(bankAccrued - jackpotTotal);
            this.db.prepare("UPDATE users SET balance = balance - ? + ?, pity_count = ?, luck = ?, tickets = ? WHERE jid = ?").run(PULL_COST, jackpotTotal + results.reduce((a, c) => a + (c.repeatCompensation || 0), 0), p, luck, currentTickets, userJid);

            return results;
        })();
    }

    _getRandomSync(excludeSet = new Set()) {
        const conditions = ["(c.global_limit IS NULL OR c.global_limit > (SELECT COUNT(*) FROM claims WHERE char_id = c.id))"], params = [];
        if (excludeSet.size > 0) {
            conditions.push(`c.id NOT IN (${Array.from(excludeSet).map(() => "?").join(", ")})`);
            params.push(...excludeSet);
        }
        const candidates = this.db.prepare(`SELECT c.id FROM characters c WHERE ${conditions.join(" AND ")}`).all(...params);
        if (!candidates.length) return null;
        return this.db.prepare("SELECT * FROM characters WHERE id = ?").get(candidates[Math.floor(Math.random() * candidates.length)].id);
    }
}
