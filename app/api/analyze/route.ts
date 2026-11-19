import { NextResponse } from "next/server";
import { extractText, getDocumentProxy } from "unpdf";

export const runtime = "nodejs";
export const maxDuration = 60;

const VERDICTS = [
  "supported",
  "partly_supported",
  "unsupported",
  "contradictory",
  "possibly_outdated",
  "reference_not_found",
  "needs_human_review",
];

type SourceMeta = {
  doi: string;
  url: string;
  abstract: string;
  found: boolean;
};

function normalizeVerdict(raw: string): string {
  const v = (raw || "").toLowerCase().trim().replace(/\s+/g, "_");
  if (v === "partially_supported") return "partly_supported";
  if (v === "outdated") return "possibly_outdated";
  return VERDICTS.includes(v) ? v : "needs_human_review";
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
      `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=1`,
      {
        headers: { "User-Agent": "CiteVerify/1.0 (mailto:team@citeverify.org)" },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!res.ok) return { doi: "", url: "", abstract: "", found: false };
    const data = await res.json();
    const item = data?.message?.items?.[0];
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
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No PDF uploaded" }, { status: 400 });
    }

    // 1. Extract text and title from the uploaded PDF
    const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
    const { text } = await extractText(pdf, { mergePages: true });
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
      return NextResponse.json({ error: "Missing LLM_API_KEY in .env.local." }, { status: 500 });
    }

    const prompt =
      `You are an academic citation auditor. Each input has a "context" passage (often 2 sentences: an initial claim followed by a cited study sentence), a "reference" title, and optional "retrieved_abstract".\n` +
      `CRITICAL RULE FOR "claim": If the context has two sentences where the first states a popular claim/belief (e.g., "Vaccines cause autism." or "Adults need exactly eight hours of sleep every night.") and the second reports what a study found about it, you MUST copy the FIRST sentence (the claim being tested) into "claim", and evaluate whether the cited reference supports or refutes that first sentence!\n` +
      `Verdict guide:\n` +
      `- "contradictory": the cited study refutes or finds the opposite of the claim (e.g., claim says X causes Y, study finds no association).\n` +
      `- "unsupported": the cited study recommends something different or lacks evidence for the claim's specific assertion.\n` +
      `- "supported": the cited study directly confirms the claim.\n` +
      `Return ONLY a JSON array, one object per input, in the same order:\n` +
      `{"id": string, "claim": string, "verdict": one of ${JSON.stringify(VERDICTS)}, "evidence_quote": string, "explanation": one clear sentence, "confidence": number 0-1}.\n\n` +
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
                thinkingConfig: { thinkingBudget: 0 },
              },
            }),
            signal: AbortSignal.timeout(12000),
          }
        );
        if (res.ok) {
          const data = await res.json();
          const rawText = (data.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
          parsedVerdicts = JSON.parse(rawText);
          break;
        }
        lastErr = `AI service error (${res.status})`;
      } catch (err: any) {
        lastErr = err?.message || "AI request timed out";
      }
    }

    if (parsedVerdicts.length === 0) {
      return NextResponse.json({ error: lastErr }, { status: 504 });
    }

    const byId = new Map(parsedVerdicts.map((v: any) => [v.id, v]));
    const results = limited.map((it) => {
      const v = byId.get(it.id);
      const parsed = parseReference(it.ref);
      const src = sourceByRefNum.get(it.refNum);
      const hasAbstract = Boolean(src?.abstract);
      const hasSource = Boolean(src?.found);

      const rawConf = Number(v?.confidence) || 0.8;
      const calibratedConf = hasAbstract
        ? Math.min(Math.max(rawConf, 0.82), 0.96)
        : hasSource
          ? Math.min(Math.max(rawConf, 0.72), 0.85)
          : Math.min(rawConf, 0.5);

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
          passage: v?.evidence_quote || (hasAbstract ? src!.abstract.slice(0, 320) + "..." : ""),
          location: hasAbstract ? "CrossRef Abstract" : hasSource ? "CrossRef Metadata" : "",
          source_access: hasAbstract ? "abstract_only" : hasSource ? "metadata_only" : "none",
        },
        verdict: !it.ref ? "reference_not_found" : normalizeVerdict(v?.verdict),
        explanation: v?.explanation || "Reviewed against source metadata.",
        confidence: v ? Number(calibratedConf.toFixed(2)) : 0,
        flags,
        review: { status: "pending", reviewer_note: "", history: [] },
      };
    });

    return NextResponse.json({ document: { title, claims_total: results.length }, results });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Analysis failed" }, { status: 500 });
 }
}