const express=require("express");
const path=require("path");
const app=express();
const port=process.env.PORT||3000;
app.use(express.json({limit:"2mb"}));
app.use(express.static(path.join(__dirname,"public")));
app.get("/health",(_req,res)=>res.json({ok:true,service:"vendedor-autonomo-nfc",isolated:true}));
app.get("/api/status",(_req,res)=>res.json({
  ok:true,
  isolated:true,
  agent:"setup",
  integrations:{
    whatsapp:Boolean(process.env.META_ACCESS_TOKEN&&process.env.META_PHONE_NUMBER_ID&&process.env.META_VERIFY_TOKEN&&process.env.META_APP_SECRET),
    ai:Boolean(process.env.AI_API_KEY&&process.env.AI_BASE_URL&&process.env.AI_MODEL),
    leads:Boolean(process.env.GOOGLE_PLACES_API_KEY),
    woovi:Boolean(process.env.WOOVI_APP_ID),
    database:Boolean(process.env.DATABASE_URL),
    autoReply:String(process.env.AGENT_AUTOREPLY||"").toLowerCase()==="true"
  }
}));
app.get("/{*splat}",(_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(port,"0.0.0.0",()=>console.log("Vendedor NFC independente na porta "+port));
