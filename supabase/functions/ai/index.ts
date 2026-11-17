// Supabase Edge Function "ai": web gọi vào đây, hàm này gọi Gemini bằng key bí mật.
// Cần secret GEMINI_API_KEY. Tuỳ chọn GEMINI_MODELS (danh sách model, cách nhau dấu phẩy).
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

const DEFAULT_MODELS = "gemini-flash-latest,gemini-3.5-flash,gemini-flash-lite-latest,gemini-3.5-flash-lite";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  // Chỉ người đã đăng nhập web mới được dùng
  const auth = req.headers.get("Authorization") || "";
  const apikey = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";
  const who = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, { headers: { Authorization: auth, apikey } });
  if (!who.ok) return json({ error: "auth" }, 401);

  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return json({ error: "nokey" }, 500);

  let body: { prompt?: string; images?: { mime?: string; data?: string }[] };
  try { body = await req.json(); } catch { return json({ error: "bad" }, 400); }
  const prompt = String(body.prompt || "").slice(0, 80000);
  if (!prompt) return json({ error: "bad" }, 400);
  // Ảnh trang tài liệu (base64 JPEG/PNG), tối đa 20 ảnh
  const images = (Array.isArray(body.images) ? body.images : [])
    .filter((i) => i && typeof i.data === "string" && /^image\/(jpeg|png|webp)$/.test(String(i.mime)))
    .slice(0, 20);
  const parts: unknown[] = [{ text: prompt }, ...images.map((i) => ({ inline_data: { mime_type: i.mime, data: i.data } }))];

  const models = (Deno.env.get("GEMINI_MODELS") || DEFAULT_MODELS).split(",").map((s) => s.trim()).filter(Boolean);
  let last = "quota";
  for (const m of models) {
    let r: Response;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 32768 },
        }),
      });
    } catch { last = "network"; continue; }
    if (r.status === 429 || r.status === 503 || r.status === 500) { last = "quota"; continue; }
    if (r.status === 404) { last = "model"; continue; }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: "gemini", detail: d?.error?.message || String(r.status) }, 502);
    const c = d.candidates?.[0];
    const text = (c?.content?.parts || []).filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text || "").join("");
    if (!text) { last = "empty"; continue; }
    return json({ text, model: m, finish: c?.finishReason || "" });
  }
  return json({ error: last }, last === "quota" ? 429 : 502);
});
