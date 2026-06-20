import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import crypto from "crypto";
import { LidGuard } from "./middleware/LidGuard.js";

const PULL_COST        = 3000;
const HIT_RATE_RW      = 0.015;
const PITY_LIMIT_RW    = 100;
const MAX_MARKET_PRICE = 1_000_000_000;

export class Kamijs {
    #txQueue = Promise.resolve();
    #poolSnapshot = null;

    constructor(config = {}) {
        this.dbPath = config.dbPath || "./database/gacha.db";
        this.db = null;
    }

    async #transaction(fn) {
        const run = async () => {
            await this.db.run("BEGIN IMMEDIATE");
            try {
                const result = await fn();
                await this.db.run("COMMIT");
                return result;
            } catch (e) {
                await this.db.run("ROLLBACK").catch(() => {});
                throw e;
            }
        };
        const next = this.#txQueue.then(run, run);
        this.#txQueue = next.then(() => {}, () => {});
        return next;
    }

    #invalidatePool() {
        this.#poolSnapshot = null;
    }

    async #getPoolSnapshot() {
        if (this.#poolSnapshot) return this.#poolSnapshot;
        this.#poolSnapshot = await this.db.all(`
            SELECT c.*,
                   COUNT(cl.id) as total_claims,
                   (SELECT owner_jid FROM claims WHERE char_id = c.id LIMIT 1) as other_owner
            FROM characters c
            LEFT JOIN claims cl ON cl.char_id = c.id
            GROUP BY c.id
        `);
        return this.#poolSnapshot;
    }

    async init() {
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        this.db = await open({ filename: this.dbPath, driver: sqlite3.Database });
        await this.db.exec(`
            PRAGMA busy_timeout = 5000;
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA cache_size = -8000;
            CREATE TABLE IF NOT EXISTS characters (id TEXT PRIMARY KEY, name TEXT NOT NULL, series TEXT NOT NULL, gender TEXT, booru_tag TEXT, value INTEGER DEFAULT 3000, global_limit INTEGER DEFAULT 1);
            CREATE TABLE IF NOT EXISTS users (jid TEXT PRIMARY KEY, balance INTEGER DEFAULT 0, pity_count INTEGER DEFAULT 0, luck REAL DEFAULT 0, last_active INTEGER DEFAULT 0, has_starter INTEGER DEFAULT 0, tickets INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS claims (id INTEGER PRIMARY KEY AUTOINCREMENT, char_id TEXT, owner_jid TEXT, claimed_at INTEGER, UNIQUE(char_id, owner_jid));
            CREATE TABLE IF NOT EXISTS bank (id INTEGER PRIMARY KEY CHECK (id = 1), balance INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS market (id INTEGER PRIMARY KEY AUTOINCREMENT, seller_jid TEXT, char_id TEXT, price INTEGER, listed_at INTEGER);
            CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY);
            INSERT OR IGNORE INTO bank (id, balance) VALUES (1, 0);
            CREATE INDEX IF NOT EXISTS idx_claims_owner  ON claims(owner_jid);
            CREATE INDEX IF NOT EXISTS idx_claims_char   ON claims(char_id);
            CREATE INDEX IF NOT EXISTS idx_market_seller ON market(seller_jid);
            CREATE INDEX IF NOT EXISTS idx_market_listed ON market(listed_at DESC);
            CREATE INDEX IF NOT EXISTS idx_chars_series  ON characters(series COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS idx_users_active  ON users(last_active);
        `);

        const currentVersion = (await this.db.get("SELECT MAX(version) as v FROM migrations"))?.v ?? 0;

        if (currentVersion < 1) {
            await this.db.run("UPDATE characters SET value = 3000 WHERE value IS NULL");

            const userCols = (await this.db.all("PRAGMA table_info(users)")).map(c => c.name);
            if (!userCols.includes("luck"))        await this.db.exec("ALTER TABLE users ADD COLUMN luck REAL DEFAULT 0");
            if (!userCols.includes("last_active")) await this.db.exec("ALTER TABLE users ADD COLUMN last_active INTEGER DEFAULT 0");
            if (!userCols.includes("has_starter")) await this.db.exec("ALTER TABLE users ADD COLUMN has_starter INTEGER DEFAULT 0");
            if (!userCols.includes("tickets"))     await this.db.exec("ALTER TABLE users ADD COLUMN tickets INTEGER DEFAULT 0");

            const charCols = (await this.db.all("PRAGMA table_info(characters)")).map(c => c.name);
            if (!charCols.includes("global_limit")) {
                await this.db.exec("ALTER TABLE characters ADD COLUMN global_limit INTEGER DEFAULT 1");
                await this.db.run("UPDATE characters SET global_limit = 1 WHERE global_limit IS NULL");
            }

            if ((await this.db.all("PRAGMA table_info(claims)")).some(c => c.name === "group_id")) {
                await this.db.exec(`
                    CREATE TABLE claims_new (id INTEGER PRIMARY KEY AUTOINCREMENT, char_id TEXT, owner_jid TEXT, claimed_at INTEGER, UNIQUE(char_id, owner_jid));
                    INSERT INTO claims_new (char_id, owner_jid, claimed_at) SELECT char_id, owner_jid, MAX(claimed_at) FROM claims GROUP BY char_id, owner_jid;
                    DROP TABLE claims;
                    ALTER TABLE claims_new RENAME TO claims;
                `);
            }

            await this.db.run("INSERT OR IGNORE INTO migrations (version) VALUES (1)");
        }

        if (currentVersion < 2) {
            await this.db.run("UPDATE characters SET global_limit = 1 WHERE global_limit IS NULL OR global_limit > 1");
            await this.db.run("INSERT OR IGNORE INTO migrations (version) VALUES (2)");
        }

        if (currentVersion < 3) {
            await this.db.exec(`
                CREATE TABLE IF NOT EXISTS genver_progress (
                    series TEXT PRIMARY KEY,
                    done   INTEGER NOT NULL DEFAULT 0,
                    added  INTEGER NOT NULL DEFAULT 0
                );
            `);
            await this.db.run("INSERT OR IGNORE INTO migrations (version) VALUES (3)");
        }
    }

    async updatePresence(sock, jid) {
        if (!jid) return;
        const userJid = await LidGuard.clean(sock, jid);
        const now = Date.now();
        await this.db.run(
            "INSERT INTO users (jid, balance, last_active) VALUES (?, 0, ?) ON CONFLICT(jid) DO UPDATE SET last_active = ?",
            [userJid, now, now]
        );
    }

    async cleanInactiveUsers() {
        const cutoff = Date.now() - 1_209_600_000;
        return this.#transaction(async () => {
            await this.db.run("DELETE FROM market WHERE seller_jid IN (SELECT jid FROM users WHERE last_active > 0 AND last_active < ?)", [cutoff]);
            await this.db.run("DELETE FROM claims WHERE owner_jid  IN (SELECT jid FROM users WHERE last_active > 0 AND last_active < ?)", [cutoff]);
            await this.db.run("DELETE FROM users WHERE last_active > 0 AND last_active < ?", [cutoff]);
            this.#invalidatePool();
        });
    }

    async #findCharacter(charId) {
        return (
            await this.db.get("SELECT * FROM characters WHERE id = ?", [charId]) ??
            await this.db.get("SELECT * FROM characters WHERE LOWER(name) = LOWER(?)", [charId])
        );
    }

    async claimStarter(jid, charId, sock) {
        const userJid = await LidGuard.clean(sock, jid);
        await this.updatePresence(sock, jid);

        return this.#transaction(async () => {
            if ((await this.db.get("SELECT has_starter FROM users WHERE jid = ?", [userJid]))?.has_starter)
                throw new Error("ALREADY_CLAIMED_STARTER");

            const char = await this.#findCharacter(charId);
            if (!char) throw new Error("CHARACTER_NOT_FOUND");

            const { count } = await this.db.get("SELECT COUNT(*) as count FROM claims WHERE char_id = ?", [char.id]);
            if (char.global_limit && count >= char.global_limit) throw new Error("OUT_OF_STOCK");

            await this.db.run("INSERT INTO claims (char_id, owner_jid, claimed_at) VALUES (?, ?, ?)", [char.id, userJid, Date.now()]);
            await this.db.run("UPDATE users SET has_starter = 1 WHERE jid = ?", [userJid]);
            this.#invalidatePool();
            return char;
        });
    }

    async useTicket(jid, charId, sock) {
        const userJid = await LidGuard.clean(sock, jid);
        await this.updatePresence(sock, jid);

        const { char, isSuccess } = await this.#transaction(async () => {
            const user = await this.db.get("SELECT tickets FROM users WHERE jid = ?", [userJid]);
            if (!user)             throw new Error("USER_NOT_FOUND");
            if (user.tickets <= 0) throw new Error("NO_TICKETS");

            const char = await this.#findCharacter(charId);
            if (!char) throw new Error("CHARACTER_NOT_FOUND");

            const { count } = await this.db.get("SELECT COUNT(*) as count FROM claims WHERE char_id = ?", [char.id]);
            if (char.global_limit && count >= char.global_limit) throw new Error("OUT_OF_STOCK");

            if (await this.db.get("SELECT 1 FROM claims WHERE char_id = ? AND owner_jid = ?", [char.id, userJid]))
                throw new Error("ALREADY_OWNS");

            const isSuccess = Math.random() < 0.30;
            await this.db.run("UPDATE users SET tickets = tickets - 1 WHERE jid = ?", [userJid]);
            if (isSuccess) {
                await this.db.run("INSERT INTO claims (char_id, owner_jid, claimed_at) VALUES (?, ?, ?)", [char.id, userJid, Date.now()]);
                this.#invalidatePool();
            }
            return { char, isSuccess };
        });

        if (!isSuccess) throw new Error("TICKET_FAILED");
        return char;
    }

    async addTickets(jid, amount, sock) {
        if (!Number.isInteger(amount) || amount < 1) throw new Error("INVALID_AMOUNT");
        const userJid = await LidGuard.clean(sock, jid);
        await this.db.run(
            "INSERT INTO users (jid, tickets) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET tickets = tickets + ?",
            [userJid, amount, amount]
        );
    }

    async listMarket(jid, charId, price, sock) {
        if (!Number.isInteger(price) || price < 1 || price > MAX_MARKET_PRICE) throw new Error("INVALID_PRICE");
        const userJid = await LidGuard.clean(sock, jid);
        await this.updatePresence(sock, jid);
        return this.#transaction(async () => {
            if (!await this.db.get("SELECT 1 FROM claims WHERE char_id = ? AND owner_jid = ?", [charId, userJid]))
                throw new Error("CHARACTER_NOT_OWNED");
            if (await this.db.get("SELECT 1 FROM market WHERE char_id = ? AND seller_jid = ?", [charId, userJid]))
                throw new Error("ALREADY_LISTED");
            await this.db.run(
                "INSERT INTO market (seller_jid, char_id, price, listed_at) VALUES (?, ?, ?, ?)",
                [userJid, charId, price, Date.now()]
            );
        });
    }

    async buyFromMarket(jid, marketId, sock) {
        const userJid = await LidGuard.clean(sock, jid);
        await this.updatePresence(sock, jid);
        return this.#transaction(async () => {
            const listing = await this.db.get("SELECT * FROM market WHERE id = ?", [marketId]);
            if (!listing) throw new Error("LISTING_NOT_FOUND");
            if (listing.seller_jid === userJid) throw new Error("CANNOT_BUY_OWN");

            const user = await this.db.get("SELECT balance FROM users WHERE jid = ?", [userJid]);
            if (!user) throw new Error("USER_NOT_FOUND");
            if (user.balance < listing.price) throw new Error("INSUFFICIENT_FUNDS");

            if (!await this.db.get("SELECT 1 FROM claims WHERE char_id = ? AND owner_jid = ?", [listing.char_id, listing.seller_jid])) {
                await this.db.run("DELETE FROM market WHERE id = ?", [marketId]);
                throw new Error("SELLER_NO_LONGER_OWNS");
            }
            if (await this.db.get("SELECT 1 FROM claims WHERE char_id = ? AND owner_jid = ?", [listing.char_id, userJid]))
                throw new Error("ALREADY_OWNS");

            const tax = Math.floor(listing.price * 0.05);
            await this.db.run("UPDATE users SET balance = balance - ? WHERE jid = ?",                [listing.price, userJid]);
            await this.db.run("UPDATE users SET balance = balance + ? WHERE jid = ?",                [listing.price - tax, listing.seller_jid]);
            await this.db.run("UPDATE bank SET balance = balance + ? WHERE id = 1",                  [tax]);
            await this.db.run("UPDATE claims SET owner_jid = ? WHERE char_id = ? AND owner_jid = ?", [userJid, listing.char_id, listing.seller_jid]);
            await this.db.run("DELETE FROM market WHERE id = ?",                                      [marketId]);
            this.#invalidatePool();
        });
    }

            async addCharacter(data) {
        if (!data.name || !data.series) throw new Error("MISSING_REQUIRED_FIELDS");
        if (await this.db.get(
            "SELECT 1 FROM characters WHERE LOWER(name) = LOWER(?) AND LOWER(series) = LOWER(?)",
            [data.name, data.series]
        )) throw new Error("DUPLICATE_CHARACTER");

        const charId = data.id || crypto.randomBytes(4).toString("hex");
        await this.db.run(
            "INSERT INTO characters (id, name, series, gender, booru_tag, value, global_limit) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [charId, data.name, data.series, data.gender, data.booru_tag || data.name, data.value || 3000, data.global_limit ?? 1]
        );
        this.#invalidatePool();
        return charId;
    }

    async getRandomCharacterBySeries(series) {
        if (!series) return null;
        return await this.db.get(
            "SELECT * FROM characters WHERE LOWER(series) = LOWER(?) ORDER BY RANDOM() LIMIT 1",
            [series]
        ) ?? null;
    }

    async getCharacter(id) {
        return await this.db.get("SELECT * FROM characters WHERE id = ?", [id]);
    }

    async deposit(jid, amount, sock) {
        if (!Number.isInteger(amount) || amount < 1) throw new Error("INVALID_AMOUNT");
        const userJid = await LidGuard.clean(sock, jid);
        await this.db.run(
            "INSERT INTO users (jid, balance) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET balance = balance + ?",
            [userJid, amount, amount]
        );
    }

    async getBank() {
        return (await this.db.get("SELECT balance FROM bank WHERE id = 1"))?.balance ?? 0;
    }

    async withdrawBank(amount, toJid, sock) {
        if (!Number.isInteger(amount) || amount < 1) throw new Error("INVALID_AMOUNT");
        const userJid = await LidGuard.clean(sock, toJid);
        return this.#transaction(async () => {
            const bank = await this.db.get("SELECT balance FROM bank WHERE id = 1");
            if (!bank || bank.balance < amount) throw new Error("BANK_INSUFFICIENT_FUNDS");
            await this.db.run("UPDATE bank SET balance = balance - ? WHERE id = 1", [amount]);
            await this.db.run(
                "INSERT INTO users (jid, balance) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET balance = balance + ?",
                [userJid, amount, amount]
            );
        });
    }

    async getHarem(jid, sock) {
        const userJid = await LidGuard.clean(sock, jid);
        await this.updatePresence(sock, jid);
        return await this.db.all(
            "SELECT c.id, c.name, c.series, c.gender, c.value, cl.claimed_at FROM claims cl JOIN characters c ON cl.char_id = c.id WHERE cl.owner_jid = ? ORDER BY cl.claimed_at DESC",
            [userJid]
        );
    }

    async trade(fromJid, toJid, charId, sock) {
        const from = await LidGuard.clean(sock, fromJid);
        const to   = await LidGuard.clean(sock, toJid);
        await this.updatePresence(sock, fromJid);
        await this.updatePresence(sock, toJid);
        return this.#transaction(async () => {
            if (from === to) throw new Error("SELF_TRADE");
            if (await this.db.get("SELECT 1 FROM claims WHERE char_id = ? AND owner_jid = ?", [charId, to]))
                throw new Error("RECEIVER_ALREADY_OWNS");
            if ((await this.db.run("UPDATE claims SET owner_jid = ? WHERE char_id = ? AND owner_jid = ?", [to, charId, from])).changes === 0)
                throw new Error("CHARACTER_NOT_OWNED");
            await this.db.run("DELETE FROM market WHERE char_id = ? AND seller_jid = ?", [charId, from]);
            this.#invalidatePool();
        });
    }

    async getSeriesCharacters(series) {
        return await this.db.all(`
            SELECT c.id, c.name, c.gender, c.series, c.global_limit,
                   GROUP_CONCAT(REPLACE(REPLACE(cl.owner_jid, '@s.whatsapp.net', ''), '@lid', '')) as global_owners,
                   COUNT(cl.owner_jid) as total_claims
            FROM characters c
            LEFT JOIN claims cl ON cl.char_id = c.id
            WHERE LOWER(c.series) = LOWER(?)
            GROUP BY c.id
            ORDER BY c.name ASC
        `, [series]);
    }

    async pull10(jid, options = {}) {
        const { sock, chatId, eventConfig } = options;
        const userJid = await LidGuard.clean(sock, jid);
        await this.updatePresence(sock, jid);

        const pullCost      = Number.isInteger(eventConfig?.cost) && eventConfig.cost > 0
            ? eventConfig.cost
            : PULL_COST;
        const rateMultiplier = Number.isFinite(eventConfig?.rateMultiplier) && eventConfig.rateMultiplier > 0
            ? eventConfig.rateMultiplier
            : 1;
        const guaranteedMin  = Number.isInteger(eventConfig?.guaranteedMin)
            ? Math.max(0, Math.min(10, eventConfig.guaranteedMin))
            : 0;

        const { results, finalTickets } = await this.#transaction(async () => {
            const user = await this.db.get("SELECT * FROM users WHERE jid = ?", [userJid]);
            if (!user || user.balance < pullCost) throw new Error("INSUFFICIENT_FUNDS");

            const results = [];
            let p = user.pity_count, luck = user.luck ?? 0, currentTickets = user.tickets ?? 0;
            let jackpotTotal = 0, compensationTotal = 0;
            const pulledThisSession = new Set(), newClaims = [];
            let currentBank = (await this.db.get("SELECT balance FROM bank WHERE id = 1"))?.balance ?? 0;
            const claimTimestamp = Date.now();

            const poolSnapshot = await this.#getPoolSnapshot();
            const myOwnedIds   = new Set(
                (await this.db.all("SELECT char_id FROM claims WHERE owner_jid = ?", [userJid])).map(r => r.char_id)
            );

            const allCandidates = poolSnapshot.map(c => {
                if (myOwnedIds.has(c.id)) {
                    return { ...c, isRepeat: true, isClaimedByOther: false, owner_jid: userJid };
                } else if (c.global_limit !== null && c.total_claims >= c.global_limit) {
                    return { ...c, isRepeat: true, isClaimedByOther: true, owner_jid: c.other_owner };
                } else {
                    return { ...c, isRepeat: false, isClaimedByOther: false };
                }
            });

            if (allCandidates.length === 0) throw new Error("EMPTY_POOL");

            let hitsInSession = 0;

            for (let i = 0; i < 10; i++) {
                p++;
                let char = null, jackpotBonus = 0;

                const baseRate = (
                    p >= 80 ? 0.06 :
                    p >= 60 ? 0.04 :
                    p >= 40 ? 0.025 :
                              HIT_RATE_RW
                ) * rateMultiplier;
                const effectiveRate = Math.min(baseRate + luck, 1);

                const slotsRemaining = 10 - i;
                const hitsStillNeeded = Math.max(0, guaranteedMin - hitsInSession);
                const forcedHit = hitsStillNeeded > 0 && hitsStillNeeded >= slotsRemaining;

                if (forcedHit || p >= PITY_LIMIT_RW || Math.random() < effectiveRate) {
                    const available = allCandidates.filter(c => !pulledThisSession.has(c.id));
                    if (!available.length) throw new Error("EMPTY_POOL");

                    luck = 0; p = 0;
                    char = available[Math.floor(Math.random() * available.length)];

                    if (!char.isRepeat) {
                        if (Math.random() < 0.01 && currentBank > 0) {
                            jackpotBonus  = Math.min(Math.floor(currentBank * 0.05), 20_000);
                            currentBank  -= jackpotBonus;
                            jackpotTotal += jackpotBonus;
                        }
                        newClaims.push({ char_id: char.id, owner_jid: userJid, claimed_at: claimTimestamp });
                    } else {
                        compensationTotal += char.value ?? 3000;
                    }

                    pulledThisSession.add(char.id);
                    hitsInSession++;
                } else {
                    luck = Math.min(luck + 0.001, 0.02);
                }

                const droppedTicket = char !== null && Math.random() < 0.02;
                if (droppedTicket) currentTickets++;

                results.push({ char, jackpotBonus, droppedTicket, pity: p, luck: Math.round(luck * 10_000) / 10_000 });
            }

            if (newClaims.length > 0) {
                const placeholders = newClaims.map(() => "(?, ?, ?)").join(", ");
                const values = newClaims.flatMap(c => [c.char_id, c.owner_jid, c.claimed_at]);
                await this.db.run(`INSERT OR IGNORE INTO claims (char_id, owner_jid, claimed_at) VALUES ${placeholders}`, values);
                this.#invalidatePool();
            }
            if (jackpotTotal > 0)
                await this.db.run("UPDATE bank SET balance = MAX(0, balance - ?) WHERE id = 1", [jackpotTotal]);

            await this.db.run(
                "UPDATE users SET balance = balance - ? + ? + ?, pity_count = ?, luck = ?, tickets = ? WHERE jid = ?",
                [pullCost, jackpotTotal, compensationTotal, p, luck, currentTickets, userJid]
            );

            return { results, finalTickets: currentTickets };
        });

        if (sock && chatId) {
            const ticketsDropped = results.filter(r => r.droppedTicket).length;
            if (ticketsDropped > 0) {
                sock.sendMessage(chatId, {
                    text: `🎟️ *¡TICKET${ticketsDropped > 1 ? "S" : ""} OBTENIDO${ticketsDropped > 1 ? "S" : ""}!*\n\n@${userJid.split("@")[0]} consiguió ${ticketsDropped} Ticket${ticketsDropped > 1 ? "s" : ""} de Selección. 🎉\n📦 *Tickets:* ${finalTickets}`,
                    mentions: [userJid]
                }).catch(() => {});
            }
        }

        return results;
    }

    async getUser(jid, sock) {
        const userJid = await LidGuard.clean(sock, jid);
        return await this.db.get("SELECT * FROM users WHERE jid = ?", [userJid]);
    }

    async getMarket(limit = 20, offset = 0) {
        limit  = Math.max(1, Math.min(100, Math.floor(Number(limit)  || 20)));
        offset = Math.max(0,              Math.floor(Number(offset)  ||  0));
        return await this.db.all(`
            SELECT m.id, m.seller_jid, m.char_id, m.price, m.listed_at,
                   c.name, c.series, c.gender, c.value
            FROM market m
            JOIN characters c ON m.char_id = c.id
            ORDER BY m.listed_at DESC
            LIMIT ? OFFSET ?
        `, [limit, offset]);
    }

    async delistMarket(jid, marketId, sock) {
        const userJid = await LidGuard.clean(sock, jid);
        await this.updatePresence(sock, jid);
        const result = await this.db.run("DELETE FROM market WHERE id = ? AND seller_jid = ?", [marketId, userJid]);
        if (result.changes === 0) throw new Error("LISTING_NOT_FOUND");
    }

    async releaseCharacter(jid, charId, sock) {
        const userJid = await LidGuard.clean(sock, jid);
        await this.updatePresence(sock, jid);
        return this.#transaction(async () => {
            const result = await this.db.run("DELETE FROM claims WHERE char_id = ? AND owner_jid = ?", [charId, userJid]);
            if (result.changes === 0) throw new Error("CHARACTER_NOT_OWNED");
            await this.db.run("DELETE FROM market WHERE char_id = ? AND seller_jid = ?", [charId, userJid]);
            this.#invalidatePool();
        });
    }
}
