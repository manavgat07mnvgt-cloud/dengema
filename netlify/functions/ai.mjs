// Dengem yapay zekâ köprüsü (Netlify Function) — Google Gemini API.
// Anahtar telefonda değil burada, sunucuda durur. Netlify > Project configuration > Environment variables:
//   GEMINI_API_KEY = AIza...            (zorunlu; aistudio.google.com'dan ücretsiz alınır)
//   GEMINI_MODEL   = gemini-3.5-flash   (isteğe bağlı; boş bırakılırsa aşağıdaki sıra denenir)
//   ALLOWED_ORIGIN = https://dengem.netlify.app  (isteğe bağlı; başka sitelerin kullanmasını zorlaştırır)
//
// Tanı testi: tarayıcıda  /api/ai?test=1  açılırsa Google'a kısa bir soru sorar ve sonucu gösterir.
// Yanıt "akış" (stream) olarak döner: Netlify böylece 10 sn yerine 60 sn bekleyebilir (fotoğraf analizi uzun sürebilir).
const MODELS = ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-2.5-flash"];

async function gemini(key, contents, generationConfig) {
  const models = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL, ...MODELS] : MODELS;
  const tries = [];
  for (const model of models) {
    let r;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ contents, generationConfig })
      });
    } catch (e) { tries.push({ model, status: 0, detail: String(e).slice(0, 200) }); continue; }
    if (r.ok) {
      const d = await r.json();
      const text = (d.candidates?.[0]?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join("");
      if (text) return { text, model, tries };
      tries.push({ model, status: 200, detail: "empty: " + (d.candidates?.[0]?.finishReason || d.promptFeedback?.blockReason || "no text") });
      continue;
    }
    let detail = "";
    try { const e = await r.json(); detail = e.error?.message || JSON.stringify(e); } catch { detail = r.statusText; }
    tries.push({ model, status: r.status, detail: String(detail).slice(0, 300) });
    if (r.status === 429 || r.status === 404 || r.status >= 500) continue;   // sınır doldu / model yok / Google hatası: sıradakini dene
    break;                                                                     // 400/403 (anahtar veya istek hatası): diğer modeller de aynı sonucu verir
  }
  const last = tries[tries.length - 1] || {};
  return { error: last.status === 429 ? "rate_limited" : "ai_error", status: last.status, tries };
}

export default async (req) => {
  const key = process.env.GEMINI_API_KEY;
  const url = new URL(req.url);

  if (req.method === "GET") {
    if (!url.searchParams.get("test")) return Response.json({ ok: !!key });
    if (!key) return Response.json({ ok: false, error: "GEMINI_API_KEY yok" });
    const t0 = Date.now();
    const out = await gemini(key, [{ role: "user", parts: [{ text: "Reply with the single word: OK" }] }], { maxOutputTokens: 2048 });
    return Response.json({ ok: !!out.text, answer: out.text || null, model: out.model || null, ms: Date.now() - t0, tries: out.tries });
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!key) return Response.json({ error: "ai_error", detail: "GEMINI_API_KEY not set" }, { status: 503 });

  const allowed = process.env.ALLOWED_ORIGIN;
  const origin = req.headers.get("origin");
  if (allowed && origin && origin !== allowed) return new Response("Forbidden", { status: 403 });

  let b;
  try { b = await req.json(); } catch { return Response.json({ error: "ai_error", detail: "bad request" }, { status: 400 }); }
  if (b.image && String(b.image).length > 6_000_000) return Response.json({ error: "image_rejected", detail: "image too large" }, { status: 413 });

  // Uygulamanın gönderdiği biçimi Gemini biçimine çevir
  let contents;
  if (Array.isArray(b.messages)) {
    contents = b.messages.slice(-20).map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "").slice(0, 20000) }]
    }));
  } else {
    const parts = [];
    if (b.image) parts.push({ inline_data: { mime_type: "image/jpeg", data: String(b.image) } });
    parts.push({ text: String(b.prompt || "").slice(0, 8000) });
    contents = [{ role: "user", parts }];
  }
  const generationConfig = { maxOutputTokens: 8192, temperature: 0.4 };
  if (b.json) generationConfig.responseMimeType = "application/json";

  // Akış: bekleme sırasında boşluk gönder (geçerli JSON öncesi boşluk sorun değildir), sonunda sonucu yaz.
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      ctrl.enqueue(enc.encode(" "));
      const iv = setInterval(() => { try { ctrl.enqueue(enc.encode(" ")); } catch {} }, 3000);
      try {
        const out = await gemini(key, contents, generationConfig);
        const body = out.text ? { text: out.text, model: out.model }
          : { error: out.error, detail: (out.tries || []).map(t => `${t.model}: ${t.status} ${t.detail}`).join(" | ").slice(0, 600) };
        ctrl.enqueue(enc.encode(JSON.stringify(body)));
      } catch (e) {
        ctrl.enqueue(enc.encode(JSON.stringify({ error: "ai_error", detail: String(e).slice(0, 300) })));
      } finally {
        clearInterval(iv);
        ctrl.close();
      }
    }
  });
  return new Response(stream, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
};

export const config = { path: "/api/ai" };
