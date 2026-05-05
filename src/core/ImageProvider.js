export class ImageProvider {
    static #cache = new Map();
    static #CACHE_TTL = 300000;

    static async #fetchPosts(tag) {
        if (!tag || typeof tag !== 'string') return null;
        
        const cleanTag = tag.replace(/\s+/g, '_').toLowerCase();
        const query = `${cleanTag} -rating:e`;
        
        const cached = this.#cache.get(query);
        if (cached && (Date.now() - cached.timestamp < this.#CACHE_TTL)) {
            return cached.data;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        
        try {
            const url = `https://yande.re/post.json?tags=${encodeURIComponent(query)}&limit=100`;
            const res = await fetch(url, {
                signal: controller.signal,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            
            if (!res.ok) return null;
            const posts = await res.json();

            if (!Array.isArray(posts) || posts.length === 0) return null;

            const filteredPosts = posts.filter(post => {
                const tags = (post.tags || '').toLowerCase();
                const tagsArray = tags.split(/\s+/);
                
                const isLoli = tagsArray.includes('loli');
                const isQuestionable = post.rating === 'q';
                
                const isExplicit = tagsArray.some(t => 
                    t.includes('sex') || 
                    t.includes('naked') || 
                    t.includes('nude') ||
                    t.includes('nipple') ||
                    t.includes('crotch') ||
                    t.includes('pubic')
                );

                if (isExplicit) return false;
                if (isLoli && isQuestionable) return false;
                
                return true;
            });
            
            this.#cache.set(query, {
                data: filteredPosts,
                timestamp: Date.now()
            });

            return filteredPosts;
            
        } catch {
            return null;
        } finally {
            clearTimeout(timeout);
        }
    }

    static async getRandomUrl(tag) {
        try {
            if (!tag || typeof tag !== 'string') return null;
            const cleanTag = tag.replace(/\s+/g, '_').toLowerCase();
            let data = await this.#fetchPosts(cleanTag);

            if ((!data || !data.length) && cleanTag.includes('_(')) {
                const simpleTag = cleanTag.split('_(')[0];
                data = await this.#fetchPosts(simpleTag);
            }

            if (!data || !data.length) return null;
            const post = data[Math.floor(Math.random() * data.length)];
            return post.file_url || post.sample_url || post.jpeg_url || null;
        } catch { 
            return null; 
        }
    }
}
