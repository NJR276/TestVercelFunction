import type { VercelRequest, VercelResponse } from "@vercel/node";
import Busboy from "busboy";
import pdfParse from "pdf-parse";

interface ParsedFile {
  buffer: Buffer;
  fileName: string;
}

interface RentEntry {
  period: string;
  annualBaseRent?: string;
  monthlyInstallment?: string;
  perSquareFoot?: string;
}

function parseMultipart(req: VercelRequest): Promise<ParsedFile> {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: req.headers as Record<string, string>,
      limits: { fileSize: 4 * 1024 * 1024 }, // 4 MB
    });

    let fileBuffer: Buffer | null = null;
    let fileName = "";

    busboy.on("file", (_fieldname, file, info) => {
      const chunks: Buffer[] = [];
      fileName = info.filename;
      file.on("data", (chunk: Buffer) => chunks.push(chunk));
      file.on("end", () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });

    busboy.on("finish", () => {
      if (!fileBuffer) {
        return reject(new Error("No file uploaded"));
      }
      resolve({ buffer: fileBuffer, fileName });
    });

    busboy.on("error", reject);
    req.pipe(busboy);
  });
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

  const contentType = req.headers["content-type"] || "";
  let fileData: Buffer | null = null;
  let fileName = "";

  // Option 1: JSON body with blobUrl (for large files stored in Vercel Blob)
  if (contentType.includes("application/json")) {
    const { blobUrl } = req.body as { blobUrl?: string };
    if (!blobUrl) {
      return res.status(400).json({ error: "JSON body must include 'blobUrl'." });
    }
    try {
      fileData = await fetchBlob(blobUrl);
      fileName = new URL(blobUrl).pathname.split("/").pop() || "document.pdf";
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(502).json({ error: message });
    }
  }
  // Option 2: Multipart upload (for small files under 4 MB)
  else if (contentType.includes("multipart/form-data")) {
    const contentLength = parseInt(req.headers["content-length"] || "0", 10);
    if (contentLength > 4_000_000) {
      return res.status(413).json({
        error: "File too large for direct upload. Use /api/upload-pdf first, then pass the blobUrl.",
        uploadEndpoint: "/api/upload-pdf",
      });
    }
    try {
      const parsed = await parseMultipart(req);
      fileData = parsed.buffer;
      fileName = parsed.fileName;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(400).json({ error: message });
    }
  } else {
    return res.status(400).json({
      error: "Use multipart/form-data with a PDF file, or application/json with a blobUrl.",
    });
  }

  if (!fileData) {
    return res.status(400).json({ error: "No file uploaded" });
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
