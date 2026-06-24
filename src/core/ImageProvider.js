export class ImageProvider {
    static #cache    = new Map();
    static #inflight = new Map();   
    static #CACHE_TTL = 300_000;

    static #BANNED_TAGS = /(sex|naked|nude|nipple|crotch|pubic|pussy|penis|vagina|genitalia|areola|cleavage_cutout|cum|bottomless|topless|undressing|loli|shota)/;

    static #isSafe(post) {
        return !this.#BANNED_TAGS.test((post.tags || "").toLowerCase());
    }

    static #pruneCache() {
        const now = Date.now();
        for (const [k, v] of this.#cache) {
            if (now - v.timestamp >= this.#CACHE_TTL) this.#cache.delete(k);
        }
    }

    
    static async #fetchPosts(query) {
        const cached = this.#cache.get(query);
        if (cached && Date.now() - cached.timestamp < this.#CACHE_TTL) return cached.data;

        // Reusar fetch en vuelo si existe
        if (this.#inflight.has(query)) return this.#inflight.get(query);

        const promise = (async () => {
            try {
                const res = await fetch(
                    `https://yande.re/post.json?tags=${encodeURIComponent(query)}&limit=100`,
                    { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "Mozilla/5.0" } }
                );
                if (!res.ok) return null;

                const posts = await res.json();
                if (!Array.isArray(posts) || !posts.length) return null;

                const filtered = posts.filter(p => this.#isSafe(p));
                this.#pruneCache();
                this.#cache.set(query, { data: filtered, timestamp: Date.now() });
                return filtered.length ? filtered : null;
            } catch {
                return null;
            } finally {
                this.#inflight.delete(query);
            }
        })();

        this.#inflight.set(query, promise);
        return promise;
    }

    
    static async #fetchBestFor(tagExpr) {
        const queries = [
            `${tagExpr} -rating:explicit`,
            `${tagExpr} rating:s`,
            `${tagExpr} rating:q`,
        ];
        for (const q of queries) {
            const data = await this.#fetchPosts(q);
            if (data?.length) return data;
        }
        return null;
    }

    static async getRandomUrl(tag) {
        try {
            if (!tag || typeof tag !== "string") return null;

            const clean = tag.trim().toLowerCase().replace(/\s+/g, "_");
            const base  = clean.includes("_(") ? clean.split("_(")[0] : null;

            // Intentar con el tag completo primero; solo si falla probar el base
            const dataFull = await this.#fetchBestFor(clean);
            if (dataFull?.length) {
                const post = dataFull[Math.floor(Math.random() * dataFull.length)];
                return post.sample_url || post.file_url || post.jpeg_url || null;
            }

            if (base) {
                const dataBase = await this.#fetchBestFor(base);
                if (dataBase?.length) {
                    const post = dataBase[Math.floor(Math.random() * dataBase.length)];
                    return post.sample_url || post.file_url || post.jpeg_url || null;
                }
            }

            return null;
        } catch {
            return null;
        }
    }
}
