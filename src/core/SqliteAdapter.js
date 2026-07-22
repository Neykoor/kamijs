import { DatabaseSync } from "node:sqlite";

export class SqliteAdapter {
    constructor(filename) {
        this.db = new DatabaseSync(filename);
    }

    exec(sql) {
        this.db.exec(sql);
        return Promise.resolve();
    }

    run(sql, params = []) {
        const stmt = this.db.prepare(sql);
        const result = stmt.run(...params);
        return Promise.resolve({
            changes: Number(result.changes),
            lastInsertRowid: result.lastInsertRowid
        });
    }

    get(sql, params = []) {
        const stmt = this.db.prepare(sql);
        return Promise.resolve(stmt.get(...params));
    }

    all(sql, params = []) {
        const stmt = this.db.prepare(sql);
        return Promise.resolve(stmt.all(...params));
    }

    close() {
        this.db.close();
        return Promise.resolve();
    }
}

export function open({ filename }) {
    return Promise.resolve(new SqliteAdapter(filename));
}
