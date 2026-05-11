// api/audio.js
// Audio Studio — Gemini TTS
// Convierte texto → PCM (Gemini) → WAV (Node, sin ffmpeg) → base64
// Devuelve: { audioBase64, mimeType, voice, duration }

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
    }),
  });
  return getFirestore();
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const TTS_MODEL   = "gemini-2.5-flash-preview-tts";

const STYLE_PREFIX =
  "Leé el siguiente texto en español rioplatense argentino, con acento porteño " +
  "de Buenos Aires natural y cálido. NO uses acento mexicano, colombiano, " +
  "boliviano, peruano, chileno ni neutro latinoamericano. Pronunciá la 'll' " +
  "y la 'y' como 'sh' (yeísmo rehilado), usá voseo (vos en lugar de tú). " +
  "Texto a leer:\n\n";

const SAMPLE_TEXT =
  "Che, soy una voz porteña de Buenos Aires. Escuchame cómo sueno con acento argentino rioplatense, así sabés si te sirvo para tu locución.";

// Catálogo completo de voces Gemini
export const VOICES = [
  { name: "Zephyr",        desc: "Brillante",     gen: "f", tono: "energica" },
  { name: "Puck",          desc: "Animada",        gen: "m", tono: "energica" },
  { name: "Charon",        desc: "Informativa",    gen: "m", tono: "neutra"   },
  { name: "Kore",          desc: "Firme",          gen: "f", tono: "neutra"   },
  { name: "Fenrir",        desc: "Excitable",      gen: "m", tono: "energica" },
  { name: "Leda",          desc: "Juvenil",        gen: "f", tono: "calma"    },
  { name: "Orus",          desc: "Firme",          gen: "m", tono: "neutra"   },
  { name: "Aoede",         desc: "Suave",          gen: "f", tono: "calma"    },
  { name: "Callirrhoe",    desc: "Tranquila",      gen: "f", tono: "calma"    },
  { name: "Autonoe",       desc: "Brillante",      gen: "f", tono: "energica" },
  { name: "Enceladus",     desc: "Susurrante",     gen: "m", tono: "calma"    },
  { name: "Iapetus",       desc: "Clara",          gen: "m", tono: "neutra"   },
  { name: "Umbriel",       desc: "Tranquila",      gen: "m", tono: "calma"    },
  { name: "Algieba",       desc: "Suave",          gen: "m", tono: "calma"    },
  { name: "Despina",       desc: "Suave",          gen: "f", tono: "calma"    },
  { name: "Erinome",       desc: "Clara",          gen: "f", tono: "neutra"   },
  { name: "Algenib",       desc: "Grave",          gen: "m", tono: "neutra"   },
  { name: "Rasalgethi",    desc: "Informativa",    gen: "m", tono: "neutra"   },
  { name: "Laomedeia",     desc: "Animada",        gen: "f", tono: "energica" },
  { name: "Achernar",      desc: "Suave",          gen: "f", tono: "calma"    },
  { name: "Alnilam",       desc: "Firme",          gen: "m", tono: "neutra"   },
  { name: "Schedar",       desc: "Equilibrada",    gen: "f", tono: "neutra"   },
  { name: "Gacrux",        desc: "Madura",         gen: "f", tono: "neutra"   },
  { name: "Pulcherrima",   desc: "Decidida",       gen: "f", tono: "energica" },
  { name: "Achird",        desc: "Amigable",       gen: "m", tono: "calma"    },
  { name: "Zubenelgenubi", desc: "Casual",         gen: "m", tono: "neutra"   },
  { name: "Vindemiatrix",  desc: "Gentil",         gen: "f", tono: "calma"    },
  { name: "Sadachbia",     desc: "Animada",        gen: "m", tono: "energica" },
  { name: "Sadaltager",    desc: "Sabio",          gen: "m", tono: "neutra"   },
  { name: "Sulafat",       desc: "Cálida",         gen: "f", tono: "calma"    },
];

// PCM 24kHz mono 16-bit → WAV (puro Node, sin ffmpeg)
function pcmToWavBase64(pcmBytes, sampleRate = 24000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBytes.length;
  const headerSize = 44;
  const buf = Buffer.alloc(headerSize + dataSize);

  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);           // subchunk1 size
  buf.writeUInt16LE(1, 20);            // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  pcmBytes.copy(buf, headerSize);

  return buf.toString("base64");
}

async function geminiTTS(text, voiceName, applyStyle = true, apiKey) {
  const fullText = applyStyle ? STYLE_PREFIX + text.trim() : text.trim();
  const url = `${GEMINI_BASE}/models/${TTS_MODEL}:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ parts: [{ text: fullText }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voiceName },
        },
      },
    },
  };

  let lastErr = "";
  for (let intento = 0; intento < 3; intento++) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (r.ok) {
      const data = await r.json();
      try {
        const b64 = data.candidates[0].content.parts[0].inlineData.data;
        return Buffer.from(b64, "base64");
      } catch (_) {
        throw new Error("Gemini devolvió respuesta vacía. Probá con otro texto.");
      }
    }

    const status = r.status;
    if ([408, 429, 500, 502, 503, 504].includes(status)) {
      lastErr = `Gemini ${status}`;
      await new Promise(res => setTimeout(res, 1500 * Math.pow(2, intento)));
      continue;
    }
    const body = await r.text();
    if (body.includes("INVALID_ARGUMENT")) throw new Error("La voz rechazó este texto. Probá otra voz o reformulá el guion.");
    if (body.includes("PERMISSION_DENIED") || status === 403) throw new Error("Sin permisos para esa voz.");
    throw new Error(`Gemini ${status}: ${body.slice(0, 200)}`);
  }
  throw new Error(`${lastErr}. Probá de nuevo en unos segundos.`);
}

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  const GOOGLE_KEY = process.env.GOOGLE_AI_KEY;

  // --- GET /api/audio?action=voices → lista de voces
  if (req.method === "GET" && req.query.action === "voices") {
    if (!GOOGLE_KEY) return res.status(400).json({ error: "Falta GOOGLE_AI_KEY en env" });
    return res.status(200).json({ voices: VOICES });
  }

  // --- GET /api/audio?action=sample&voice=X → genera sample de voz
  if (req.method === "GET" && req.query.action === "sample") {
    if (!GOOGLE_KEY) return res.status(400).json({ error: "Falta GOOGLE_AI_KEY en env" });
    const voiceName = req.query.voice;
    const valid = VOICES.find(v => v.name === voiceName);
    if (!valid) return res.status(404).json({ error: "Voz desconocida" });

    try {
      const pcm = await geminiTTS(SAMPLE_TEXT, voiceName, false, GOOGLE_KEY);
      const wavB64 = pcmToWavBase64(pcm);
      return res.status(200).json({ audioBase64: wavB64, mimeType: "audio/wav", voice: voiceName });
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  // --- POST /api/audio → genera audio completo
  if (req.method === "POST") {
    if (!GOOGLE_KEY) return res.status(400).json({ error: "Falta GOOGLE_AI_KEY en env" });

    const { text, voice_name, apply_style = true, uid } = req.body || {};
    if (!text?.trim() || !voice_name) return res.status(400).json({ error: "Faltan text o voice_name" });
    if (!VOICES.find(v => v.name === voice_name)) return res.status(400).json({ error: "Voz inválida" });

    // Validar uid contra Firebase si se necesita auth (opcional)
    // Por ahora cualquier usuario logueado puede usar (el uid viene del cliente)

    try {
      const pcm = await geminiTTS(text.trim(), voice_name, apply_style, GOOGLE_KEY);
      // Estimación de duración: PCM 24kHz 16-bit mono = 48000 bytes/seg
      const durationSec = Math.round((pcm.length / 48000) * 10) / 10;
      const wavB64 = pcmToWavBase64(pcm);

      return res.status(200).json({
        audioBase64: wavB64,
        mimeType: "audio/wav",
        voice: voice_name,
        duration: durationSec,
        chars: text.trim().length,
      });
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
