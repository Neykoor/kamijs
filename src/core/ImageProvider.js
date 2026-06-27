export class ImageProvider {
    static #cache    = new Map();
    static #inflight = new Map();

    static #CACHE_TTL     = 5 * 60 * 1000;
    static #FETCH_TIMEOUT = 6_000;
    static #LIMIT         = 100;

    static #BASE = "https://yande.re";

    static #BANNED_TAGS    = /(loli|shota|child|toddler|infant|cum|penis|vagina|pubic|genitalia)/;
    static #ALLOWED_RATINGS = new Set(["s", "q"]);

    static #FEMALE_TAGS = /\b(1girl|2girls|3girls|4girls|5girls|6\+girls|multiple_girls)\b/;
    static #MALE_TAGS   = /\b(1boy|2boys|3boys|4boys|5boys|6\+boys|multiple_boys)\b/;

    static #detectGender(tags) {
        const t = (tags ?? "").toLowerCase();
        const isFemale = this.#FEMALE_TAGS.test(t);
        const isMale   = this.#MALE_TAGS.test(t);
        if (isFemale && !isMale) return "female";
        if (isMale && !isFemale) return "male";
        if (isFemale && isMale)  return "mixed";
        return "unknown";
    }

    static #isSafe(post) {
        if (!this.#ALLOWED_RATINGS.has(post.rating)) return false;
        if (this.#BANNED_TAGS.test((post.tags ?? "").toLowerCase())) return false;
        return true;
    }

    static #pruneCache() {
        const now = Date.now();
        for (const [k, v] of this.#cache) {
            if (now - v.timestamp >= this.#CACHE_TTL) this.#cache.delete(k);
        }
    }

    static #buildUrl(tagExpr) {
        return `${this.#BASE}/post.json?limit=${this.#LIMIT}&tags=${tagExpr}`;
    }

    static async #fetchPosts(cacheKey, url) {
        const cached = this.#cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.#CACHE_TTL) return cached.data;

        if (this.#inflight.has(cacheKey)) return this.#inflight.get(cacheKey);

        const promise = (async () => {
            try {
                const res = await fetch(url, {
                    signal : AbortSignal.timeout(this.#FETCH_TIMEOUT),
                    headers: { "User-Agent": "kamijs-image-provider/1.0" },
                });

                if (!res.ok) return null;

                const posts = await res.json();
                if (!Array.isArray(posts) || posts.length === 0) return null;

                const filtered = posts.filter(p => this.#isSafe(p));
                this.#pruneCache();
                this.#cache.set(cacheKey, { data: filtered, timestamp: Date.now() });

                return filtered.length ? filtered : null;
            } catch {
                return null;
            } finally {
                this.#inflight.delete(cacheKey);
            }
        })();

        this.#inflight.set(cacheKey, promise);
        return promise;
    }

    static async #fetchBestFor(tagExpr) {
        const encoded = encodeURIComponent(tagExpr);

        const [safePosts, questPosts] = await Promise.all([
            this.#fetchPosts(`s:${tagExpr}`, this.#buildUrl(`${encoded}+rating%3As`)),
            this.#fetchPosts(`q:${tagExpr}`, this.#buildUrl(`${encoded}+rating%3Aq`)),
        ]);

        const seen   = new Set();
        const merged = [];
        for (const post of [...(safePosts ?? []), ...(questPosts ?? [])]) {
            if (!seen.has(post.id)) {
                seen.add(post.id);
                merged.push(post);
            }
        }

        return merged.length ? merged : null;
    }

    static #buildPool(dataFull, dataBase) {
        const MIN_POOL = 3;
        if ((dataFull?.length ?? 0) >= MIN_POOL) return dataFull;
        if (dataFull?.length) return dataBase?.length ? [...dataFull, ...dataBase] : dataFull;
        return dataBase ?? null;
    }

    static async #resolvePool(tag) {
        const clean = tag.trim().toLowerCase().replace(/\s+/g, "_");
        const base  = clean.includes("_(") ? clean.split("_(")[0] : null;

        const [dataFull, dataBase] = await Promise.all([
            this.#fetchBestFor(clean),
            base ? this.#fetchBestFor(base) : Promise.resolve(null),
        ]);

        return this.#buildPool(dataFull, dataBase);
    }

    static async getRandomUrl(tag) {
        try {
            if (!tag || typeof tag !== "string") return null;
            const pool = await this.#resolvePool(tag);
            if (!pool?.length) return null;
            const post = pool[Math.floor(Math.random() * pool.length)];
            return post.sample_url || post.jpeg_url || post.file_url || null;
        } catch {
            return null;
        }
    }

    static async getRandomPost(tag) {
        try {
            if (!tag || typeof tag !== "string") return null;
            const pool = await this.#resolvePool(tag);
            if (!pool?.length) return null;
            const post = pool[Math.floor(Math.random() * pool.length)];
            return {
                id        : post.id,
                url       : post.sample_url || post.jpeg_url || post.file_url || null,
                file_url  : post.file_url   || null,
                sample_url: post.sample_url || null,
                jpeg_url  : post.jpeg_url   || null,
                tags      : post.tags       || "",
                rating    : post.rating     || "s",
                score     : post.score      ?? 0,
                author    : post.author     || "",
                source    : post.source     || "",
                width     : post.width      ?? 0,
                height    : post.height     ?? 0,
                gender    : this.#detectGender(post.tags),
            };
        } catch {
            return null;
        }
    }

    static clearCache() {
        this.#cache.clear();
        this.#inflight.clear();
    }
}
