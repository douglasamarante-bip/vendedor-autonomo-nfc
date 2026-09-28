const express=require("express");
const path=require("path");
const crypto=require("crypto");

const app=express();
const port=process.env.PORT||3000;
const env=(n)=>(process.env[n]||"").trim();
const sessionName=()=>env("WAHA_SESSION_NAME")||"vendedor-nfc";
const wahaBase=()=>env("WAHA_API_BASE_URL").replace(/\/$/,"");

app.use(express.json({
  limit:"5mb",
  verify:(req,_res,buf)=>{req.rawBody=buf;}
}));
app.use(express.static(path.join(__dirname,"public")));

async function waha(pathname,init={}){
  const res=await fetch(wahaBase()+pathname,{
    ...init,
    headers:{
      "X-Api-Key":env("WAHA_API_KEY"),
      ...(init.headers||{})
    },
    signal:AbortSignal.timeout(15000)
  });
  return res;
}

async function getSession(){
  if(!env("WAHA_API_BASE_URL")||!env("WAHA_API_KEY")) return null;
  const res=await waha("/api/sessions/"+encodeURIComponent(sessionName()));
  if(res.status===404) return null;
  if(!res.ok) throw new Error("waha_session_"+res.status);
  return await res.json();
}

async function ensureSession(){
  let current=await getSession().catch(()=>null);
  if(!current){
    const create=await waha("/api/sessions",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        name:sessionName(),
        start:false,
        config:{
          ignore:{status:true,broadcast:true,channels:true,groups:true}
        }
      })
    });
    if(!create.ok && create.status!==422){
      throw new Error("waha_create_"+create.status);
    }
  }
  current=await getSession().catch(()=>null);
  if(!current) throw new Error("waha_session_unavailable");
  if(!["WORKING","STARTING","SCAN_QR_CODE"].includes(current.status)){
    const start=await waha("/api/sessions/"+encodeURIComponent(sessionName())+"/start",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:"{}"
    });
    if(!start.ok && start.status!==422){
      throw new Error("waha_start_"+start.status);
    }
  }
  return await getSession();
}

function verifyWahaHmac(req){
  const secret=env("WAHA_HMAC_SECRET");
  if(!secret||!req.rawBody) return false;
  const got=req.get("x-webhook-hmac")||"";
  const algorithm=(req.get("x-webhook-hmac-algorithm")||"sha512").toLowerCase();
  if(algorithm!=="sha512"||!got) return false;
  const expected=crypto.createHmac("sha512",secret).update(req.rawBody).digest("hex");
  const a=Buffer.from(got);
  const b=Buffer.from(expected);
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
}

app.get("/health",async(_req,res)=>{
  let wahaOk=false;
  try{
    const r=await waha("/api/server/version");
    wahaOk=r.ok;
  }catch{}
  res.json({ok:true,service:"vendedor-autonomo-nfc",isolated:true,waha:wahaOk});
});

app.get("/api/status",async(_req,res)=>{
  let session=null;
  let wahaReachable=false;
  try{
    const r=await waha("/api/server/version");
    wahaReachable=r.ok;
    if(wahaReachable) session=await getSession();
  }catch{}
  const whatsapp=session?.status==="WORKING";
  res.json({
    ok:true,
    isolated:true,
    agent:whatsapp?"whatsapp_connected":"setup",
    integrations:{
      whatsapp,
      waha:wahaReachable,
      ai:Boolean(env("AI_API_KEY")&&env("AI_BASE_URL")&&env("AI_MODEL")),
      leads:Boolean(env("GOOGLE_PLACES_API_KEY")),
      woovi:Boolean(env("WOOVI_APP_ID")),
      database:Boolean(env("DATABASE_URL")),
      autoReply:String(env("AGENT_AUTOREPLY")).toLowerCase()==="true"
    },
    whatsappSession:session?{name:session.name,status:session.status}:null
  });
});

app.get("/api/waha/status",async(_req,res)=>{
  try{
    const session=await getSession();
    res.json({ok:true,session:session?{name:session.name,status:session.status,me:session.me||null}:null});
  }catch(error){
    res.status(502).json({ok:false,error:String(error.message||error)});
  }
});

app.post("/api/waha/connect",async(_req,res)=>{
  try{
    const session=await ensureSession();
    res.json({ok:true,session:{name:session.name,status:session.status}});
  }catch(error){
    res.status(502).json({ok:false,error:String(error.message||error)});
  }
});

app.get("/api/waha/qr",async(_req,res)=>{
  try{
    const session=await getSession();
    if(!session) return res.status(404).json({ok:false,error:"session_not_found"});
    if(session.status==="WORKING") return res.json({ok:true,working:true});
    const qr=await waha("/api/"+encodeURIComponent(sessionName())+"/auth/qr?format=image",{
      headers:{"Accept":"application/json"}
    });
    const body=await qr.text();
    res.status(qr.status).type("application/json").send(body);
  }catch(error){
    res.status(502).json({ok:false,error:String(error.message||error)});
  }
});

app.post("/webhooks/waha",(req,res)=>{
  if(!verifyWahaHmac(req)) return res.sendStatus(401);
  const event=req.body?.event||"unknown";
  const session=req.body?.session||"";
  if(session!==sessionName()) return res.sendStatus(202);
  if(event==="session.status"){
    console.log(JSON.stringify({event:"waha_session_status",status:req.body?.payload?.status||null}));
  }else if(event==="message"){
    const payload=req.body?.payload||{};
    const fromMe=Boolean(payload?.fromMe||payload?._data?.key?.fromMe);
    const from=String(payload?.from||payload?._data?.key?.remoteJid||"");
    if(!fromMe && from && !from.endsWith("@g.us") && !from.includes("status@broadcast")){
      console.log(JSON.stringify({event:"waha_inbound_message",accepted:true}));
    }
  }
  res.sendStatus(200);
});

app.get("/{*splat}",(_req,res)=>{
  res.sendFile(path.join(__dirname,"public","index.html"));
});

app.listen(port,"0.0.0.0",()=>{
  console.log("Vendedor NFC + WAHA na porta "+port);
  setTimeout(()=>{
    ensureSession()
      .then(s=>console.log(JSON.stringify({event:"waha_session_boot",status:s?.status||null})))
      .catch(e=>console.error("waha_session_boot_error",String(e?.message||e)));
  },3000);
});
