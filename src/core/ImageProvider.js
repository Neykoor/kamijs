export class ImageProvider {
    static async #fetchPosts(tag) {
        if (!tag || typeof tag !== 'string') return null;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        
        try {
            const cleanTag = tag.replace(/\s+/g, '_').toLowerCase();
            
            // LA SOLUCIÓN: Agregamos "-rating:e" a la petición. 
            // Esto obliga a yande.re a devolver 100 imágenes que NO sean explícitas,
            // garantizando que siempre haya algo que pase tu filtro local.
            const query = `${cleanTag} -rating:e`;
            const url = `https://yande.re/post.json?tags=${encodeURIComponent(query)}&limit=100`;
            
            const res = await fetch(url, {
                signal: controller.signal,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            
            if (!res.ok) return null;
            const posts = await res.json();

            if (!Array.isArray(posts) || posts.length === 0) return null;

            // --- TU FILTRO AVANZADO ---
            return posts.filter(post => {
                const tags = (post.tags || '').toLowerCase();
                const tagsArray = tags.split(/\s+/);
                
                const isLoli = tagsArray.includes('loli');
                const isQuestionable = post.rating === 'q';

                // La API ya excluyó el rating 'e', pero por seguridad extra bloqueamos tags específicos
                const isExplicit = tagsArray.includes('sex') || tagsArray.includes('naked') || tagsArray.includes('nude');

                if (isExplicit) {
                    return false;
                }
                
                // Tu regla: Si el personaje es loli, bloqueamos el contenido ecchi/questionable
                if (isLoli && isQuestionable) {
                    return false;
                }
                
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
        } catch { 
            return null; 
        }
    }
}
