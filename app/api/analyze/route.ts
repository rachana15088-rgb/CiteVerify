import { NextResponse } from "next/server";
import { getDocumentProxy } from "unpdf";

export const runtime = "nodejs";
export const maxDuration = 120;

import type { ClaimResult, Verdict } from "@/lib/types";
import { VERDICT_ORDER } from "@/lib/verdicts";

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_PAGES = 100;
const MAX_TEXT_LENGTH = 500_000;

class UploadError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

// No deployment byte limit, authentication, or throttling is configured in this
// repository. Deployment controls must be verified before exposing this route.
async function boundedFormData(req: Request) {
  const reader = req.body?.getReader();
  if (!reader) throw new UploadError("No PDF uploaded", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new UploadError("Upload exceeds 10 MiB", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  try {
    return await new Request(req.url, {
      method: "POST", headers: req.headers, body: bytes,
    }).formData();
  } catch {
    throw new UploadError("Invalid PDF upload", 400);
  }
}

function titlesMatch(expected: string, actual: string): boolean {
  const normalize = (title: string) => title.toLowerCase().normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const a = normalize(expected), b = normalize(actual);
  if (!a || !b) return false;
  if (a === b) return true;
  const left = new Set(a.split(" ")), right = new Set(b.split(" "));
  const common = [...left].filter((word) => right.has(word)).length;
  return common >= 3 && common / Math.max(left.size, right.size) >= 0.9;
}

type SourceMeta = {
  doi: string;
  url: string;
  abstract: string;
  found: boolean;
};

function normalizeVerdict(raw: unknown): Verdict {
  const v = (typeof raw === "string" ? raw : "").toLowerCase().trim().replace(/\s+/g, "_");
  if (v === "partially_supported") return "partly_supported";
  if (v === "outdated") return "possibly_outdated";
  return VERDICT_ORDER.includes(v as Verdict) ? v as Verdict : "needs_human_review";
}

function parseReference(ref: string) {
  const parts = (ref || "").split(/\.\s+/);
  return {
    authors: parts[0] || "",
    title: parts[1] || (ref || "").slice(0, 160),
  };
}

function stripXml(str: string): string {
  return (str || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
}
async function fetchCrossRefSource(ref: string): Promise<SourceMeta> {
  if (!ref) return { doi: "", url: "", abstract: "", found: false };
  const parsed = parseReference(ref);
  const query = parsed.title.length > 10 ? parsed.title : ref.slice(0, 140);

  try {
    const res = await fetch(
      `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=5`,
      {
        headers: { "User-Agent": "CiteVerify/1.0 (mailto:team@citeverify.org)" },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!res.ok) return { doi: "", url: "", abstract: "", found: false };
    const data = await res.json();
    const candidates = data?.message?.items;
    const item = Array.isArray(candidates) ? candidates.find((candidate) =>
      Array.isArray(candidate.title) && candidate.title.some((title: unknown) =>
        typeof title === "string" && titlesMatch(parsed.title, title))) : undefined;
    if (!item) return { doi: "", url: "", abstract: "", found: false };

    const doi = item.DOI || "";
    const url = item.URL || (doi ? `https://doi.org/${doi}` : "");
    const abstract = stripXml(item.abstract || "");

    return { doi, url, abstract, found: Boolean(doi || url) };
  } catch {
    return { doi: "", url: "", abstract: "", found: false };
  }
}
export async function POST(req: Request) {
  try {
    const form = await boundedFormData(req);
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No PDF uploaded" }, { status: 400 });
    }

    if (file.type !== "application/pdf") {
      throw new UploadError("Upload must be a PDF", 400);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
      throw new UploadError("Upload must be a valid PDF", 400);
    }
    let text = "";
    let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
    try {
      pdf = await getDocumentProxy(bytes);
      if (pdf.numPages > MAX_PAGES) throw new UploadError("PDF exceeds 100 pages", 413);
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const pageText = content.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("");
        if (text.length + pageText.length + 1 > MAX_TEXT_LENGTH) {
          throw new UploadError("PDF text exceeds the processing limit", 413);
        }
        text += pageText + "\n";
        page.cleanup();
      }
    } catch (error) {
      if (error instanceof UploadError) throw error;
      console.error("PDF parsing failed", error);
      return NextResponse.json({ error: "Could not parse this PDF" }, { status: 422 });
    } finally {
      await pdf?.loadingTask.destroy();
    }
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    let title = lines[0] || "";
    if (
      title &&
      lines[1] &&
      lines[1].length <= 15 &&
      !/[.:]$/.test(title) &&
      !/^(abstract|introduction)/i.test(lines[1])
    ) {
      title += " " + lines[1];
    }
    if (!title || title.length > 150) title = file.name.replace(/\.pdf$/i, "");

    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length < 200) {
      return NextResponse.json(
        { error: "Could not read text from this PDF (it may be a scan)." },
        { status: 422 }
      );
    }

    // 2. Parse reference list
    const refIdx = clean.toLowerCase().lastIndexOf("references");
    const body = refIdx > 0 ? clean.slice(0, refIdx) : clean;
    const refText = refIdx > 0 ? clean.slice(refIdx + 10) : "";
    const refs: Record<string, string> = {};
    for (const m of refText.matchAll(/\[(\d+)\]\s*(.+?)(?=\s\[\d+\]\s|$)/g)) {
      refs[m[1]] = m[2].trim();
    }

    // 3. Extract citation sentences + preceding sentence for claim context
    const markerRe = /\[\d+(?:\s*[,–-]\s*\d+)*\]/;
    const sentences = body
      .split(/(?<=[.!?])\s+(?=[A-Z])/)
      .map((s) => s.trim())
      .filter(Boolean);

    const items: { id: string; sentence: string; context: string; marker: string; refNum: string; ref: string }[] = [];
    sentences.forEach((s, idx) => {
      if (!markerRe.test(s)) return;
      const prev = idx > 0 ? sentences[idx - 1] : "";
      const usePrev = prev && !markerRe.test(prev) && prev.length < 300;
      const marker = s.match(markerRe)![0];
      const refNum = marker.match(/\d+/)![0];
      items.push({
        id: `c${items.length + 1}`,
        sentence: s,
        context: usePrev ? `${prev} ${s}` : s,
        marker,
        refNum,
        ref: refs[refNum] || "",
      });
    });

    const limited = items.slice(0, 15);
    if (limited.length === 0) {
      return NextResponse.json(
        { error: "No claims with citation markers like [1] were found." },
        { status: 422 }
      );
    }

    // 4. Fetch real DOIs, URLs & abstracts from CrossRef in parallel
    const uniqueRefNums = [...new Set(limited.map((i) => i.refNum).filter((n) => refs[n]))];
    const sourceByRefNum = new Map<string, SourceMeta>();
    await Promise.all(
      uniqueRefNums.map(async (num) => {
        const meta = await fetchCrossRefSource(refs[num]);
        sourceByRefNum.set(num, meta);
      })
    );

    // 5. Verify claims against retrieved CrossRef metadata/abstracts via Gemini
    const key = process.env.LLM_API_KEY?.trim();
    if (!key) {
      return NextResponse.json({ error: "Analysis service unavailable" }, { status: 500 });
    }

    const prompt =
      `You are an academic citation auditor. Each input has a "context" passage (often 2 sentences: an initial claim followed by a cited study sentence), a "reference" title, and optional "retrieved_abstract".\n` +
      `CRITICAL RULE FOR "claim": If the context has two sentences where the first states a popular claim/belief (e.g., "Vaccines cause autism." or "Adults need exactly eight hours of sleep every night.") and the second reports what a study found about it, you MUST copy the FIRST sentence (the claim being tested) into "claim", and evaluate whether the cited reference supports or refutes that first sentence!\n` +
      `Verdict guide:\n` +
      `- "contradictory": the cited study refutes or finds the opposite of the claim (e.g., claim says X causes Y, study finds no association).\n` +
      `- "unsupported": the cited study recommends something different or lacks evidence for the claim's specific assertion.\n` +
      `- "supported": the cited study directly confirms the claim.\n` +
      `Return ONLY a JSON array, one object per input, in the same order:\n` +
      `{"id": string, "claim": string, "verdict": one of ${JSON.stringify(VERDICT_ORDER)}, "evidence_quote": string, "explanation": one clear sentence, "confidence": number 0-1}.\n\n` +
      `INPUT:\n` +
      JSON.stringify(
        limited.map((i) => {
          const src = sourceByRefNum.get(i.refNum);
          return {
            id: i.id,
            context: i.context,
            reference: i.ref || "(not found in reference list)",
            retrieved_abstract: src?.abstract || "",
          };
        })
      );

    const models = [
      process.env.LLM_MODEL || "gemini-3.5-flash-lite",
      process.env.LLM_FALLBACK_MODEL || "gemini-3-flash-preview",
      "gemini-2.5-pro",
    ];

    let parsedVerdicts: any[] = [];
    let lastErr = "AI service timed out";
    for (const m of models) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": key },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                responseMimeType: "application/json",
                temperature: 0.1,
                ...(/^gemini-2\.5-flash(?:-|$)/.test(m)
                  ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
              },
            }),
            signal: AbortSignal.timeout(30000),
          }
        );
        if (res.ok) {
          const data = await res.json();
          const rawText = (data.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
          const candidate = JSON.parse(rawText);
          if (!Array.isArray(candidate)) throw new Error("Invalid AI response");
          parsedVerdicts = candidate;
          break;
        }
        lastErr = `AI service error (${res.status})`;
      } catch (err: any) {
        lastErr = err?.message || "AI request timed out";
      }
    }

    if (parsedVerdicts.length === 0) {
      console.error("AI analysis failed", lastErr);
      return NextResponse.json({ error: "Analysis service unavailable" }, { status: 504 });
    }

    const byId = new Map(parsedVerdicts.filter((v) => v && typeof v === "object").map((v: any) => [v.id, v]));
    const results: ClaimResult[] = limited.map((it) => {
      const v = byId.get(it.id);
      const parsed = parseReference(it.ref);
      const src = sourceByRefNum.get(it.refNum);
      const hasAbstract = Boolean(src?.abstract);
      const hasSource = Boolean(src?.found);

      const rawConf = typeof v?.confidence === "number" && Number.isFinite(v.confidence)
        ? Math.max(0, Math.min(1, v.confidence)) : 0;
      const calibratedConf = Math.min(rawConf, hasAbstract ? 0.96 : hasSource ? 0.85 : 0.5);

      const flags: string[] = [];
      if (!it.ref) flags.push("reference_missing");
      if (!hasSource) flags.push("no_source_retrieved");
      else if (!hasAbstract) flags.push("metadata_only");

      return {
        id: it.id,
        claim: v?.claim && it.context.toLowerCase().includes(v.claim.trim().toLowerCase())
          ? v.claim.trim()
          : it.sentence,
        citation: {
          marker: it.marker,
          title: it.ref ? parsed.title : "Not found in reference list",
          authors: it.ref ? parsed.authors : "",
          year: Number(it.ref.match(/\b(19|20)\d{2}\b/)?.[0]) || null,
          doi: src?.doi || "",
          url: src?.url || "",
        },
        evidence: {
          passage: hasAbstract
            ? (typeof v?.evidence_quote === "string" && v.evidence_quote.trim() && src!.abstract.includes(v.evidence_quote)
              ? v.evidence_quote : src!.abstract.slice(0, 320)) : "",
          location: hasAbstract ? "CrossRef Abstract" : hasSource ? "CrossRef Metadata" : "",
          source_access: hasAbstract ? "abstract_only" : hasSource ? "metadata_only" : "none",
        },
        verdict: !it.ref ? "reference_not_found" : !hasAbstract ? "needs_human_review" : normalizeVerdict(v?.verdict),
        explanation: v?.explanation || "Reviewed against source metadata.",
        confidence: v ? Number(calibratedConf.toFixed(2)) : 0,
        flags,
        review: { status: "pending", reviewer_note: "", history: [] },
      };
    });

    return NextResponse.json({ document: { title, claims_total: results.length }, results });
  } catch (e: unknown) {
    if (e instanceof UploadError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("Analysis failed", e);
    return NextResponse.json({ error: "Analysis failed" }, { status: 500 });
 }
}