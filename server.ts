import express from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function createServer() {
  const app = express();
  app.use(express.json());

  // Wait for GoogleGenAI request
  app.post('/api/gemini/generate', async (req, res) => {
    try {
      const { prompt, previousContent } = req.body;
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY environment variable is required.");
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      // Assemble contents. Support multi-turn if previousContent exists.
      let contents = [];
      if (previousContent && Array.isArray(previousContent)) {
         contents = previousContent.map(item => {
           if (typeof item === 'string') {
             return { role: 'user', parts: [{ text: item }] };
           }
           return item;
         });
         contents.push({ role: 'user', parts: [{ text: prompt }] });
      } else {
         contents = [{ role: 'user', parts: [{ text: prompt }] }];
      }

      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-lite",
        contents,
        tools: [{ googleMaps: {} }],
        toolConfig: { includeServerSideToolInvocations: true },
        config: {
          systemInstruction: "Anda adalah AI Assistant Dashboard Profit Margin Area Jatim Timur. Tugas Anda membantu memberikan panduan analitik, serta memanfaatkan tool Google Maps (Maps Grounding) jika user membutuhkan informasi koordinat, lokasi gedung Jatim Timur, atau rute untuk verifikasi lapangan."
        }
      });

      res.json({ text: response.text, modelTurn: response.candidates?.[0]?.content });
    } catch (e) {
      console.error("Gemini API Error:", e);
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Helper function to parse coordinates from Gemini response text
  function parseCoordinatesFromText(text: string): { lat: number; lng: number } | null {
    try {
      const cleanText = text.replace(/```json/gi, "").replace(/```/gi, "").trim();
      const jsonMatch = cleanText.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed && typeof parsed.lat === 'number' && typeof parsed.lng === 'number') {
          return { lat: parsed.lat, lng: parsed.lng };
        }
      }
    } catch (e) {
      console.warn("Failed to parse coordinates as JSON from AI text:", e);
    }

    const match = text.match(/"lat"\s*:\s*(-?\d+\.\d+)\s*,\s*"lng"\s*:\s*(-?\d+\.\d+)/) ||
                  text.match(/lat\s*:\s*(-?\d+\.\d+)\s*,\s*lng\s*:\s*(-?\d+\.\d+)/) ||
                  text.match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
    if (match) {
      const lat = parseFloat(match[1]);
      const lng = parseFloat(match[2]);
      if (!isNaN(lat) && !isNaN(lng)) {
        return { lat, lng };
      }
    }

    return null;
  }

  // Endpoint to geocode any query using Gemini Google Maps grounding
  app.post('/api/geocode-gemini', async (req, res) => {
    try {
      const { query } = req.body;
      if (!query) {
        return res.status(400).json({ error: 'Query is required' });
      }

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY environment variable is required.");
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      console.log(`Geocoding query using Gemini Maps Grounding: "${query}"`);
      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-lite",
        contents: `Berapa koordinat latitude dan longitude presisi dari tempat / lokasi / alamat ini menurut database Google Maps: "${query}"? Berikan output dalam format JSON murni: {"lat": -8.xxxx, "lng": 114.xxxx}. Pastikan koordinat ini adalah titik pin (marker) yang sama persis dengan yang ada di Google Maps.`,
        config: {
          tools: [{ googleMaps: {} }]
        }
      });

      const parsedCoords = parseCoordinatesFromText(response.text || '');
      if (parsedCoords) {
        console.log(`Success geocoding "${query}":`, parsedCoords);
        return res.json({
          success: true,
          lat: parsedCoords.lat,
          lng: parsedCoords.lng
        });
      }

      throw new Error("Gagal mengurai koordinat dari respon AI");
    } catch (error: any) {
      console.error("Error geocoding via Gemini:", error);
      res.status(500).json({ error: String(error.message || error) });
    }
  });

  // Endpoint to unshorten Google Maps URLs and extract coordinates
  app.post('/api/unshorten-maps', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) {
        return res.status(400).json({ error: 'URL is required' });
      }

      let currentUrl = url;
      let redirectsCount = 0;
      const maxRedirects = 10;
      let finalUrl = url;

      while (redirectsCount < maxRedirects) {
        let response;
        try {
          response = await fetch(currentUrl, {
            method: 'HEAD',
            redirect: 'manual',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
          });
        } catch (err) {
          try {
            response = await fetch(currentUrl, {
              method: 'GET',
              redirect: 'manual',
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
              }
            });
          } catch (getErr) {
            break;
          }
        }

        const location = response.headers.get('location');
        if (location) {
          currentUrl = new URL(location, currentUrl).href;
          finalUrl = currentUrl;
          redirectsCount++;
          
          // Let redirects follow completely so we get canonical place path with full name / CID
        } else {
          break;
        }
      }

      // Try to parse coords from the final/intermediate URLs
      let lat: string | null = null;
      let lng: string | null = null;

      // 1. Match !3dlat!4dlng (Precise marker pin on Google Maps)
      const matchCoords3d4d = finalUrl.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
      if (matchCoords3d4d) {
        lat = matchCoords3d4d[1];
        lng = matchCoords3d4d[2];
      } else {
        // 2. Match q=lat,lng or query=lat,lng query parameters
        let parsedFromQuery = false;
        try {
          const urlObj = new URL(finalUrl);
          const q = urlObj.searchParams.get('q') || urlObj.searchParams.get('query');
          if (q) {
            const qMatch = q.match(/^(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)$/);
            if (qMatch) {
              lat = qMatch[1];
              lng = qMatch[2];
              parsedFromQuery = true;
            }
          }
        } catch(e) {}

        if (!parsedFromQuery) {
          // 3. Fallback to @lat,lng,z (Google Maps map/camera viewport center)
          const matchCoords = finalUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
          if (matchCoords) {
            lat = matchCoords[1];
            lng = matchCoords[2];
          }
        }
      }

      let placeName: string | null = null;
      const matchPlace = finalUrl.match(/\/place\/([^\/]+)/);
      if (matchPlace) {
        placeName = decodeURIComponent(matchPlace[1]).replace(/\+/g, ' ');
      }

      // 4. SUPER REINFORCEMENT: If process.env.GEMINI_API_KEY is present and we have a place name,
      // use Gemini Google Maps Grounding to get the absolute precise coordinates of this place
      // so it matches Google Maps exactly on Leaflet!
      let resolvedLat = lat ? parseFloat(lat) : null;
      let resolvedLng = lng ? parseFloat(lng) : null;
      let isAiResolved = false;

      const apiKey = process.env.GEMINI_API_KEY;
      if (apiKey && placeName) {
        try {
          const ai = new GoogleGenAI({
            apiKey,
            httpOptions: {
              headers: {
                'User-Agent': 'aistudio-build',
              }
            }
          });

          console.log(`Resolving precise coordinates for Google Maps Place: "${placeName}" using Gemini`);
          const aiResponse = await ai.models.generateContent({
            model: "gemini-3.1-flash-lite",
            contents: `Berapa koordinat latitude dan longitude presisi dari tempat ini menurut database Google Maps: "${placeName}"? Berikan output dalam format JSON murni: {"lat": -8.xxxx, "lng": 114.xxxx}. Pastikan koordinat ini adalah titik pin (marker) yang sama persis dengan yang ada di Google Maps.`,
            config: {
              tools: [{ googleMaps: {} }]
            }
          });

          const parsedCoords = parseCoordinatesFromText(aiResponse.text || '');
          if (parsedCoords) {
            resolvedLat = parsedCoords.lat;
            resolvedLng = parsedCoords.lng;
            isAiResolved = true;
            console.log(`Successfully resolved precise Google Maps coordinates via Gemini:`, parsedCoords);
          }
        } catch (e) {
          console.warn("Gemini Google Maps Grounding resolution failed, falling back to URL/regex coordinates:", e);
        }
      }

      res.json({
        success: true,
        finalUrl,
        lat: resolvedLat,
        lng: resolvedLng,
        placeName,
        isAiResolved
      });
    } catch (error: any) {
      console.error("Error unshortening URL:", error);
      res.status(500).json({ error: String(error.message || error) });
    }
  });

  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  const port = 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`Server starting on port ${port}`);
  });
}

createServer();
