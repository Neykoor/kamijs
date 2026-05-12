export class ImageProvider {
    static #cache = new Map();
    static #CACHE_TTL = 300000;

    static #BANNED_TAGS = /(sex|naked|nude|nipple|crotch|pubic|pussy|penis|vagina|genitalia|areola|cleavage_cutout|cum|bottomless|topless|undressing)/;

    static #isSafe(post) {
        const tags = (post.tags || "").toLowerCase();
        if (this.#BANNED_TAGS.test(tags)) return false;
        if (tags.includes("loli") || tags.includes("shota")) return false;
        return true;
    }

    static #pruneCache() {
        const now = Date.now();
        for (const [k, v] of this.#cache) {
            if (now - v.timestamp >= this.#CACHE_TTL) this.#cache.delete(k);
        }
    }

    static async #fetchPosts(tag, rating = "s") {
        if (!tag || typeof tag !== "string") return null;

        const cleanTag = tag.replace(/\s+/g, "_").toLowerCase();
        const query = `${cleanTag} rating:${rating}`;

        const cached = this.#cache.get(query);
        if (cached && Date.now() - cached.timestamp < this.#CACHE_TTL) return cached.data;

        try {
            const res = await fetch(`https://yande.re/post.json?tags=${encodeURIComponent(query)}&limit=100`, {
                signal: AbortSignal.timeout(8000),
                headers: { "User-Agent": "Mozilla/5.0" }
            });
            if (!res.ok) return null;

            const posts = await res.json();
            if (!Array.isArray(posts) || !posts.length) return null;

            const filtered = posts.filter(post => this.#isSafe(post));
            this.#pruneCache();
            this.#cache.set(query, { data: filtered, timestamp: Date.now() });
            return filtered.length ? filtered : null;
        } catch {
            return null;
        }
    }

    static async getRandomUrl(tag) {
        try {
            if (!tag || typeof tag !== "string") return null;
            const clean = tag.replace(/\s+/g, "_").toLowerCase();
            const base  = clean.includes("_(") ? clean.split("_(")[0] : null;

            const data =
                await this.#fetchPosts(clean, "s") ||
                await this.#fetchPosts(clean, "q") ||
                (base ? await this.#fetchPosts(base, "s") : null) ||
                (base ? await this.#fetchPosts(base, "q") : null);

            if (!data?.length) return null;
            const post = data[Math.floor(Math.random() * data.length)];
            return post.sample_url || post.file_url || post.jpeg_url || null;
        } catch {
            return null;
        }
    }
}
