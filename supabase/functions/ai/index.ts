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
  const t0 = Date.now();
  const who = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, { headers: { Authorization: auth, apikey }, signal: AbortSignal.timeout(10000) }).catch(() => null);
  console.log("auth", who?.status, Date.now() - t0, "ms");
  if (!who || !who.ok) return json({ error: "auth" }, 401);
  // Tuỳ chọn: chỉ cho một số email dùng key chung (secret ALLOWED_EMAILS, cách nhau dấu phẩy). Người khác tự dán key Gemini của mình trên web.
  const allow = (Deno.env.get("ALLOWED_EMAILS") || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  if (allow.length) {
    const u = await who.json().catch(() => ({}));
    if (!allow.includes(String(u?.email || "").toLowerCase())) return json({ error: "notallowed" }, 403);
  }

  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return json({ error: "nokey" }, 500);

  let body: { prompt?: string; images?: { mime?: string; data?: string }[]; schema?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad" }, 400); }
  const prompt = String(body.prompt || "").slice(0, 80000);
  if (!prompt) return json({ error: "bad" }, 400);
  // Ảnh trang tài liệu (base64 JPEG/PNG) hoặc ghi âm bài nói (WAV), tối đa 20 tệp
  const images = (Array.isArray(body.images) ? body.images : [])
    .filter((i) => i && typeof i.data === "string" && /^(image\/(jpeg|png|webp)|audio\/(wav|mpeg|mp3|ogg|flac|aac))$/.test(String(i.mime)))
    .slice(0, 20);
  const parts: unknown[] = [{ text: prompt }, ...images.map((i) => ({ inline_data: { mime_type: i.mime, data: i.data } }))];

  // Model hết lượt (429) thì thử model kế tiếp; mỗi model có hạn mức miễn phí riêng. Model không tồn tại (404) thì bỏ qua.
  const EXTRA = "gemini-flash-latest,gemini-flash-lite-latest,gemini-2.5-flash,gemini-2.5-flash-lite";
  const models = [...new Set(`${Deno.env.get("GEMINI_MODELS") || DEFAULT_MODELS},${EXTRA}`.split(",").map((s) => s.trim()).filter(Boolean))];
  let last = "busy"; // busy = Gemini quá tải (503), quota = hết lượt miễn phí (429)
  // Gọi 1 model; thinking "low" cho nhanh (không hỗ trợ thì gọi lại không có thinkingConfig)
  const call = async (m: string, think: boolean) => {
    const t1 = Date.now();
    const gen: Record<string, unknown> = { temperature: 0.8, maxOutputTokens: 32768 };
    if (think) gen.thinkingConfig = { thinkingLevel: "low" };
    // Khuôn JSON bắt buộc (vd. kết quả chấm Nói) để AI luôn trả đúng dạng
    if (body.schema && typeof body.schema === "object") { gen.responseMimeType = "application/json"; gen.responseSchema = body.schema; gen.temperature = 0.4; }
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: gen }),
        signal: AbortSignal.timeout(Math.max(10000, 125000 - (Date.now() - t0))),
      });
      console.log("gemini", m, think ? "low" : "default", r.status, Date.now() - t1, "ms");
      return r;
    } catch (e) { console.log("gemini", m, "error", String(e), Date.now() - t1, "ms"); return null; }
  };
  for (const m of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() - t0 > 110000) { last = "timeout"; break; }
      let r = await call(m, true);
      if (r && r.status === 400) {
        const t = await r.clone().text();
        if (/thinking/i.test(t)) r = await call(m, false);
      }
      if (!r) { last = "network"; break; }
      if (r.status === 503 || r.status === 500) { if (last !== "quota") last = "busy"; if (attempt === 0) { await new Promise((z) => setTimeout(z, 2500)); continue; } break; }
      if (r.status === 429) { last = "quota"; break; }
      if (r.status === 404) { if (last !== "quota") last = "model"; break; }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: "gemini", detail: d?.error?.message || String(r.status) }, 502);
      const c = d.candidates?.[0];
      const text = (c?.content?.parts || []).filter((p: { thought?: boolean }) => !p.thought).map((p: { text?: string }) => p.text || "").join("");
      if (!text) { last = "empty"; break; }
      return json({ text, model: m, finish: c?.finishReason || "" });
    }
    if (last === "timeout") break;
  }
  return json({ error: last }, last === "quota" ? 429 : last === "busy" ? 503 : last === "timeout" ? 504 : 502);
});
