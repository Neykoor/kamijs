export class ImageProvider {
    static async getRandomUrl(tag) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);

        try {
            const query = encodeURIComponent(`${tag} -rating:e`);
            const url = `https://yande.re/post.json?tags=${query}&limit=25`;
            
            const response = await fetch(url, {
                signal: controller.signal,
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36' 
                }
            });
            
            if (!response.ok) throw new Error(`HTTP_${response.status}`);
            
            const data = await response.json();
                        if (!Array.isArray(data) || !data.length) return null;

            const randomPost = data[Math.floor(Math.random() * data.length)];
            const finalUrl = randomPost.file_url || randomPost.sample_url;

            if (finalUrl) {
                console.log(`[Kamijs - Debug] Imagen encontrada para ${tag}: ${finalUrl}`);
            }

            return finalUrl;
            
        } catch (e) {
            console.warn(`[Kamijs - ImageProvider] Fallo para ${tag}:`, e.message);
            return null;
        } finally {
            clearTimeout(timeout);
        }
    }
}
