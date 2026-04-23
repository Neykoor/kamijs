export class ImageProvider {
    static async #fetchPosts(tag) {
        if (!tag || typeof tag !== 'string') return null;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
            const cleanTag = tag.replace(/\s+/g, '_').toLowerCase();
            // Danbooru: rating:g = general (safe), s = sensitive — excluimos explicit y questionable
            const url = `https://danbooru.donmai.us/posts.json?tags=${encodeURIComponent(cleanTag)}+rating:g,s&limit=100&random=true`;
            const res = await fetch(url, {
                signal: controller.signal,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            if (!res.ok) return null;
            const posts = await res.json();
            // Danbooru devuelve array directo
            return Array.isArray(posts) && posts.length ? posts : null;
        } finally {
            clearTimeout(timeout);
        }
    }

    static async getRandomUrl(tag) {
        try {
            if (!tag || typeof tag !== 'string') return null;
            const cleanTag = tag.replace(/\s+/g, '_').toLowerCase();
            let posts = await this.#fetchPosts(cleanTag);

            // Fallback: intentar solo el nombre sin el sufijo de serie
            if (!posts || !posts.length) {
                const simpleTag = cleanTag.split('_(')[0];
                if (simpleTag !== cleanTag) posts = await this.#fetchPosts(simpleTag);
            }

            if (!posts || !posts.length) return null;

            const post = posts[Math.floor(Math.random() * posts.length)];
            // Danbooru usa large_file_url > url > preview_file_url
            return post.large_file_url || post.file_url || post.preview_file_url || null;
        } catch { return null; }
    }
}
