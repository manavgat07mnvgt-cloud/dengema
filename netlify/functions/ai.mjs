// Dengem yapay zekâ köprüsü (Netlify Function).
// API anahtarı telefonda değil burada, sunucuda durur. Netlify > Site configuration > Environment variables:
//   ANTHROPIC_API_KEY = sk-ant-...        (zorunlu)
//   AI_MODEL          = claude-haiku-4-5-20251001  (isteğe bağlı; ucuz ve hızlı varsayılan)
//   ALLOWED_ORIGIN    = https://siteniz.netlify.app  (isteğe bağlı; başka sitelerin kullanmasını zorlaştırır)
export default async (req) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (req.method === "GET") return Response.json({ ok: !!key });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!key) return new Response("AI not configured", { status: 503 });

  const allowed = process.env.ALLOWED_ORIGIN;
  const origin = req.headers.get("origin");
  if (allowed && origin && origin !== allowed) return new Response("Forbidden", { status: 403 });

  let b;
  try { b = await req.json(); } catch { return new Response("Bad request", { status: 400 }); }
  if (b.image && String(b.image).length > 6_000_000) return new Response("Image too large", { status: 413 });

  let messages;
  if (Array.isArray(b.messages)) {
    messages = b.messages.slice(-20).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 20000) }));
  } else {
    const content = [];
    if (b.image) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: String(b.image) } });
    content.push({ type: "text", text: String(b.prompt || "").slice(0, 8000) });
    messages = [{ role: "user", content }];
  }

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.AI_MODEL || "claude-haiku-4-5-20251001", max_tokens: b.json ? 1200 : 900, messages })
  });
  if (r.status === 429) return new Response("Rate limited", { status: 429 });
  if (!r.ok) return new Response("AI error", { status: 502 });
  const d = await r.json();
  const text = (d.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  return Response.json({ text });
};

export const config = { path: "/api/ai" };
