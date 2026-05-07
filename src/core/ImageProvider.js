export class ImageProvider {
    static #cache = new Map();
    static #CACHE_TTL = 300000;

    static async #fetchPosts(tag) {
        if (!tag || typeof tag !== "string") return null;
        
        const cleanTag = tag.replace(/\s+/g, "_").toLowerCase();
        const query = `${cleanTag} rating:s`;
        
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

            const filtered = posts.filter((post) => {
                const tags = (post.tags || "").toLowerCase();
                if (/(sex|naked|nude|nipple|crotch|pubic|pussy|penis|vagina|genitalia|areola|cleavage_cutout)/.test(tags)) return false;
                if (tags.includes("loli") || tags.includes("shota")) return false;
                if (post.rating !== "s") return false;
                return true;
            });
            
            this.#cache.set(query, { data: filtered, timestamp: Date.now() });
            return filtered;
        } catch {
            return null;
        }
    }

    static async getRandomUrl(tag) {
        try {
            if (!tag || typeof tag !== "string") return null;
            const clean = tag.replace(/\s+/g, "_").toLowerCase();
            let data = await this.#fetchPosts(clean) || (clean.includes("_(") ? await this.#fetchPosts(clean.split("_(")[0]) : null);
            
            if (!data?.length) return null;
            const post = data[Math.floor(Math.random() * data.length)];
            return post.file_url || post.sample_url || post.jpeg_url || null;
        } catch { 
            return null; 
        }
    }
}
