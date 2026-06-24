import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import crypto from "crypto";
import { ImageProvider } from "./core/ImageProvider.js";
import { Logger } from "./core/Logger.js";
import { EventBus, KAMIJS_EVENTS } from "./core/EventBus.js";
import { RateLimiter } from "./core/RateLimiter.js";

const PULL_COST           = 3000;
const HIT_RATE_RW         = 0.015;
const PITY_LIMIT_RW       = 100;
const MAX_MARKET_PRICE    = 1_000_000_000;
const INACTIVE_CUTOFF_MS  = 1_209_600_000;
const TICKET_SUCCESS_RATE = 0.30;

const DEFAULT_COOLDOWNS = {
    pull10: 0,
    useTicket: 0,
    claimStarter: 0,
    listMarket: 0,
    buyFromMarket: 0,
    trade: 0,
};

export class Kamijs {
    #txQueue = Promise.resolve();
    #poolSnapshot = null;

    constructor(config = {}) {
        this.dbPath = config.dbPath || "./database/gacha.db";
        this.db = null;
        this.ticketSuccessRate = Number.isFinite(config.ticketSuccessRate) && config.ticketSuccessRate >= 0 && config.ticketSuccessRate <= 1
            ? config.ticketSuccessRate
            : null;

        this.logger = new Logger({
            level: config.logLevel || "info",
            sink: config.logSink,
            scope: "kamijs",
        });
        this.events = new EventBus();
        this.rateLimiter = new RateLimiter({ ...DEFAULT_COOLDOWNS, ...(config.cooldowns || {}) });
    }

    on(event, handler) { return this.events.on(event, handler); }
    once(event, handler) { return this.events.once(event, handler); }
    off(event, handler) { return this.events.off(event, handler); }

    #requireJid(value, label = "jid") {
        if (!value || typeof value !== "string") {
            const err = new Error(`INVALID_${label.toUpperCase()}`);
            this.logger.warn("Validación de JID falló", { label });
            throw err;
        }
    }

    #checkCooldown(action, jid) {
        const { allowed, remainingMs } = this.rateLimiter.check(action, jid);
        if (!allowed) {
            const err = new Error("COOLDOWN_ACTIVE");
            err.remainingMs = remainingMs;
            err.action = action;
            throw err;
        }
    }

    #hitCooldown(action, jid) {
        this.rateLimiter.hit(action, jid);
    }

    #emitError(context, error) {
        this.logger.error(`Fallo en ${context}`, { error: error.message });
        this.events.emit(KAMIJS_EVENTS.ERROR, { context, error });
    }

    async #transaction(fn) {
        const run = async () => {
            await this.db.run("BEGIN IMMEDIATE");
            try {
                const result = await fn();
                await this.db.run("COMMIT");
                return result;
            } catch (e) {
                try {
                    await this.db.run("ROLLBACK");
                } catch (rollbackErr) {
                    this.logger.error("Fallo al hacer ROLLBACK", { error: rollbackErr.message });
                }
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
        // first_owner usa una subquery derivada en lugar de una correlated subquery
        // por personaje — un solo scan de claims en vez de N scans.
        this.#poolSnapshot = await this.db.all(`
            SELECT c.*,
                   COALESCE(cl_agg.total_claims, 0) AS total_claims,
                   cl_first.owner_jid               AS other_owner
            FROM characters c
            LEFT JOIN (
                SELECT char_id, COUNT(*) AS total_claims
                FROM claims
                GROUP BY char_id
            ) cl_agg ON cl_agg.char_id = c.id
            LEFT JOIN (
                SELECT char_id, owner_jid
                FROM claims
                WHERE (char_id, claimed_at) IN (
                    SELECT char_id, MIN(claimed_at) FROM claims GROUP BY char_id
                )
            ) cl_first ON cl_first.char_id = c.id
        `);
        return this.#poolSnapshot;
    }

    async #findCharacter(charId) {
        return (
            await this.db.get("SELECT * FROM characters WHERE id = ?", [charId]) ??
            await this.db.get("SELECT * FROM characters WHERE LOWER(name) = LOWER(?)", [charId])
        );
    }

    async init() {
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        this.db = await open({ filename: this.dbPath, driver: sqlite3.Database });
        await this.db.exec(`
            PRAGMA busy_timeout   = 5000;
            PRAGMA journal_mode   = WAL;
            PRAGMA synchronous    = NORMAL;
            PRAGMA cache_size     = -16000;
            PRAGMA mmap_size      = 134217728;
            PRAGMA temp_store     = MEMORY;
            PRAGMA wal_autocheckpoint = 1000;
            CREATE TABLE IF NOT EXISTS characters (id TEXT PRIMARY KEY, name TEXT NOT NULL, series TEXT NOT NULL, gender TEXT, booru_tag TEXT, value INTEGER DEFAULT 3000, global_limit INTEGER DEFAULT 1);
            CREATE TABLE IF NOT EXISTS users (jid TEXT PRIMARY KEY, balance INTEGER DEFAULT 0, pity_count INTEGER DEFAULT 0, luck REAL DEFAULT 0, last_active INTEGER DEFAULT 0, has_starter INTEGER DEFAULT 0, tickets INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS claims (id INTEGER PRIMARY KEY AUTOINCREMENT, char_id TEXT, owner_jid TEXT, claimed_at INTEGER, UNIQUE(char_id, owner_jid));
            CREATE TABLE IF NOT EXISTS bank (id INTEGER PRIMARY KEY CHECK (id = 1), balance INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS market (id INTEGER PRIMARY KEY AUTOINCREMENT, seller_jid TEXT, char_id TEXT, price INTEGER, listed_at INTEGER);
            CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY);
            INSERT OR IGNORE INTO bank (id, balance) VALUES (1, 0);
            CREATE INDEX IF NOT EXISTS idx_claims_owner        ON claims(owner_jid);
            CREATE INDEX IF NOT EXISTS idx_claims_char         ON claims(char_id);
            CREATE INDEX IF NOT EXISTS idx_claims_owner_char   ON claims(owner_jid, char_id);
            CREATE INDEX IF NOT EXISTS idx_market_seller       ON market(seller_jid);
            CREATE INDEX IF NOT EXISTS idx_market_char_seller  ON market(char_id, seller_jid);
            CREATE INDEX IF NOT EXISTS idx_market_listed       ON market(listed_at DESC);
            CREATE INDEX IF NOT EXISTS idx_chars_series        ON characters(series COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS idx_chars_name          ON characters(name COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS idx_users_active        ON users(last_active);
            CREATE INDEX IF NOT EXISTS idx_claims_char_at      ON claims(char_id, claimed_at);
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
            await this.db.run("UPDATE characters SET global_limit = 1 WHERE global_limit IS NULL");
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

        this.logger.info("Base de datos inicializada", { dbPath: this.dbPath });
    }

    async close() {
        if (this.db) {
            await this.db.close();
            this.db = null;
            this.logger.info("Conexión a la base de datos cerrada");
        }
    }

    async updatePresence(sock, jid) {
        if (!jid || typeof jid !== "string") return;
        const now = Date.now();
        await this.db.run(
            "INSERT INTO users (jid, balance, last_active) VALUES (?, 0, ?) ON CONFLICT(jid) DO UPDATE SET last_active = ?",
            [jid, now, now]
        );
    }

    async cleanInactiveUsers() {
        const cutoff = Date.now() - INACTIVE_CUTOFF_MS;
        const result = await this.#transaction(async () => {
            const { total } = await this.db.get(
                "SELECT COALESCE(SUM(balance), 0) as total FROM users WHERE last_active > 0 AND last_active < ?",
                [cutoff]
            );
            if (total > 0) {
                await this.db.run("UPDATE bank SET balance = balance + ? WHERE id = 1", [total]);
            }
            // Un solo CTE evalúa la lista de JIDs inactivos una sola vez
            // y la comparten los tres DELETE.
            await this.db.exec(`
                WITH inactive AS (
                    SELECT jid FROM users WHERE last_active > 0 AND last_active < ${cutoff}
                )
                DELETE FROM market WHERE seller_jid IN (SELECT jid FROM inactive);
            `);
            await this.db.exec(`
                WITH inactive AS (
                    SELECT jid FROM users WHERE last_active > 0 AND last_active < ${cutoff}
                )
                DELETE FROM claims WHERE owner_jid IN (SELECT jid FROM inactive);
            `);
            const { changes } = await this.db.run(
                "DELETE FROM users WHERE last_active > 0 AND last_active < ?", [cutoff]
            );
            this.#invalidatePool();
            return { removedUsers: changes, returnedToBank: total };
        });
        this.logger.info("Limpieza de usuarios inactivos completada", result);
        this.events.emit(KAMIJS_EVENTS.USERS_CLEANED, result);
        return result;
    }

    async getUser(jid, sock) {
        this.#requireJid(jid);
        await this.updatePresence(sock, jid);
        return await this.db.get("SELECT * FROM users WHERE jid = ?", [jid]);
    }

    async claimStarter(jid, charId, sock) {
        this.#requireJid(jid);
        this.#checkCooldown("claimStarter", jid);
        await this.updatePresence(sock, jid);

        try {
            const char = await this.#transaction(async () => {
                if ((await this.db.get("SELECT has_starter FROM users WHERE jid = ?", [jid]))?.has_starter)
                    throw new Error("ALREADY_CLAIMED_STARTER");

                const char = await this.#findCharacter(charId);
                if (!char) throw new Error("CHARACTER_NOT_FOUND");

                const { count } = await this.db.get("SELECT COUNT(*) as count FROM claims WHERE char_id = ?", [char.id]);
                if (char.global_limit && count >= char.global_limit) throw new Error("OUT_OF_STOCK");

                await this.db.run("INSERT INTO claims (char_id, owner_jid, claimed_at) VALUES (?, ?, ?)", [char.id, jid, Date.now()]);
                await this.db.run("UPDATE users SET has_starter = 1 WHERE jid = ?", [jid]);
                this.#invalidatePool();
                return char;
            });
            this.#hitCooldown("claimStarter", jid);
            this.events.emit(KAMIJS_EVENTS.STARTER_CLAIMED, { jid, character: char });
            return char;
        } catch (e) {
            this.#emitError("claimStarter", e);
            throw e;
        }
    }

    async useTicket(jid, charId, sock) {
        this.#requireJid(jid);
        this.#checkCooldown("useTicket", jid);
        await this.updatePresence(sock, jid);

        try {
            const { char, isSuccess } = await this.#transaction(async () => {
                const user = await this.db.get("SELECT tickets FROM users WHERE jid = ?", [jid]);
                if (!user)             throw new Error("USER_NOT_FOUND");
                if (user.tickets <= 0) throw new Error("NO_TICKETS");

                const char = await this.#findCharacter(charId);
                if (!char) throw new Error("CHARACTER_NOT_FOUND");

                const { count } = await this.db.get("SELECT COUNT(*) as count FROM claims WHERE char_id = ?", [char.id]);
                if (char.global_limit && count >= char.global_limit) throw new Error("OUT_OF_STOCK");

                if (await this.db.get("SELECT 1 FROM claims WHERE char_id = ? AND owner_jid = ?", [char.id, jid]))
                    throw new Error("ALREADY_OWNS");

                const isSuccess = Math.random() < (this.ticketSuccessRate ?? TICKET_SUCCESS_RATE);
                await this.db.run("UPDATE users SET tickets = tickets - 1 WHERE jid = ?", [jid]);
                if (isSuccess) {
                    await this.db.run("INSERT INTO claims (char_id, owner_jid, claimed_at) VALUES (?, ?, ?)", [char.id, jid, Date.now()]);
                    this.#invalidatePool();
                }
                return { char, isSuccess };
            });

            this.#hitCooldown("useTicket", jid);

            if (!isSuccess) {
                this.events.emit(KAMIJS_EVENTS.TICKET_FAILED, { jid, character: char });
                throw new Error("TICKET_FAILED");
            }
            this.events.emit(KAMIJS_EVENTS.TICKET_USED, { jid, character: char });
            return char;
        } catch (e) {
            if (e.message !== "TICKET_FAILED") this.#emitError("useTicket", e);
            throw e;
        }
    }

    async addTickets(jid, amount, sock) {
        this.#requireJid(jid);
        if (!Number.isInteger(amount) || amount < 1) throw new Error("INVALID_AMOUNT");
        await this.updatePresence(sock, jid);
        const now = Date.now();
        await this.db.run(
            "INSERT INTO users (jid, tickets, last_active) VALUES (?, ?, ?) ON CONFLICT(jid) DO UPDATE SET tickets = tickets + ?, last_active = CASE WHEN last_active = 0 THEN ? ELSE last_active END",
            [jid, amount, now, amount, now]
        );
    }

    async pull10(jid, options = {}) {
        this.#requireJid(jid);
        this.#checkCooldown("pull10", jid);
        const { sock, chatId, eventConfig } = options;
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

        let results, finalTickets;
        try {
            ({ results, finalTickets } = await this.#transaction(async () => {
                const user = await this.db.get("SELECT * FROM users WHERE jid = ?", [jid]);
                if (!user || user.balance < pullCost) throw new Error("INSUFFICIENT_FUNDS");

                const results = [];
                let p = user.pity_count, luck = user.luck ?? 0, currentTickets = user.tickets ?? 0;
                let jackpotTotal = 0, compensationTotal = 0;
                const newClaims = [];
                let currentBank = (await this.db.get("SELECT balance FROM bank WHERE id = 1"))?.balance ?? 0;
                const claimTimestamp = Date.now();

                // Paralelizar: snapshot del pool y claims del usuario a la vez
                const [poolSnapshot, ownedRows] = await Promise.all([
                    this.#getPoolSnapshot(),
                    this.db.all("SELECT char_id FROM claims WHERE owner_jid = ?", [jid]),
                ]);
                const myOwnedIds = new Set(ownedRows.map(r => r.char_id));

                const allCandidates = poolSnapshot.map(c => {
                    if (myOwnedIds.has(c.id)) {
                        return { ...c, isRepeat: true, isClaimedByOther: false, owner_jid: jid };
                    } else if (c.global_limit !== null && c.total_claims >= c.global_limit) {
                        return { ...c, isRepeat: true, isClaimedByOther: true, owner_jid: c.other_owner };
                    } else {
                        return { ...c, isRepeat: false, isClaimedByOther: false };
                    }
                });

                if (allCandidates.length === 0) throw new Error("EMPTY_POOL");

                // Copia mutable para swap-and-pop O(1): evita filter O(n) en cada hit.
                const available = allCandidates.slice();
                // Map de id → índice para encontrar y sacar en O(1)
                const availableIdx = new Map(available.map((c, i) => [c.id, i]));

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
                        if (!available.length) throw new Error("EMPTY_POOL");

                        const pickIdx = Math.floor(Math.random() * available.length);
                        char = available[pickIdx];

                        if (!char.isRepeat) {
                            luck = 0; p = 0;
                            if (Math.random() < 0.01 && currentBank > 0) {
                                jackpotBonus  = Math.min(Math.floor(currentBank * 0.05), 20_000);
                                currentBank  -= jackpotBonus;
                                jackpotTotal += jackpotBonus;
                            }
                            newClaims.push({ char_id: char.id, owner_jid: jid, claimed_at: claimTimestamp });
                        } else {
                            compensationTotal += char.value ?? 3000;
                        }

                        // Swap-and-pop: mueve el último elemento al hueco y trunca.
                        const lastIdx = available.length - 1;
                        if (pickIdx !== lastIdx) {
                            const last = available[lastIdx];
                            available[pickIdx] = last;
                            availableIdx.set(last.id, pickIdx);
                        }
                        available.pop();
                        availableIdx.delete(char.id);

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
                    [pullCost, jackpotTotal, compensationTotal, p, luck, currentTickets, jid]
                );

                return { results, finalTickets: currentTickets };
            }));
        } catch (e) {
            this.#emitError("pull10", e);
            throw e;
        }

        this.#hitCooldown("pull10", jid);

        // Deduplicar tags: si varios chars del pull tienen el mismo booru_tag,
        // se hace una sola llamada a ImageProvider y se reutiliza el resultado.
        const tagPromises = new Map();
        for (const r of results) {
            const tag = r.char?.booru_tag;
            if (tag && !tagPromises.has(tag)) {
                tagPromises.set(tag,
                    ImageProvider.getRandomUrl(tag).catch(err => {
                        this.logger.warn("Fallo al obtener imagen para personaje", { tag, error: err.message });
                        return null;
                    })
                );
            }
        }
        const tagUrls = new Map(
            await Promise.all([...tagPromises.entries()].map(async ([tag, p]) => [tag, await p]))
        );
        for (const r of results) {
            r.imageUrl = r.char?.booru_tag ? (tagUrls.get(r.char.booru_tag) ?? null) : null;
        }

        if (sock && chatId) {
            const ticketsDropped = results.filter(r => r.droppedTicket).length;
            if (ticketsDropped > 0) {
                sock.sendMessage(chatId, {
                    text: `🎟️ *¡TICKET${ticketsDropped > 1 ? "S" : ""} OBTENIDO${ticketsDropped > 1 ? "S" : ""}!*\n\n@${jid.split("@")[0]} consiguió ${ticketsDropped} Ticket${ticketsDropped > 1 ? "s" : ""} de Selección. 🎉\n📦 *Tickets:* ${finalTickets}`,
                    mentions: [jid]
                }).catch(err => this.logger.warn("Fallo al enviar mensaje de tickets", { error: err.message }));
            }
        }

        this.events.emit(KAMIJS_EVENTS.PULL, { jid, results, finalTickets });
        return results;
    }

    async getMarket(limit = 20, offset = 0) {
        limit  = Math.max(1, Math.min(100, Math.floor(Number(limit)  || 20)));
        offset = Math.max(0,              Math.floor(Number(offset)  ||  0));
        const [items, { total }] = await Promise.all([
            this.db.all(`
                SELECT m.id, m.seller_jid, m.char_id, m.price, m.listed_at,
                       c.name, c.series, c.gender, c.value
                FROM market m
                JOIN characters c ON m.char_id = c.id
                ORDER BY m.listed_at DESC
                LIMIT ? OFFSET ?
            `, [limit, offset]),
            this.db.get("SELECT COUNT(*) as total FROM market"),
        ]);
        return { items, total, limit, offset, hasMore: offset + items.length < total };
    }

    async listMarket(jid, charId, price, sock) {
        this.#requireJid(jid);
        this.#checkCooldown("listMarket", jid);
        if (!Number.isInteger(price) || price < 1 || price > MAX_MARKET_PRICE) throw new Error("INVALID_PRICE");
        await this.updatePresence(sock, jid);
        try {
            await this.#transaction(async () => {
                if (!await this.db.get("SELECT 1 FROM claims WHERE char_id = ? AND owner_jid = ?", [charId, jid]))
                    throw new Error("CHARACTER_NOT_OWNED");
                if (await this.db.get("SELECT 1 FROM market WHERE char_id = ? AND seller_jid = ?", [charId, jid]))
                    throw new Error("ALREADY_LISTED");
                await this.db.run(
                    "INSERT INTO market (seller_jid, char_id, price, listed_at) VALUES (?, ?, ?, ?)",
                    [jid, charId, price, Date.now()]
                );
            });
            this.#hitCooldown("listMarket", jid);
            this.events.emit(KAMIJS_EVENTS.MARKET_LISTED, { jid, charId, price });
        } catch (e) {
            this.#emitError("listMarket", e);
            throw e;
        }
    }

    async delistMarket(jid, marketId, sock) {
        this.#requireJid(jid);
        await this.updatePresence(sock, jid);
        const result = await this.db.run("DELETE FROM market WHERE id = ? AND seller_jid = ?", [marketId, jid]);
        if (result.changes === 0) {
            const err = new Error("LISTING_NOT_FOUND");
            this.#emitError("delistMarket", err);
            throw err;
        }
        this.events.emit(KAMIJS_EVENTS.MARKET_DELISTED, { jid, marketId });
    }

    async buyFromMarket(jid, marketId, sock) {
        this.#requireJid(jid);
        this.#checkCooldown("buyFromMarket", jid);
        await this.updatePresence(sock, jid);
        try {
            const result = await this.#transaction(async () => {
                const listing = await this.db.get("SELECT * FROM market WHERE id = ?", [marketId]);
                if (!listing) throw new Error("LISTING_NOT_FOUND");
                if (listing.seller_jid === jid) throw new Error("CANNOT_BUY_OWN");

                const user = await this.db.get("SELECT balance FROM users WHERE jid = ?", [jid]);
                if (!user) throw new Error("USER_NOT_FOUND");
                if (user.balance < listing.price) throw new Error("INSUFFICIENT_FUNDS");

                if (!await this.db.get("SELECT 1 FROM claims WHERE char_id = ? AND owner_jid = ?", [listing.char_id, listing.seller_jid])) {
                    await this.db.run("DELETE FROM market WHERE id = ?", [marketId]);
                    throw new Error("SELLER_NO_LONGER_OWNS");
                }
                if (await this.db.get("SELECT 1 FROM claims WHERE char_id = ? AND owner_jid = ?", [listing.char_id, jid]))
                    throw new Error("ALREADY_OWNS");

                const tax = Math.floor(listing.price * 0.05);
                await this.db.run("UPDATE users SET balance = balance - ? WHERE jid = ?",                [listing.price, jid]);
                await this.db.run("UPDATE users SET balance = balance + ? WHERE jid = ?",                [listing.price - tax, listing.seller_jid]);
                await this.db.run("UPDATE bank SET balance = balance + ? WHERE id = 1",                  [tax]);
                await this.db.run("UPDATE claims SET owner_jid = ? WHERE char_id = ? AND owner_jid = ?", [jid, listing.char_id, listing.seller_jid]);
                await this.db.run("DELETE FROM market WHERE id = ?",                                      [marketId]);
                this.#invalidatePool();
                return { charId: listing.char_id, price: listing.price, sellerJid: listing.seller_jid, tax };
            });
            this.#hitCooldown("buyFromMarket", jid);
            this.events.emit(KAMIJS_EVENTS.MARKET_BOUGHT, { jid, ...result });
            return result;
        } catch (e) {
            this.#emitError("buyFromMarket", e);
            throw e;
        }
    }

    async trade(fromJid, toJid, charId, sock) {
        this.#requireJid(fromJid, "fromJid");
        this.#requireJid(toJid, "toJid");
        this.#checkCooldown("trade", fromJid);
        await this.updatePresence(sock, fromJid);
        await this.updatePresence(sock, toJid);
        try {
            await this.#transaction(async () => {
                if (fromJid === toJid) throw new Error("SELF_TRADE");
                if (await this.db.get("SELECT 1 FROM claims WHERE char_id = ? AND owner_jid = ?", [charId, toJid]))
                    throw new Error("RECEIVER_ALREADY_OWNS");
                if ((await this.db.run("UPDATE claims SET owner_jid = ? WHERE char_id = ? AND owner_jid = ?", [toJid, charId, fromJid])).changes === 0)
                    throw new Error("CHARACTER_NOT_OWNED");
                await this.db.run("DELETE FROM market WHERE char_id = ? AND seller_jid = ?", [charId, fromJid]);
                this.#invalidatePool();
            });
            this.#hitCooldown("trade", fromJid);
            this.events.emit(KAMIJS_EVENTS.TRADE, { fromJid, toJid, charId });
        } catch (e) {
            this.#emitError("trade", e);
            throw e;
        }
    }

    async releaseCharacter(jid, charId, sock) {
        this.#requireJid(jid);
        await this.updatePresence(sock, jid);
        const result = await this.#transaction(async () => {
            const result = await this.db.run("DELETE FROM claims WHERE char_id = ? AND owner_jid = ?", [charId, jid]);
            if (result.changes === 0) throw new Error("CHARACTER_NOT_OWNED");
            await this.db.run("DELETE FROM market WHERE char_id = ? AND seller_jid = ?", [charId, jid]);
            this.#invalidatePool();
            return result;
        });
        this.events.emit(KAMIJS_EVENTS.CHARACTER_RELEASED, { jid, charId });
        return result;
    }

    async getHarem(jid, sock) {
        this.#requireJid(jid);
        await this.updatePresence(sock, jid);
        return await this.db.all(
            "SELECT c.id, c.name, c.series, c.gender, c.value, cl.claimed_at FROM claims cl JOIN characters c ON cl.char_id = c.id WHERE cl.owner_jid = ? ORDER BY cl.claimed_at DESC",
            [jid]
        );
    }

    async deposit(jid, amount, sock) {
        this.#requireJid(jid);
        if (!Number.isInteger(amount) || amount < 1) throw new Error("INVALID_AMOUNT");
        await this.updatePresence(sock, jid);
        const now = Date.now();
        await this.db.run(
            "INSERT INTO users (jid, balance, last_active) VALUES (?, ?, ?) ON CONFLICT(jid) DO UPDATE SET balance = balance + ?, last_active = CASE WHEN last_active = 0 THEN ? ELSE last_active END",
            [jid, amount, now, amount, now]
        );
        this.events.emit(KAMIJS_EVENTS.DEPOSIT, { jid, amount });
    }

    async getBank() {
        return (await this.db.get("SELECT balance FROM bank WHERE id = 1"))?.balance ?? 0;
    }

    async withdrawBank(toJid, amount, sock) {
        this.#requireJid(toJid, "toJid");
        if (!Number.isInteger(amount) || amount < 1) throw new Error("INVALID_AMOUNT");
        await this.updatePresence(sock, toJid);
        return this.#transaction(async () => {
            const bank = await this.db.get("SELECT balance FROM bank WHERE id = 1");
            if (!bank || bank.balance < amount) throw new Error("BANK_INSUFFICIENT_FUNDS");
            await this.db.run("UPDATE bank SET balance = balance - ? WHERE id = 1", [amount]);
            const now = Date.now();
            await this.db.run(
                "INSERT INTO users (jid, balance, last_active) VALUES (?, ?, ?) ON CONFLICT(jid) DO UPDATE SET balance = balance + ?, last_active = CASE WHEN last_active = 0 THEN ? ELSE last_active END",
                [toJid, amount, now, amount, now]
            );
        });
    }

    async addCharacter(data) {
        if (!data.name || !data.series) throw new Error("MISSING_REQUIRED_FIELDS");
        if (await this.db.get(
            "SELECT 1 FROM characters WHERE LOWER(name) = LOWER(?) AND LOWER(series) = LOWER(?)",
            [data.name, data.series]
        )) throw new Error("DUPLICATE_CHARACTER");

        const charId = data.id || crypto.randomBytes(4).toString("hex");
        try {
            await this.db.run(
                "INSERT INTO characters (id, name, series, gender, booru_tag, value, global_limit) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [charId, data.name, data.series, data.gender ?? null, data.booru_tag ?? null, data.value || 3000, data.global_limit ?? 1]
            );
        } catch (e) {
            if (String(e.message).includes("UNIQUE constraint")) throw new Error("DUPLICATE_ID");
            throw e;
        }
        this.#invalidatePool();
        this.events.emit(KAMIJS_EVENTS.CHARACTER_ADDED, { charId, data });
        return charId;
    }

    async updateCharacter(charId, changes = {}) {
        if (!charId) throw new Error("MISSING_CHARACTER_ID");
        const existing = await this.db.get("SELECT * FROM characters WHERE id = ?", [charId]);
        if (!existing) throw new Error("CHARACTER_NOT_FOUND");

        const allowedFields = ["name", "series", "gender", "booru_tag", "value", "global_limit"];
        const fields = Object.keys(changes).filter(k => allowedFields.includes(k) && changes[k] !== undefined);
        if (fields.length === 0) throw new Error("NO_VALID_FIELDS");

        if (
            (fields.includes("name") || fields.includes("series")) &&
            await this.db.get(
                "SELECT 1 FROM characters WHERE LOWER(name) = LOWER(?) AND LOWER(series) = LOWER(?) AND id != ?",
                [changes.name ?? existing.name, changes.series ?? existing.series, charId]
            )
        ) throw new Error("DUPLICATE_CHARACTER");

        const setClause = fields.map(f => `${f} = ?`).join(", ");
        const values = fields.map(f => changes[f]);
        await this.db.run(`UPDATE characters SET ${setClause} WHERE id = ?`, [...values, charId]);

        this.#invalidatePool();
        const updated = await this.db.get("SELECT * FROM characters WHERE id = ?", [charId]);
        this.events.emit(KAMIJS_EVENTS.CHARACTER_UPDATED, { charId, changes, character: updated });
        return updated;
    }

    async removeCharacter(charId, options = {}) {
        if (!charId) throw new Error("MISSING_CHARACTER_ID");
        const existing = await this.db.get("SELECT * FROM characters WHERE id = ?", [charId]);
        if (!existing) throw new Error("CHARACTER_NOT_FOUND");

        const { count } = await this.db.get("SELECT COUNT(*) as count FROM claims WHERE char_id = ?", [charId]);
        if (count > 0 && !options.force) {
            const err = new Error("CHARACTER_HAS_OWNERS");
            err.ownersCount = count;
            throw err;
        }

        const removed = await this.#transaction(async () => {
            await this.db.run("DELETE FROM market WHERE char_id = ?", [charId]);
            await this.db.run("DELETE FROM claims WHERE char_id = ?", [charId]);
            await this.db.run("DELETE FROM characters WHERE id = ?", [charId]);
            this.#invalidatePool();
            return existing;
        });

        this.events.emit(KAMIJS_EVENTS.CHARACTER_REMOVED, { charId, character: removed });
        return removed;
    }

    async getCharacter(id) {
        return await this.db.get("SELECT * FROM characters WHERE id = ?", [id]);
    }

    async getRandomCharacterBySeries(series) {
        if (!series) return null;
        return await this.db.get(
            "SELECT * FROM characters WHERE LOWER(series) = LOWER(?) ORDER BY RANDOM() LIMIT 1",
            [series]
        ) ?? null;
    }

    async getSeriesCharacters(series) {
        return await this.db.all(`
            SELECT c.id, c.name, c.gender, c.series, c.global_limit,
                   GROUP_CONCAT(REPLACE(cl.owner_jid, '@s.whatsapp.net', '')) as global_owners,
                   COUNT(cl.owner_jid) as total_claims
            FROM characters c
            LEFT JOIN claims cl ON cl.char_id = c.id
            WHERE LOWER(c.series) = LOWER(?)
            GROUP BY c.id
            ORDER BY c.name ASC
        `, [series]);
    }

    async searchCharacters(query, options = {}) {
        const limit  = Math.max(1, Math.min(100, Math.floor(Number(options.limit)  || 20)));
        const offset = Math.max(0,              Math.floor(Number(options.offset) ||  0));
        const term = `%${String(query ?? "").trim()}%`;

        const [items, { total }] = await Promise.all([
            this.db.all(`
                SELECT * FROM characters
                WHERE name LIKE ? COLLATE NOCASE OR series LIKE ? COLLATE NOCASE
                ORDER BY name ASC
                LIMIT ? OFFSET ?
            `, [term, term, limit, offset]),
            this.db.get(`
                SELECT COUNT(*) as total FROM characters
                WHERE name LIKE ? COLLATE NOCASE OR series LIKE ? COLLATE NOCASE
            `, [term, term]),
        ]);

        return { items, total, limit, offset, hasMore: offset + items.length < total };
    }

    async listCharacters(options = {}) {
        const limit  = Math.max(1, Math.min(100, Math.floor(Number(options.limit)  || 20)));
        const offset = Math.max(0,              Math.floor(Number(options.offset) ||  0));

        const [items, { total }] = await Promise.all([
            this.db.all(
                "SELECT * FROM characters ORDER BY name ASC LIMIT ? OFFSET ?",
                [limit, offset]
            ),
            this.db.get("SELECT COUNT(*) as total FROM characters"),
        ]);

        return { items, total, limit, offset, hasMore: offset + items.length < total };
    }

    async getGenverProgress(series) {
        if (!series) return null;
        return await this.db.get(
            "SELECT series, done, added FROM genver_progress WHERE LOWER(series) = LOWER(?)",
            [series]
        ) ?? null;
    }

    async setGenverProgress(series, done, added) {
        if (!series) throw new Error("MISSING_SERIES");
        if (!Number.isInteger(done) || done < 0) throw new Error("INVALID_DONE");
        if (!Number.isInteger(added) || added < 0) throw new Error("INVALID_ADDED");
        await this.db.run(
            "INSERT INTO genver_progress (series, done, added) VALUES (?, ?, ?) ON CONFLICT(series) DO UPDATE SET done = ?, added = ?",
            [series, done, added, done, added]
        );
    }

    async resetGenverProgress(series) {
        if (!series) throw new Error("MISSING_SERIES");
        await this.db.run(
            "DELETE FROM genver_progress WHERE LOWER(series) = LOWER(?)",
            [series]
        );
    }
}
