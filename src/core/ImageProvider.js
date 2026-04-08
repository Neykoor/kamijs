export class ImageProvider {
    static async getRandomUrl(tag) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);

        try {
            const query = encodeURIComponent(`${tag} -rating:e`);
            const page = Math.floor(Math.random() * 5) + 1;
            const url = `https://yande.re/post.json?tags=${query}&limit=25&page=${page}`;
            
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
            return randomPost.file_url || randomPost.sample_url;
            
        } catch (e) {
            return null;
        } finally {
            clearTimeout(timeout);
        }
    }
}
