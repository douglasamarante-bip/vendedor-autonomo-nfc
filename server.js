const express = require("express");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "vendedor-autonomo-nfc", version: "0.1.0" });
});

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    agent: "setup",
    integrations: {
      whatsapp: false,
      leads: false,
      ai: false,
      woovi: false,
      database: false
    }
  });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Vendedor Autonomo NFC ouvindo na porta ${port}`);
});
