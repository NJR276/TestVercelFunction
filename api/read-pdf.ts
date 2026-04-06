import type { VercelRequest, VercelResponse } from "@vercel/node";
import pdfParse from "pdf-parse";

interface RentEntry {
  period: string;
  annualBaseRent?: string;
  monthlyInstallment?: string;
  perSquareFoot?: string;
}

function extractRentAmounts(text: string): RentEntry[] {
  const dollarPattern = /\$([\d,]+\.\d{2})/g;

  // Isolate the Base Rent section
  const rentSectionMatch = text.match(
    /Base\s*Rent[:\s]*(.*?)(?:\([l-z]\)|Additional\s+Rent)/is
  );
  if (!rentSectionMatch) return [];

  const rentText = rentSectionMatch[1];

  // Find all period labels
  const periodPatterns = [
    /(?:Rent\s+Commencement\s*(?:Date)?[-\s]*Lease\s+Years?\s*\d+)/gi,
    /Lease\s+Years?\s*\d+\s*[-–]\s*\d+/gi,
  ];

  const periodsMap = new Map<string, number>();
  for (const pp of periodPatterns) {
    let m: RegExpExecArray | null;
    while ((m = pp.exec(rentText)) !== null) {
      const label = m[0].trim();
      if (!periodsMap.has(label)) {
        periodsMap.set(label, m.index);
      }
    }
  }
  // Also check full text
  for (const pp of periodPatterns) {
    pp.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pp.exec(text)) !== null) {
      const label = m[0].trim();
      if (!periodsMap.has(label)) {
        periodsMap.set(label, m.index);
      }
    }
  }

  const periodLabels = [...periodsMap.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([label]) => label);

  // Extract all dollar amounts from the rent section
  const amounts: number[] = [];
  let dm: RegExpExecArray | null;
  while ((dm = dollarPattern.exec(rentText)) !== null) {
    amounts.push(parseFloat(dm[1].replace(/,/g, "")));
  }

  if (!amounts.length || !periodLabels.length) return [];

  // Classify by magnitude
  const annual = amounts.filter((a) => a >= 10_000).sort((a, b) => a - b);
  const monthly = amounts
    .filter((a) => a >= 1_000 && a < 10_000)
    .sort((a, b) => a - b);
  const perSqft = amounts.filter((a) => a < 1_000).sort((a, b) => a - b);

  const fmt = (n: number) =>
    `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return periodLabels.map((period, i) => {
    const entry: RentEntry = { period };
    if (i < annual.length) entry.annualBaseRent = fmt(annual[i]);
    if (i < monthly.length) entry.monthlyInstallment = fmt(monthly[i]);
    if (i < perSqft.length) entry.perSquareFoot = fmt(perSqft[i]);
    return entry;
  });
}

async function fetchBlob(blobUrl: string): Promise<Buffer> {
  const url = new URL(blobUrl);
  if (!url.hostname.endsWith(".vercel-storage.com")) {
    throw new Error("Invalid blob URL. Must be a Vercel Blob URL.");
  }
  const resp = await fetch(blobUrl);
  if (!resp.ok) {
    throw new Error(`Failed to fetch blob: ${resp.status} ${resp.statusText}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const { blobUrl } = req.body as { blobUrl?: string };
  if (!blobUrl) {
    return res.status(400).json({
      error: "JSON body must include 'blobUrl'. Upload the file first via /api/upload-pdf.",
    });
  }

  let fileData: Buffer;
  let fileName: string;
  try {
    fileData = await fetchBlob(blobUrl);
    fileName = new URL(blobUrl).pathname.split("/").pop() || "document.pdf";
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(502).json({ error: message });
  }

  if (!fileName.toLowerCase().endsWith(".pdf")) {
    return res.status(400).json({ error: "Only PDF files are accepted." });
  }

  try {
    const pdfData = await pdfParse(fileData);
    const rentAmounts = extractRentAmounts(pdfData.text);

    return res.status(200).json({
      fileName,
      totalPages: pdfData.numpages,
      rentAmounts,
    });
  } catch (err) {
    console.error("PDF parse error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
}
