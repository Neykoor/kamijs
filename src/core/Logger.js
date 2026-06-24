const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export class Logger {
    #level;
    #sink;
    #scope;

    constructor(options = {}) {
        this.#level = LEVELS[options.level] !== undefined ? options.level : "info";
        this.#sink = typeof options.sink === "function" ? options.sink : null;
        this.#scope = options.scope || "kamijs";
    }

    #shouldLog(level) {
        return LEVELS[level] >= LEVELS[this.#level];
    }

    #emit(level, message, meta) {
        if (!this.#shouldLog(level)) return;

        const entry = {
            timestamp: new Date().toISOString(),
            level,
            scope: this.#scope,
            message,
            ...(meta ? { meta } : {}),
        };

        if (this.#sink) {
            try {
                this.#sink(entry);
            } catch {
                this.#fallback(entry);
            }
            return;
        }

        this.#fallback(entry);
    }

    #fallback(entry) {
        const line = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.message}`;
        if (entry.level === "error") console.error(line, entry.meta ?? "");
        else if (entry.level === "warn") console.warn(line, entry.meta ?? "");
        else console.log(line, entry.meta ?? "");
    }

    child(scope) {
        return new Logger({ level: this.#level, sink: this.#sink, scope: `${this.#scope}:${scope}` });
    }

    setLevel(level) {
        if (LEVELS[level] === undefined) throw new Error("INVALID_LOG_LEVEL");
        this.#level = level;
    }

    debug(message, meta) { this.#emit("debug", message, meta); }
    info(message, meta)  { this.#emit("info", message, meta); }
    warn(message, meta)  { this.#emit("warn", message, meta); }
    error(message, meta) { this.#emit("error", message, meta); }
}

export const LOG_LEVELS = LEVELS;
