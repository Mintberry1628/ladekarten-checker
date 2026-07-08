// Mini-Server nur für die lokale Vorschau/Entwicklung — für den Betrieb NICHT nötig.
const http = require("http"), fs = require("fs"), path = require("path");
http.createServer((req, res) => {
  let p = req.url.split("?")[0];
  if (p === "/") p = "/index.html";
  const f = path.join(__dirname, p);
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); res.end("404"); return; }
    const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }[path.extname(f)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(d);
  });
}).listen(8873, () => console.log("Vorschau: http://localhost:8873"));
