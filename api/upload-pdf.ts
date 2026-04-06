import type { VercelRequest, VercelResponse } from "@vercel/node";
import { put } from "@vercel/blob";
import Busboy from "busboy";

interface ParsedFile {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
}

function parseMultipart(req: VercelRequest): Promise<ParsedFile> {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: req.headers as Record<string, string>,
      limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
    });

    let fileBuffer: Buffer | null = null;
    let fileName = "";
    let mimeType = "";

    busboy.on("file", (_fieldname, file, info) => {
      const chunks: Buffer[] = [];
      fileName = info.filename;
      mimeType = info.mimeType;
      file.on("data", (chunk: Buffer) => chunks.push(chunk));
      file.on("end", () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });

    busboy.on("finish", () => {
      if (!fileBuffer) {
        return reject(new Error("No file uploaded"));
      }
      resolve({ buffer: fileBuffer, fileName, mimeType });
    });

    busboy.on("error", reject);
    req.pipe(busboy);
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  try {
    const { buffer, fileName, mimeType } = await parseMultipart(req);

    if (!fileName.toLowerCase().endsWith(".pdf")) {
      return res.status(400).json({ error: "Only PDF files are accepted." });
    }

    const blob = await put(fileName, buffer, {
      access: "public",
      contentType: mimeType || "application/pdf",
    });

    return res.status(200).json({
      url: blob.url,
      fileName,
      size: buffer.length,
    });
  } catch (err) {
    console.error("Upload error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
}
