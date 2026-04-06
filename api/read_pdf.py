import json
import io
from http.server import BaseHTTPRequestHandler
from PyPDF2 import PdfReader


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_type = self.headers.get("Content-Type", "")

        if "multipart/form-data" not in content_type:
            self._send_json(400, {"error": "Content-Type must be multipart/form-data"})
            return

        # Parse boundary from content type
        boundary = None
        for part in content_type.split(";"):
            part = part.strip()
            if part.startswith("boundary="):
                boundary = part[len("boundary="):]
                break

        if not boundary:
            self._send_json(400, {"error": "No boundary found in Content-Type"})
            return

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        # Parse the multipart data
        file_data, file_name = self._parse_multipart(body, boundary)

        if file_data is None:
            self._send_json(400, {"error": "No file uploaded"})
            return

        if not file_name.lower().endswith(".pdf"):
            self._send_json(400, {"error": "Only PDF files are accepted."})
            return

        try:
            reader = PdfReader(io.BytesIO(file_data))
            total_pages = len(reader.pages)
            text = "\n".join(page.extract_text() or "" for page in reader.pages)

            self._send_json(200, {
                "fileName": file_name,
                "totalPages": total_pages,
                "text": text,
            })
        except Exception as e:
            self._send_json(500, {"error": str(e)})

    def do_GET(self):
        self._send_json(405, {"error": "Method not allowed. Use POST."})

    def _parse_multipart(self, body, boundary):
        boundary_bytes = f"--{boundary}".encode()
        parts = body.split(boundary_bytes)

        for part in parts:
            if b"Content-Disposition" not in part:
                continue

            header_end = part.find(b"\r\n\r\n")
            if header_end == -1:
                continue

            headers_raw = part[:header_end].decode("utf-8", errors="replace")
            file_data = part[header_end + 4:]

            # Strip trailing \r\n-- 
            if file_data.endswith(b"\r\n"):
                file_data = file_data[:-2]
            if file_data.endswith(b"--"):
                file_data = file_data[:-2]
            if file_data.endswith(b"\r\n"):
                file_data = file_data[:-2]

            # Extract filename
            file_name = None
            for line in headers_raw.split("\r\n"):
                if "filename=" in line:
                    start = line.index('filename="') + len('filename="')
                    end = line.index('"', start)
                    file_name = line[start:end]
                    break

            if file_name:
                return file_data, file_name

        return None, None

    def _send_json(self, status, data):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())
