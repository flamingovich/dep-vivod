import express from "express";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import * as cheerio from "cheerio";
import path from "path";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Simple in-memory cache
  const likesCache: Record<string, { likes: number; timestamp: number }> = {};
  const CACHE_TTL = 60000; // 1 minute

  // Config check for UI
  app.get("/api/config-check", (req, res) => {
    res.json({ hasApiKey: !!process.env.YOUTUBE_API_KEY });
  });

  // Helper to get channel ID from URL
  async function getChannelId(url: string, apiKey: string): Promise<string | null> {
    try {
      // If it's already a channel ID
      if (url.match(/^UC[a-zA-Z0-9_-]{22}$/)) return url;

      // If it's a handle (@name)
      const handleMatch = url.match(/@([a-zA-Z0-9._-]+)/);
      if (handleMatch) {
        const handle = handleMatch[1];
        const searchUrl = `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=@${handle}&key=${apiKey}`;
        const res = await axios.get(searchUrl);
        return res.data.items?.[0]?.id || null;
      }

      // Fallback: fetch page and look for channelId
      const res = await axios.get(url);
      const idMatch = res.data.match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/);
      return idMatch ? idMatch[1] : null;
    } catch (e) {
      console.error("Error getting channelId:", e.message);
      return null;
    }
  }

  // YouTube Like API (Official v3)
  app.get("/api/fetch-likes-api", async (req, res) => {
    let { videoId, channelUrl } = req.query;
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: "YouTube API Key not configured" });
    }

    try {
      // If no videoId but channelUrl, try to find active live stream via API
      if (!videoId && channelUrl && typeof channelUrl === "string") {
        const channelId = await getChannelId(channelUrl, apiKey);
        if (channelId) {
          const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${channelId}&type=video&eventType=live&key=${apiKey}`;
          const searchRes = await axios.get(searchUrl);
          videoId = searchRes.data.items?.[0]?.id?.videoId;
          if (videoId) {
            console.log(`Found active live videoId via Search API: ${videoId}`);
          }
        }
      }

      // If still no videoId, try the local detect-live endpoint (scraper)
      if (!videoId && channelUrl && typeof channelUrl === "string") {
        try {
          const detectRes = await axios.get(`http://localhost:3000/api/detect-live?channelUrl=${encodeURIComponent(channelUrl)}`);
          if (detectRes.data.isLive && detectRes.data.videoId) {
            videoId = detectRes.data.videoId;
          }
        } catch (e) {
          console.error("Auto-detection failed in fetch-likes-api:", e.message);
        }
      }

      if (!videoId || typeof videoId !== "string") {
        return res.status(400).json({ error: "Missing videoId and could not auto-detect" });
      }

      const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoId}&key=${apiKey}`;
      const response = await axios.get(url);
      
      const item = response.data.items?.[0];
      if (item) {
        const likes = parseInt(item.statistics.likeCount) || 0;
        // Update cache
        likesCache[videoId] = { likes, timestamp: Date.now() };
        return res.json({ likes });
      }
      
      res.json({ likes: 0 });
    } catch (error: any) {
      console.error("YouTube API Error:", error.response?.data || error.message);
      res.status(500).json({ error: "Failed to fetch likes via API" });
    }
  });

  // YouTube Live Stream Detector (Resilient Method)
  app.get("/api/detect-live", async (req, res) => {
    const { channelUrl } = req.query;
    if (!channelUrl || typeof channelUrl !== "string") {
      return res.status(400).json({ error: "Missing channelUrl" });
    }

    try {
      let targetUrl = channelUrl.trim().replace(/\/$/, "");
      
      // Ensure it's a full URL
      if (!targetUrl.startsWith('http')) {
        if (targetUrl.startsWith('@')) {
          targetUrl = `https://www.youtube.com/${targetUrl}`;
        } else if (targetUrl.startsWith('UC')) {
          targetUrl = `https://www.youtube.com/channel/${targetUrl}`;
        } else {
          targetUrl = `https://www.youtube.com/@${targetUrl}`;
        }
      }
      
      // 1. Try to fetch the /live page
      const livePageUrl = targetUrl.includes('/live') ? targetUrl : `${targetUrl}/live`;

      const response = await axios.get(livePageUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
          "Cookie": "SOCS=CAESEwgDEgk0ODE3Nzk3MjQaAnJ1IAEaBgiA_LyaBg", // Bypass consent
        },
        timeout: 10000,
        maxRedirects: 5,
      });

      const html = response.data;
      const finalUrl = response.request.res.responseUrl || livePageUrl;
      
      console.log(`Detecting live for ${livePageUrl}. Final URL: ${finalUrl}`);
      
      let videoId = null;

      // Pattern 1: Check if we were redirected to a watch URL
      const watchMatch = finalUrl.match(/[?&]v=([^&]+)/);
      if (watchMatch) {
        videoId = watchMatch[1];
        console.log(`Found videoId via redirect URL: ${videoId}`);
      }

      // Pattern 1.5: Search for canonical URL in HTML
      if (!videoId) {
        const canonicalMatch = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([^"]+)"/);
        if (canonicalMatch) {
          videoId = canonicalMatch[1];
          console.log(`Found videoId via canonical link: ${videoId}`);
        }
      }

      // Pattern 2: Search in HTML for videoId with various patterns
      if (!videoId) {
        // We look for the most specific patterns first (live stream indicators)
        // We use more restrictive regex to ensure videoId and LIVE badge are in the same block
        const patterns = [
          /"liveStreamRenderer":\s*\{"videoId":"([^"]+)"/,
          /"videoId":"([^"]+)"[^}]*?"style":"LIVE"/,
          /"videoId":"([^"]+)"[^}]*?"iconType":"LIVE"/,
          /"videoId":"([^"]+)"[^}]*?"isLive":true/,
          /"isLive":true[^}]*?"videoId":"([^"]+)"/,
          /href="\/watch\?v=([^"]+)"[^>]*>[^<]*LIVE/,
          /href="\/watch\?v=([^"]+)"[^>]*>[^<]*ПРЯМОЙ ЭФИР/
        ];

        for (const pattern of patterns) {
          const match = html.match(pattern);
          if (match) {
            videoId = match[1];
            console.log(`Found videoId via specific pattern ${pattern}: ${videoId}`);
            break;
          }
        }
      }

      // Pattern 2.5: Check ytInitialPlayerResponse - this is very reliable if we are on a watch page
      if (!videoId) {
        const playerResponseMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
        if (playerResponseMatch) {
          try {
            const playerResponse = JSON.parse(playerResponseMatch[1]);
            if (playerResponse.videoDetails?.videoId && playerResponse.videoDetails?.isLive) {
              videoId = playerResponse.videoDetails.videoId;
              console.log(`Found videoId via ytInitialPlayerResponse (isLive: true): ${videoId}`);
            }
          } catch (e) {}
        }
      }

      // Pattern 3: Fallback to metadata if no live-specific renderer found
      if (!videoId) {
        const metadataPatterns = [
          /<meta property="og:video:url" content=".*?v=([^"&]+)"/,
          /<link rel="canonical" href=".*?v=([^"&]+)"/,
          /"canonicalBaseUrl":"\/watch\?v=([^"]+)"/
        ];
        for (const pattern of metadataPatterns) {
          const match = html.match(pattern);
          if (match) {
            videoId = match[1];
            console.log(`Found videoId via metadata: ${videoId}`);
            break;
          }
        }
      }

      // Final check: is it actually live?
      // We look for various "LIVE" indicators in different languages
      const isLive = html.includes('{"iconType":"LIVE"}') || 
                     html.includes('"isLive":true') || 
                     html.includes('badge-style-type-live') ||
                     html.includes('"style":"LIVE"') ||
                     html.includes('ПРЯМОЙ ЭФИР') ||
                     html.includes('LIVE') ||
                     finalUrl.includes('/watch?v=') ||
                     (videoId && livePageUrl.includes('/live'));

      if (videoId && isLive) {
        return res.json({ videoId, isLive: true });
      }

      res.json({ isLive: false });
    } catch (error: any) {
      console.error("Detection error:", error.message);
      res.status(500).json({ error: "Detection failed" });
    }
  });

  // YouTube Like Scraper API
  app.get("/api/fetch-likes", async (req, res) => {
    let { videoId, channelUrl } = req.query;

    if (!videoId && channelUrl && typeof channelUrl === "string") {
      try {
        const detectRes = await axios.get(`http://localhost:3000/api/detect-live?channelUrl=${encodeURIComponent(channelUrl)}`);
        if (detectRes.data.isLive && detectRes.data.videoId) {
          videoId = detectRes.data.videoId;
        }
      } catch (e) {
        console.error("Auto-detection failed in fetch-likes:", e.message);
      }
    }

    if (!videoId || typeof videoId !== "string") {
      return res.status(400).json({ error: "Missing videoId and could not auto-detect" });
    }

    // Check cache
    const cached = likesCache[videoId];
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return res.json({ likes: cached.likes });
    }

    try {
      // Try desktop URL for more consistent results with desktop User-Agent
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const response = await axios.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
          "Cookie": "SOCS=CAESEwgDEgk0ODE3Nzk3MjQaAnJ1IAEaBgiA_LyaBg", // Bypass consent
          "Cache-Control": "no-cache",
          "Pragma": "no-cache",
        },
        timeout: 10000,
      });

      console.log(`Scraping likes for ${videoId}. HTML length: ${response.data.length}`);

      const $ = cheerio.load(response.data);
      let likes = 0;
      
      // Look for ytInitialData in scripts
      const scripts = $('script');
      let data: any = null;

      scripts.each((_, el) => {
        const html = $(el).html() || "";
        if (html.includes('ytInitialData')) {
          try {
            const jsonStr = html.includes('var ytInitialData = ') 
              ? html.split('var ytInitialData = ')[1].split(';')[0]
              : html.includes('window["ytInitialData"] = ')
                ? html.split('window["ytInitialData"] = ')[1].split(';')[0]
                : html.split('ytInitialData = ')[1].split(';')[0];
            data = JSON.parse(jsonStr);
            console.log(`Found ytInitialData for ${videoId}`);
            return false; // break
          } catch (e) {
            console.error(`Error parsing ytInitialData for ${videoId}:`, e.message);
          }
        }
      });

      if (data) {
        try {
          // Path for mobile/desktop layouts
          let topLevelButtons = data.contents?.twoColumnWatchNextResults?.results?.results?.contents?.find((c: any) => c.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer?.videoActions?.menuRenderer?.topLevelButtons
            || data.contents?.singleColumnWatchNextResults?.results?.results?.contents?.find((c: any) => c.itemSectionRenderer)?.itemSectionRenderer?.contents?.find((c: any) => c.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer?.videoActions?.menuRenderer?.topLevelButtons
            || data.contents?.singleColumnWatchNextResults?.results?.results?.contents?.[0]?.videoPrimaryInfoRenderer?.videoActions?.menuRenderer?.topLevelButtons
            || data.contents?.twoColumnWatchNextResults?.results?.results?.contents?.[0]?.videoPrimaryInfoRenderer?.videoActions?.menuRenderer?.topLevelButtons;

          // If still not found, try a more aggressive search in the data object
          if (!topLevelButtons && data.contents) {
            try {
              const results = data.contents.twoColumnWatchNextResults?.results?.results?.contents || [];
              for (const item of results) {
                if (item.videoPrimaryInfoRenderer?.videoActions?.menuRenderer?.topLevelButtons) {
                  topLevelButtons = item.videoPrimaryInfoRenderer.videoActions.menuRenderer.topLevelButtons;
                  break;
                }
              }
            } catch (e) {}
          }

          if (topLevelButtons) {
            const likeButton = topLevelButtons.find((b: any) => 
              b.segmentedLikeDislikeButtonRenderer || 
              b.toggleButtonRenderer || 
              b.buttonRenderer ||
              b.segmentedLikeDislikeButtonViewModel
            );

            let likeText = "";
            if (likeButton?.segmentedLikeDislikeButtonRenderer) {
              likeText = likeButton.segmentedLikeDislikeButtonRenderer.likeButton.toggleButtonRenderer?.defaultText?.accessibility?.accessibilityData?.label || "";
            } else if (likeButton?.toggleButtonRenderer) {
              likeText = likeButton.toggleButtonRenderer.defaultText?.accessibility?.accessibilityData?.label || "";
            } else if (likeButton?.segmentedLikeDislikeButtonViewModel) {
              // New YouTube layout uses view models
              likeText = likeButton.segmentedLikeDislikeButtonViewModel.likeButtonViewModel?.likeButtonViewModel?.accessibilityText || "";
            }

            console.log(`Parsed likeText: "${likeText}" for video ${videoId}`);

            // Improved regex for numbers with Russian support
            const numMatch = likeText.match(/([\d,.\s]+)/);
            if (numMatch) {
              let numStr = numMatch[1].replace(/\s/g, '').replace(',', '.');
              // Handle cases like "1.234.567" where dots are thousands separators
              if ((numStr.match(/\./g) || []).length > 1) {
                numStr = numStr.replace(/\./g, '');
              }
              
              let num = parseFloat(numStr);
              const lowerText = likeText.toLowerCase();
              
              if (lowerText.includes('тыс') || lowerText.includes('k')) num *= 1000;
              else if (lowerText.includes('млн') || lowerText.includes('m')) num *= 1000000;
              else if (lowerText.includes('млрд') || lowerText.includes('b')) num *= 1000000000;
              
              likes = Math.floor(num);
              console.log(`Parsed likes from text "${likeText}": ${likes}`);
            }
          }

          // Fallback 1: Search for likeCount directly in the JSON string
          if (likes === 0) {
            const jsonString = JSON.stringify(data);
            const likeCountMatch = jsonString.match(/"likeCount":"([^"]+)"/);
            if (likeCountMatch) {
              likes = parseInt(likeCountMatch[1]) || 0;
              console.log(`Found likes via regex in ytInitialData (likeCount): ${likes}`);
            }
          }

          // Fallback 2: Search for accessibility label in JSON string
          if (likes === 0) {
            const jsonString = JSON.stringify(data);
            const labelMatch = jsonString.match(/"label":"([\d,.\s]+)\s*([KkMmBbтысмлн]?)\s*(?:likes|лайков|лайка|лайк|нравится|отметки)"/i);
            if (labelMatch) {
              let numStr = labelMatch[1].replace(/\s/g, '').replace(',', '.');
              if ((numStr.match(/\./g) || []).length > 1) numStr = numStr.replace(/\./g, '');
              let num = parseFloat(numStr);
              const unit = (labelMatch[2] || "").toLowerCase();
              if (unit === 'k' || unit === 'тыс') num *= 1000;
              else if (unit === 'm' || unit === 'млн') num *= 1000000;
              else if (unit === 'b' || unit === 'млрд') num *= 1000000000;
              likes = Math.floor(num);
              console.log(`Found likes via regex in ytInitialData (label): ${likes}`);
            }
          }
        } catch (e) {
          console.warn(`Parsing failed for ${videoId}, trying fallback regex:`, e.message);
        }
      }

      // Fallback: Regex search in the whole HTML if JSON parsing failed or likes are 0
      if (likes === 0) {
        const patterns = [
          /"label":"([\d,.\s]+)\s*([KkMmBbтысмлн]?)\s*(?:likes|лайков|лайка|лайк|нравится|отметки)/i,
          /([\d,.\s]+)\s*([KkMmBbтысмлн]?)\s*(?:likes|лайков|лайка|лайк|нравится|отметки)/i,
          /aria-label="([\d,.\s]+)\s*([KkMmBbтысмлн]?)\s*(?:likes|лайков|лайка|лайк|нравится|отметки)/i,
          /title="([\d,.\s]+)\s*([KkMmBbтысмлн]?)\s*(?:likes|лайков|лайка|лайк|нравится|отметки)/i
        ];

        for (const pattern of patterns) {
          const match = response.data.match(pattern);
          if (match) {
            let numStr = match[1].replace(/\s/g, '').replace(',', '.');
            if ((numStr.match(/\./g) || []).length > 1) numStr = numStr.replace(/\./g, '');
            
            let num = parseFloat(numStr);
            const unit = (match[2] || "").toLowerCase();
            
            if (unit === 'k' || unit === 'тыс') num *= 1000;
            else if (unit === 'm' || unit === 'млн') num *= 1000000;
            else if (unit === 'b' || unit === 'млрд') num *= 1000000000;
            
            likes = Math.floor(num);
            if (likes > 0) {
              console.log(`Found likes via HTML regex fallback (pattern ${pattern}): ${likes}`);
              break;
            }
          }
        }
      }

      // Last ditch effort: search for any number near "likes" or "нравится"
      if (likes === 0) {
        const lastDitch = response.data.match(/(\d[\d,.\s]*)\s*(?:likes|лайков|лайка|лайк|нравится|отметки)/i);
        if (lastDitch) {
          let numStr = lastDitch[1].replace(/\s/g, '').replace(',', '.');
          if ((numStr.match(/\./g) || []).length > 1) numStr = numStr.replace(/\./g, '');
          likes = Math.floor(parseFloat(numStr)) || 0;
          if (likes > 0) console.log(`Found likes via last-ditch regex: ${likes}`);
        }
      }

      // Update cache and return
      if (likes > 0 || !cached) {
        likesCache[videoId] = { likes, timestamp: Date.now() };
      } else if (cached) {
        // If we got 0 but have a cached value, return cached (likely parsing error)
        return res.json({ likes: cached.likes });
      }
      
      return res.json({ likes });
    } catch (error: any) {
      if (error.response?.status === 429) {
        console.warn("YouTube Rate Limited (429). Returning cached value if available.");
        if (cached) return res.json({ likes: cached.likes });
        return res.status(429).json({ error: "Rate limited by YouTube. Try again later." });
      }
      console.error("Error fetching YouTube likes:", error.message);
      if (cached) return res.json({ likes: cached.likes });
      res.status(500).json({ error: "Failed to fetch likes" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
