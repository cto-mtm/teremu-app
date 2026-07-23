import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { can, type Member } from "./tenancy.js";
import {
  expenseDocSchema,
  ingredientDocSchema,
  invoiceDocSchema,
  menuItemDocSchema,
} from "./models.js";

/**
 * Stateless Q&A over the restaurant's data. No conversation history by
 * design: each question ships a compact, PERMISSION-FILTERED snapshot of
 * the data as context — a member without finance access asks the same
 * assistant, but revenue/expenses simply aren't in what the model sees.
 */

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_MODEL = "meta/llama-4-maverick-17b-128e-instruct";

async function buildContext(rid: string, member: Member): Promise<Record<string, unknown>> {
  const db = getFirestore();
  const col = (name: string) => db.collection("restaurants").doc(rid).collection(name);
  const ctx: Record<string, unknown> = { today: new Date().toISOString().slice(0, 10) };

  // Fetched once, reused by both the pantry and menu sections.
  const needsIngredients =
    can(member, "pantry") || can(member, "menu") || can(member, "finance");
  const ingSnap = needsIngredients ? await col("ingredients").limit(300).get() : null;

  if (ingSnap && (can(member, "pantry") || can(member, "menu"))) {
    ctx.ingredients = ingSnap.docs.flatMap((d) => {
      const p = ingredientDocSchema.safeParse(d.data());
      if (!p.success) return [];
      const i = p.data;
      return [{ name: i.name, unit: i.unit, category: i.category, price: i.lastUnitPrice, prevPrice: i.prevUnitPrice, stock: +i.theoreticalQty.toFixed(1) }];
    });
  }

  if (ingSnap && (can(member, "menu") || can(member, "finance"))) {
    const menuSnap = await col("menuItems").limit(200).get();
    const ingById = new Map(ingSnap.docs.map((d) => [d.id, ingredientDocSchema.safeParse(d.data())]));
    ctx.dishes = menuSnap.docs.flatMap((d) => {
      const p = menuItemDocSchema.safeParse(d.data());
      if (!p.success || !p.data.active) return [];
      return [{
        name: p.data.name,
        price: p.data.price,
        targetMarginPct: p.data.targetMarginPct,
        recipe: p.data.recipe.map((r) => {
          if (r.subItemId) {
            const sub = menuSnap.docs.find((m) => m.id === r.subItemId);
            return { subRecipe: sub?.get("name") ?? "?", portions: r.qty };
          }
          const ing = r.ingredientId ? ingById.get(r.ingredientId) : undefined;
          return { ingredient: ing?.success ? ing.data.name : "?", qty: r.qty, unit: r.unit ?? (ing?.success ? ing.data.unit : "?") };
        }),
      }];
    });
  }

  if (can(member, "triage") || can(member, "vendors")) {
    const snap = await col("invoices").orderBy("createdAt", "desc").limit(40).get();
    ctx.recentDocuments = snap.docs.flatMap((d) => {
      const p = invoiceDocSchema.safeParse(d.data());
      if (!p.success) return [];
      const i = p.data;
      return [{ vendor: i.vendorName, date: i.invoiceDate, type: i.docType, status: i.status, total: i.total, expenseTag: i.expenseTag ?? null }];
    });
  }

  if (can(member, "finance")) {
    const [revSnap, expSnap] = await Promise.all([
      col("revenue").orderBy("date", "desc").limit(90).get(),
      col("expenses").orderBy("date", "desc").limit(90).get(),
    ]);
    ctx.revenueByDate = revSnap.docs.map((d) => ({ date: d.get("date"), amount: d.get("amount") }));
    ctx.expenses = expSnap.docs.flatMap((d) => {
      const p = expenseDocSchema.safeParse(d.data());
      return p.success ? [{ date: p.data.date, tag: p.data.tag, amount: p.data.amount, vendor: p.data.vendorName }] : [];
    });
  }

  return ctx;
}

const SYSTEM = `You are Teremu's kitchen assistant for an independent restaurant. Answer the user's question using ONLY the JSON data provided. Rules:
- Reply in the same language as the question (usually Spanish).
- Be concise and concrete: numbers, names, short sentences. No markdown headers.
- Money is USD unless the data suggests otherwise. Percentages to 1 decimal.
- If the data doesn't contain the answer, say so plainly — never invent figures.
- Margin of a dish = (price − plate cost) / price, where plate cost = Σ recipe qty × ingredient price (convert g/kg and ml/L when needed).`;

export async function askAssistant(
  rid: string,
  member: Member,
  question: string,
  history: { role: "user" | "assistant"; content: string }[] = [],
): Promise<string> {
  const context = await buildContext(rid, member);
  const apiKey = process.env.NVIDIA_API_KEY;

  if (!apiKey) {
    // Offline/emulator mode: honest placeholder that proves the wiring.
    const parts: string[] = ["(demo sin IA)"];
    if (Array.isArray(context.ingredients)) parts.push(`${(context.ingredients as unknown[]).length} ingredientes`);
    if (Array.isArray(context.dishes)) parts.push(`${(context.dishes as unknown[]).length} platos`);
    if (Array.isArray(context.recentDocuments)) parts.push(`${(context.recentDocuments as unknown[]).length} documentos recientes`);
    return `Sin NVIDIA_API_KEY solo puedo confirmar el contexto disponible: ${parts.join(", ")}. Configura la clave para respuestas reales.`;
  }

  const res = await fetch(NVIDIA_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.NVIDIA_MODEL || DEFAULT_MODEL,
      max_tokens: 600,
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM },
        // Session turns (client-held) so follow-ups resolve; the DATA
        // snapshot still rebuilds fresh on every call.
        ...history.slice(-10),
        { role: "user", content: `DATA:\n${JSON.stringify(context)}\n\nQUESTION: ${question}` },
      ],
    }),
  });
  if (!res.ok) {
    logger.error(`Assistant NVIDIA API ${res.status}`, await res.text().catch(() => ""));
    throw new Error("assistant upstream error");
  }
  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}
