export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    scope: string;
    message: string;
    meta?: Record<string, unknown>;
}

export interface LoggerOptions {
    level?: LogLevel;
    sink?: (entry: LogEntry) => void;
    scope?: string;
}

export declare class Logger {
    constructor(options?: LoggerOptions);
    child(scope: string): Logger;
    setLevel(level: LogLevel): void;
    debug(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
}

export declare const LOG_LEVELS: Record<LogLevel, number>;

export type KamijsEventName =
    | "pull"
    | "starterClaimed"
    | "ticketUsed"
    | "ticketFailed"
    | "deposit"
    | "marketListed"
    | "marketDelisted"
    | "marketBought"
    | "trade"
    | "characterReleased"
    | "characterAdded"
    | "characterUpdated"
    | "characterRemoved"
    | "usersCleaned"
    | "error";

export declare const KAMIJS_EVENTS: Readonly<Record<string, KamijsEventName>>;

export type EventHandler<T = any> = (payload: T) => void | Promise<void>;

export declare class EventBus {
    on<T = any>(event: string, handler: EventHandler<T>): () => void;
    once<T = any>(event: string, handler: EventHandler<T>): () => void;
    off(event: string, handler: EventHandler): void;
    removeAllListeners(event?: string): void;
    emit<T = any>(event: string, payload?: T): void;
}

export interface RateLimiterOptions {
    sweepEveryMs?: number;
}

export interface CooldownCheckResult {
    allowed: boolean;
    remainingMs: number;
}

export declare class RateLimiter {
    constructor(cooldowns?: Record<string, number>, options?: RateLimiterOptions);
    setCooldown(action: string, ms: number): void;
    getCooldown(action: string): number;
    check(action: string, jid: string): CooldownCheckResult;
    hit(action: string, jid: string): void;
    reset(action: string, jid: string): void;
    clear(): void;
}

export interface Character {
    id: string;
    name: string;
    series: string;
    gender?: string | null;
    booru_tag?: string | null;
    value: number;
    global_limit: number | null;
}

export interface CharacterCandidate extends Character {
    total_claims: number;
    other_owner?: string | null;
    isRepeat: boolean;
    isClaimedByOther: boolean;
    owner_jid?: string | null;
}

export interface User {
    jid: string;
    balance: number;
    pity_count: number;
    luck: number;
    last_active: number;
    has_starter: number;
    tickets: number;
}

export interface MarketListing {
    id: number;
    seller_jid: string;
    char_id: string;
    price: number;
    listed_at: number;
    name: string;
    series: string;
    gender?: string | null;
    value: number;
}

export interface HaremEntry {
    id: string;
    name: string;
    series: string;
    gender?: string | null;
    value: number;
    claimed_at: number;
}

export interface PaginatedResult<T> {
    items: T[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
}

export interface PullEventConfig {
    cost?: number;
    rateMultiplier?: number;
    guaranteedMin?: number;
}

export interface PullOptions {
    sock?: unknown;
    chatId?: string;
    eventConfig?: PullEventConfig;
}

export interface PullResultEntry {
    char: CharacterCandidate | null;
    jackpotBonus: number;
    droppedTicket: boolean;
    pity: number;
    luck: number;
    imageUrl?: string | null;
}

export interface AddCharacterInput {
    id?: string;
    name: string;
    series: string;
    gender?: string;
    booru_tag?: string;
    value?: number;
    global_limit?: number | null;
}

export interface UpdateCharacterChanges {
    name?: string;
    series?: string;
    gender?: string;
    booru_tag?: string;
    value?: number;
    global_limit?: number | null;
}

export interface RemoveCharacterOptions {
    force?: boolean;
}

export interface CleanInactiveUsersResult {
    removedUsers: number;
    returnedToBank: number;
}

export interface BuyFromMarketResult {
    charId: string;
    price: number;
    sellerJid: string;
    tax: number;
}

export interface KamijsConfig {
    dbPath?: string;
    logLevel?: LogLevel;
    logSink?: (entry: LogEntry) => void;
    cooldowns?: Record<string, number>;
    /** Probabilidad de éxito al usar un ticket (0-1). Por defecto: 0.30. */
    ticketSuccessRate?: number;
}

export declare class Kamijs {
    dbPath: string;
    logger: Logger;
    events: EventBus;
    rateLimiter: RateLimiter;

    constructor(config?: KamijsConfig);

    init(): Promise<void>;
    close(): Promise<void>;

    on<T = any>(event: KamijsEventName | string, handler: EventHandler<T>): () => void;
    once<T = any>(event: KamijsEventName | string, handler: EventHandler<T>): () => void;
    off(event: KamijsEventName | string, handler: EventHandler): void;

    updatePresence(sock: unknown, jid: string): Promise<void>;
    cleanInactiveUsers(): Promise<CleanInactiveUsersResult>;
    getUser(jid: string, sock?: unknown): Promise<User | undefined>;

    claimStarter(jid: string, charId: string, sock?: unknown): Promise<Character>;
    useTicket(jid: string, charId: string, sock?: unknown): Promise<Character>;
    addTickets(jid: string, amount: number, sock?: unknown): Promise<void>;
    pull10(jid: string, options?: PullOptions): Promise<PullResultEntry[]>;

    getMarket(limit?: number, offset?: number): Promise<PaginatedResult<MarketListing>>;
    listMarket(jid: string, charId: string, price: number, sock?: unknown): Promise<void>;
    delistMarket(jid: string, marketId: number, sock?: unknown): Promise<void>;
    buyFromMarket(jid: string, marketId: number, sock?: unknown): Promise<BuyFromMarketResult>;
    trade(fromJid: string, toJid: string, charId: string, sock?: unknown): Promise<void>;
    releaseCharacter(jid: string, charId: string, sock?: unknown): Promise<{ changes: number }>;
    getHarem(jid: string, sock?: unknown): Promise<HaremEntry[]>;

    deposit(jid: string, amount: number, sock?: unknown): Promise<void>;
    getBank(): Promise<number>;
    withdrawBank(toJid: string, amount: number, sock?: unknown): Promise<void>;

    addCharacter(data: AddCharacterInput): Promise<string>;
    updateCharacter(charId: string, changes?: UpdateCharacterChanges): Promise<Character>;
    removeCharacter(charId: string, options?: RemoveCharacterOptions): Promise<Character>;
    getCharacter(id: string): Promise<Character | undefined>;
    getRandomCharacterBySeries(series: string): Promise<Character | null>;
    getSeriesCharacters(series: string): Promise<Array<Character & { global_owners: string | null; total_claims: number }>>;
    searchCharacters(query: string, options?: { limit?: number; offset?: number }): Promise<PaginatedResult<Character>>;
    listCharacters(options?: { limit?: number; offset?: number }): Promise<PaginatedResult<Character>>;

    getGenverProgress(series: string): Promise<GenverProgress | null>;
    setGenverProgress(series: string, done: number, added: number): Promise<void>;
    resetGenverProgress(series: string): Promise<void>;
}

export interface GenverProgress {
    series: string;
    done: number;
    added: number;
}

export interface ImagePost {
    id: number;
    url: string | null;
    file_url: string | null;
    sample_url: string | null;
    jpeg_url: string | null;
    tags: string;
    rating: string;
    score: number;
    author: string;
    source: string;
    width: number;
    height: number;
    gender: "female" | "male" | "mixed" | "unknown";
}

export declare class ImageProvider {
    static getRandomUrl(tag: string): Promise<string | null>;
    static getRandomPost(tag: string): Promise<ImagePost | null>;
    static clearCache(): void;
}
