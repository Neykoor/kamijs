export class ImageProvider {
    static async #fetchPosts(tag) {
        if (!tag || typeof tag !== 'string') return null;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
            const cleanTag = tag.replace(/\s+/g, '_').toLowerCase();
            // Quitamos el +-rating:e de la URL para traer todo y filtrarlo en código
            const url = `https://yande.re/post.json?tags=${encodeURIComponent(cleanTag)}&limit=100`;
            const res = await fetch(url, {
                signal: controller.signal,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            
            if (!res.ok) return null;
            const posts = await res.json();

            if (!Array.isArray(posts)) return null;

            // --- FILTRO: BLOQUEAR ÚNICAMENTE LOLIS DESNUDAS/EXPLÍCITAS ---
            return posts.filter(post => {
                const tags = (post.tags || '').toLowerCase();
                const tagsArray = tags.split(/\s+/);
                
                const isLoli = tagsArray.includes('loli');
                const isNaked = post.rating === 'e' || tagsArray.includes('naked') || tagsArray.includes('nude');

                // Si se cumplen ambas (es loli Y es explícita/desnuda), se descarta
                if (isLoli && isNaked) {
                    return false;
                }
                
                // Cualquier otro caso (loli segura o personaje no-loli explícito) pasa
                return true;
            });
            // -------------------------------------------------------------
            
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

            if (!data || !data.length) {
                const simpleTag = cleanTag.split('_(')[0];
                if (simpleTag !== cleanTag) data = await this.#fetchPosts(simpleTag);
            }

            if (!data || !data.length) return null;
            const post = data[Math.floor(Math.random() * data.length)];
            return post.file_url || post.sample_url || post.jpeg_url || null;
        } catch { return null; }
    }
}
