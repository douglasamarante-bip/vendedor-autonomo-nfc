const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({
  limit: "2mb",
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.static(path.join(__dirname, "public")));

const env = (name) => (process.env[name] || "").trim();
const has = (name) => Boolean(env(name));

function integrationStatus() {
  const whatsapp = has("META_ACCESS_TOKEN") && has("META_PHONE_NUMBER_ID") && has("META_VERIFY_TOKEN");
  const whatsappSignature = has("META_APP_SECRET");
  const ai = has("AI_API_KEY") && has("AI_BASE_URL") && has("AI_MODEL");
  const leads = has("GOOGLE_PLACES_API_KEY");
  const woovi = has("WOOVI_APP_ID");
  const database = has("DATABASE_URL");
  const autoReply = env("AGENT_AUTOREPLY").toLowerCase() === "true";

  return {
    whatsapp,
    whatsappSignature,
    ai,
    leads,
    woovi,
    database,
    autoReply,
    readyForInboundSales: whatsapp && ai && autoReply
  };
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "vendedor-autonomo-nfc",
    version: "0.2.0",
    time: new Date().toISOString()
  });
});

app.get("/api/status", (_req, res) => {
  const integrations = integrationStatus();
  const missing = [];

  if (!integrations.whatsapp) missing.push("WhatsApp Business Platform");
  if (!integrations.whatsappSignature) missing.push("Meta App Secret");
  if (!integrations.ai) missing.push("IA");
  if (!integrations.leads) missing.push("Busca de leads");
  if (!integrations.woovi) missing.push("Woovi");
  if (!integrations.database) missing.push("Banco de dados");

  res.json({
    ok: true,
    agent: integrations.readyForInboundSales ? "ready" : "setup",
    integrations,
    missing
  });
});

function verifyMetaSignature(req) {
  const secret = env("META_APP_SECRET");
  if (!secret) return true;

  const signature = req.get("x-hub-signature-256") || "";
  if (!signature.startsWith("sha256=") || !req.rawBody) return false;

  const expected = "sha256=" + crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("hex");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.get("/webhooks/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === env("META_VERIFY_TOKEN")) {
    return res.status(200).send(challenge || "");
  }

  return res.sendStatus(403);
});

function extractInboundTextMessages(payload) {
  const messages = [];

  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      const contactName = value?.contacts?.[0]?.profile?.name || "";

      for (const message of value?.messages || []) {
        if (message?.type !== "text" || !message?.text?.body || !message?.from) continue;
        messages.push({
          from: message.from,
          text: message.text.body,
          messageId: message.id || "",
          contactName
        });
      }
    }
  }

  return messages;
}

function salesSystemPrompt() {
  const product = env("SALES_PRODUCT_NAME") || "placa NFC para avaliações no Google";
  const price = env("SALES_PRODUCT_PRICE") || "não configurado";
  const maxDiscount = env("SALES_MAX_DISCOUNT") || "0";
  const delivery = env("SALES_DELIVERY_INFO") || "confirmar manualmente antes de prometer prazo";

  return [
    "Você é um atendente comercial de WhatsApp.",
    `Produto: ${product}.`,
    `Preço configurado: ${price}.`,
    `Desconto máximo autorizado: ${maxDiscount}.`,
    `Entrega: ${delivery}.`,
    "Converse em português do Brasil, de forma curta, natural e profissional.",
    "Não invente preço, prazo, estoque, desconto, instalação, garantia, depoimentos ou resultados.",
    "Não prometa aumento de avaliações nem qualquer resultado garantido.",
    "Responda dúvidas, explique o produto, trate objeções e conduza para o fechamento sem pressionar.",
    "Se faltar informação comercial necessária, diga que vai confirmar em vez de inventar.",
    "Nunca peça senha, código de autenticação, dados bancários completos ou informação sensível.",
    "Se o cliente pedir para não receber mais mensagens, confirme e encerre a conversa."
  ].join("\n");
}

async function generateSalesReply(message, contactName) {
  const base = env("AI_BASE_URL").replace(/\/$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env("AI_API_KEY")}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env("AI_MODEL"),
      temperature: 0.4,
      messages: [
        { role: "system", content: salesSystemPrompt() },
        {
          role: "user",
          content: contactName
            ? `Cliente: ${contactName}\nMensagem: ${message}`
            : message
        }
      ]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AI provider returned ${response.status}: ${body.slice(0, 400)}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("AI provider returned an empty reply");
  return text;
}

async function sendWhatsAppText(to, text) {
  const version = env("META_GRAPH_VERSION") || "v23.0";
  const phoneNumberId = env("META_PHONE_NUMBER_ID");
  const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env("META_ACCESS_TOKEN")}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: text }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`WhatsApp returned ${response.status}: ${body.slice(0, 400)}`);
  }

  return response.json();
}

app.post("/webhooks/whatsapp", async (req, res) => {
  if (!verifyMetaSignature(req)) return res.sendStatus(401);

  // A Meta espera resposta rápida do webhook.
  res.sendStatus(200);

  const status = integrationStatus();
  if (!status.readyForInboundSales) return;

  const messages = extractInboundTextMessages(req.body);

  for (const message of messages) {
    try {
      const reply = await generateSalesReply(message.text, message.contactName);
      await sendWhatsAppText(message.from, reply);
      console.log(JSON.stringify({
        event: "whatsapp_agent_reply",
        to: message.from,
        inboundMessageId: message.messageId
      }));
    } catch (error) {
      console.error("whatsapp_agent_error", error?.message || error);
    }
  }
});

app.post("/webhooks/woovi", (req, res) => {
  const event = req.body?.event || "unknown";
  const correlationID = req.body?.charge?.correlationID || null;
  const status = req.body?.charge?.status || null;

  console.log(JSON.stringify({
    event: "woovi_webhook",
    wooviEvent: event,
    correlationID,
    chargeStatus: status
  }));

  res.sendStatus(200);
});

app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Vendedor Autonomo NFC ouvindo na porta ${port}`);
});
