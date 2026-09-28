const express=require("express");
const path=require("path");
const crypto=require("crypto");
const {Pool}=require("pg");

const app=express();
const port=process.env.PORT||3000;
const env=(n)=>(process.env[n]||"").trim();
const sessionName=()=>env("WAHA_SESSION_NAME")||"vendedor-nfc";
const wahaBase=()=>env("WAHA_API_BASE_URL").replace(/\/$/,"");
const autoReply=()=>env("AGENT_AUTOREPLY").toLowerCase()==="true";
const aiReady=()=>Boolean(env("AI_API_KEY")&&env("AI_BASE_URL")&&env("AI_MODEL"));
const shippingReady=()=>Boolean(
  env("MELHOR_ENVIO_TOKEN") &&
  env("SHIP_FROM_POSTAL_CODE") &&
  env("SHIP_WIDTH_CM") &&
  env("SHIP_HEIGHT_CM") &&
  env("SHIP_LENGTH_CM") &&
  env("SHIP_WEIGHT_KG")
);

function cleanPostalCode(value){
  return String(value||"").replace(/\D/g,"").slice(0,8);
}

function extractPostalCode(text){
  const m=String(text||"").match(/\b\d{5}[-. ]?\d{3}\b/);
  return m?cleanPostalCode(m[0]):"";
}

function shippingConfig(){
  return {
    base:(env("MELHOR_ENVIO_BASE_URL")||"https://melhorenvio.com.br").replace(/\/$/,""),
    token:env("MELHOR_ENVIO_TOKEN"),
    userAgent:env("MELHOR_ENVIO_USER_AGENT"),
    from:cleanPostalCode(env("SHIP_FROM_POSTAL_CODE")),
    width:Number(env("SHIP_WIDTH_CM")),
    height:Number(env("SHIP_HEIGHT_CM")),
    length:Number(env("SHIP_LENGTH_CM")),
    weight:Number(env("SHIP_WEIGHT_KG")),
    insurance:Number(env("SALES_PRODUCT_PRICE")||79.90)
  };
}

async function quoteShipping(toPostalCode){
  if(!shippingReady()) throw new Error("shipping_not_configured");
  const cfg=shippingConfig();
  if(!/^\d{8}$/.test(toPostalCode)) throw new Error("invalid_postal_code");
  if(!cfg.userAgent || !cfg.userAgent.includes("@")) throw new Error("shipping_user_agent_missing_email");

  const response=await fetch(cfg.base+"/api/v2/me/shipment/calculate",{
    method:"POST",
    headers:{
      "Accept":"application/json",
      "Content-Type":"application/json",
      "Authorization":"Bearer "+cfg.token,
      "User-Agent":cfg.userAgent
    },
    body:JSON.stringify({
      from:{postal_code:cfg.from},
      to:{postal_code:toPostalCode},
      products:[{
        id:"placa-nfc",
        width:cfg.width,
        height:cfg.height,
        length:cfg.length,
        weight:cfg.weight,
        insurance_value:cfg.insurance,
        quantity:1
      }],
      options:{receipt:false,own_hand:false}
    }),
    signal:AbortSignal.timeout(20000)
  });

  const raw=await response.text();
  let data;
  try{data=JSON.parse(raw);}catch{data=null;}
  if(!response.ok) throw new Error("melhor_envio_"+response.status+":"+raw.slice(0,220));

  const list=Array.isArray(data)?data:[];
  const valid=list
    .filter(x=>x && !x.error && (x.custom_price||x.price))
    .map(x=>({
      id:x.id,
      name:x.name||"",
      company:x.company?.name||"",
      price:Number(x.custom_price||x.price),
      deliveryTime:Number(x.custom_delivery_time||x.delivery_time||0),
      rawDeliveryTime:Number(x.delivery_time||0)
    }))
    .filter(x=>Number.isFinite(x.price)&&x.price>0);

  valid.sort((a,b)=>a.price-b.price || a.deliveryTime-b.deliveryTime);
  const cheapest=valid[0]||null;
  const fastest=[...valid].sort((a,b)=>(a.deliveryTime||9999)-(b.deliveryTime||9999)||a.price-b.price)[0]||null;
  return {toPostalCode,options:valid.slice(0,10),cheapest,fastest};
}


const pool=new Pool({
  connectionString:env("DATABASE_URL"),
  max:5,
  idleTimeoutMillis:30000,
  connectionTimeoutMillis:10000
});

const queues=new Map();

app.use(express.json({
  limit:"5mb",
  verify:(req,_res,buf)=>{req.rawBody=buf;}
}));
app.use(express.static(path.join(__dirname,"public")));

async function migrate(){
  await pool.query(`
    create table if not exists sales_contacts(
      chat_id text primary key,
      display_name text,
      phone text,
      stage text not null default 'novo',
      status text not null default 'ativo',
      opted_out boolean not null default false,
      agent_enabled boolean not null default false,
      first_seen_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      last_inbound_at timestamptz,
      last_outbound_at timestamptz,
      notes text,
      metadata jsonb not null default '{}'::jsonb
    );
    create table if not exists sales_messages(
      id bigserial primary key,
      provider_message_id text unique,
      chat_id text not null references sales_contacts(chat_id) on delete cascade,
      direction text not null check(direction in ('inbound','outbound')),
      body text not null,
      source text not null default 'waha',
      created_at timestamptz not null default now(),
      metadata jsonb not null default '{}'::jsonb
    );
    create index if not exists sales_messages_chat_created_idx
      on sales_messages(chat_id,created_at desc);
    create table if not exists sales_events(
      id bigserial primary key,
      event_type text not null,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    alter table sales_contacts add column if not exists agent_enabled boolean not null default false;
  `);
}

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
        config:{ignore:{status:true,broadcast:true,channels:true,groups:true}}
      })
    });
    if(!create.ok&&create.status!==422) throw new Error("waha_create_"+create.status);
  }
  current=await getSession().catch(()=>null);
  if(!current) throw new Error("waha_session_unavailable");
  if(!["WORKING","STARTING","SCAN_QR_CODE"].includes(current.status)){
    const start=await waha("/api/sessions/"+encodeURIComponent(sessionName())+"/start",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:"{}"
    });
    if(!start.ok&&start.status!==422) throw new Error("waha_start_"+start.status);
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

function isPrivateChat(chatId){
  return Boolean(chatId)&&!chatId.endsWith("@g.us")&&!chatId.includes("status@broadcast")&&!chatId.endsWith("@newsletter");
}

function normalizePhone(chatId){
  return String(chatId||"").split("@")[0].split(":")[0].replace(/\D/g,"");
}

function displayName(payload){
  return payload?.pushName||payload?.notifyName||payload?._data?.notifyName||payload?._data?.pushName||null;
}

async function ensureContact(chatId,payload={}){
  const phone=normalizePhone(chatId);
  const name=displayName(payload);
  await pool.query(`
    insert into sales_contacts(chat_id,display_name,phone,stage,status,last_seen_at,last_inbound_at,metadata)
    values($1,$2,$3,'conversa','ativo',now(),now(),$4::jsonb)
    on conflict(chat_id) do update set
      display_name=coalesce(excluded.display_name,sales_contacts.display_name),
      phone=coalesce(nullif(excluded.phone,''),sales_contacts.phone),
      last_seen_at=now(),
      last_inbound_at=now(),
      stage=case when sales_contacts.stage='novo' then 'conversa' else sales_contacts.stage end
  `,[chatId,name,phone,JSON.stringify({source:"waha"})]);
}

async function saveMessage({providerId,chatId,direction,body,metadata={}}){
  const result=await pool.query(`
    insert into sales_messages(provider_message_id,chat_id,direction,body,metadata)
    values($1,$2,$3,$4,$5::jsonb)
    on conflict(provider_message_id) do nothing
    returning id
  `,[providerId||null,chatId,direction,body,JSON.stringify(metadata)]);
  return result.rowCount===1;
}

async function recentHistory(chatId,limit=20){
  const {rows}=await pool.query(`
    select direction,body,created_at
    from sales_messages
    where chat_id=$1
    order by created_at desc
    limit $2
  `,[chatId,limit]);
  return rows.reverse();
}

function systemPrompt(){
  const product=env("SALES_PRODUCT_NAME")||"placa NFC para facilitar avaliações no Google";
  const price=env("SALES_PRODUCT_PRICE")||"NÃO CONFIGURADO";
  const minPrice=env("SALES_MIN_PRICE")||"59.90";
  const maxDiscount=env("SALES_MAX_DISCOUNT")||"20.00";
  const delivery=env("SALES_DELIVERY_INFO")||"NÃO CONFIGURADO";
  const proof=env("SALES_PROOF_INFO")||"NÃO CONFIGURADO";
  return [
    "Você é o Vendedor NFC, um vendedor humano-assistido por IA que atende pelo WhatsApp.",
    "Objetivo: entender o negócio, explicar a placa NFC, responder dúvidas e conduzir a conversa para uma próxima ação concreta.",
    "Produto: "+product+".",
    "Preço padrão da placa: R$ "+price+".",
    "Preço mínimo absoluto autorizado: R$ "+minPrice+". Nunca venda abaixo desse valor.",
    "Desconto/concessão máxima em reais: R$ "+maxDiscount+".",
    "Entrega: "+delivery+".",
    "Provas, fotos e vídeos disponíveis: "+proof+".",
    "Responda em português do Brasil, curto, natural, educado e sem linguagem robótica.",
    "Nunca invente preço, prazo, estoque, desconto, frete, instalação, garantia, depoimento ou resultado.",
    "Se preço ou entrega estiverem NÃO CONFIGURADOS, diga que precisa confirmar antes de informar.",
    "Para frete, nunca invente valor. Peça o CEP do cliente e use apenas a cotação real do Melhor Envio quando ela estiver disponível.",
    "Diferencie prazo de produção/postagem do prazo de transporte da transportadora.",
    "Não prometa aumento garantido de avaliações, vendas ou faturamento.",
    "Faça no máximo uma pergunta por mensagem quando precisar avançar a conversa.",
    "Não envie várias mensagens seguidas sem resposta do cliente.",
    "Se a pessoa pedir para parar, sair, remover o contato ou não receber mensagens, confirme brevemente e encerre.",
    "Se houver pedido fora das regras comerciais, diga que vai encaminhar para confirmação humana."
  ].join("\n");
}

async function generateReply(chatId){
  const history=await recentHistory(chatId,24);
  let shippingContext="";
  const lastInbound=[...history].reverse().find(m=>m.direction==="inbound");
  const cep=extractPostalCode(lastInbound?.body||"");
  if(cep && shippingReady()){
    try{
      const quote=await quoteShipping(cep);
      const cheapest=quote.cheapest;
      const fastest=quote.fastest;
      if(cheapest){
        shippingContext="\nCOTAÇÃO REAL DE FRETE PARA O CEP "+cep+
          ": opção mais barata "+cheapest.company+" "+cheapest.name+
          " por R$ "+cheapest.price.toFixed(2).replace(".",",")+
          (cheapest.deliveryTime?" com prazo estimado de "+cheapest.deliveryTime+" dia(s) úteis de transporte":"")+".";
        if(fastest && fastest.id!==cheapest.id){
          shippingContext+=" Opção mais rápida: "+fastest.company+" "+fastest.name+
            " por R$ "+fastest.price.toFixed(2).replace(".",",")+
            (fastest.deliveryTime?" com prazo estimado de "+fastest.deliveryTime+" dia(s) úteis de transporte":"")+".";
        }
        shippingContext+=" Esses prazos são de transporte e devem ser informados separadamente do prazo de produção/postagem.";
      }
    }catch(error){
      console.error("shipping_quote_error",String(error?.message||error).slice(0,250));
      shippingContext="\nO cliente informou CEP "+cep+", mas a cotação automática de frete não está disponível neste momento. Não invente valor; diga que vai consultar.";
    }
  }
  const messages=[
    {role:"system",content:systemPrompt()+shippingContext},
    ...history.map(m=>({
      role:m.direction==="inbound"?"user":"assistant",
      content:m.body
    }))
  ];
  const base=env("AI_BASE_URL").replace(/\/$/,"");
  const response=await fetch(base+"/chat/completions",{
    method:"POST",
    headers:{
      "Authorization":"Bearer "+env("AI_API_KEY"),
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      model:env("AI_MODEL"),
      temperature:0.35,
      messages
    }),
    signal:AbortSignal.timeout(30000)
  });
  if(!response.ok){
    const body=await response.text();
    throw new Error("ai_"+response.status+":"+body.slice(0,240));
  }
  const data=await response.json();
  const text=data?.choices?.[0]?.message?.content?.trim();
  if(!text) throw new Error("ai_empty_reply");
  return text.slice(0,4000);
}

async function sendText(chatId,text){
  const res=await waha("/api/sendText",{
    method:"POST",
    headers:{"Content-Type":"application/json","Accept":"application/json"},
    body:JSON.stringify({
      session:sessionName(),
      chatId,
      text,
      linkPreview:false
    })
  });
  const raw=await res.text();
  if(!res.ok) throw new Error("waha_send_"+res.status+":"+raw.slice(0,200));
  let data={};
  try{data=JSON.parse(raw);}catch{}
  return data;
}

function wantsOptOut(text){
  const v=String(text||"").toLowerCase();
  return /\b(parar|pare|sair|remover|remova|cancelar|não me chame|nao me chame|não mande|nao mande|stop)\b/i.test(v);
}

async function processInbound(payload,eventId){
  const chatId=String(payload?.from||payload?._data?.key?.remoteJid||"");
  const fromMe=Boolean(payload?.fromMe||payload?._data?.key?.fromMe);
  const body=String(payload?.body||payload?.text?.body||"").trim();
  const providerId=String(payload?.id||payload?._data?.key?.id||eventId||crypto.randomUUID());

  if(fromMe||!isPrivateChat(chatId)||!body) return;

  await ensureContact(chatId,payload);
  const inserted=await saveMessage({
    providerId,
    chatId,
    direction:"inbound",
    body,
    metadata:{timestamp:payload?.timestamp||null}
  });
  if(!inserted) return;

  if(wantsOptOut(body)){
    await pool.query("update sales_contacts set opted_out=true,status='optout',last_seen_at=now() where chat_id=$1",[chatId]);
    if(autoReply()){
      const confirmation="Tudo certo. Não enviarei novas mensagens por aqui.";
      const sent=await sendText(chatId,confirmation);
      await saveMessage({
        providerId:String(sent?.id||crypto.randomUUID()),
        chatId,
        direction:"outbound",
        body:confirmation,
        metadata:{reason:"optout_confirmation"}
      });
    }
    return;
  }

  const {rows:[contact]}=await pool.query("select opted_out,agent_enabled from sales_contacts where chat_id=$1",[chatId]);
  if(contact?.opted_out||!contact?.agent_enabled||!autoReply()||!aiReady()) return;

  const previous=queues.get(chatId)||Promise.resolve();
  const next=previous.then(async()=>{
    const reply=await generateReply(chatId);
    const delay=Math.min(Math.max(Number(env("AGENT_REPLY_DELAY_MS")||1200),0),8000);
    if(delay) await new Promise(r=>setTimeout(r,delay));
    const sent=await sendText(chatId,reply);
    await saveMessage({
      providerId:String(sent?.id||crypto.randomUUID()),
      chatId,
      direction:"outbound",
      body:reply,
      metadata:{model:env("AI_MODEL")}
    });
    await pool.query("update sales_contacts set last_outbound_at=now(),last_seen_at=now() where chat_id=$1",[chatId]);
  }).catch(err=>{
    console.error("agent_reply_error",String(err?.message||err).slice(0,500));
  }).finally(()=>{
    if(queues.get(chatId)===next) queues.delete(chatId);
  });
  queues.set(chatId,next);
}

app.get("/health",async(_req,res)=>{
  let db=false,wahaOk=false;
  try{await pool.query("select 1");db=true;}catch{}
  try{const r=await waha("/api/server/version");wahaOk=r.ok;}catch{}
  res.status(db?200:503).json({ok:db,service:"vendedor-autonomo-nfc",database:db,waha:wahaOk});
});

app.get("/api/status",async(_req,res)=>{
  let session=null,wahaReachable=false,database=false;
  try{await pool.query("select 1");database=true;}catch{}
  try{
    const r=await waha("/api/server/version");
    wahaReachable=r.ok;
    if(wahaReachable) session=await getSession();
  }catch{}
  const whatsapp=session?.status==="WORKING";
  res.json({
    ok:true,
    isolated:true,
    agent:whatsapp&&database&&aiReady()&&autoReply()?"active":"setup",
    integrations:{
      whatsapp,
      waha:wahaReachable,
      ai:aiReady(),
      leads:Boolean(env("GOOGLE_PLACES_API_KEY")),
      woovi:Boolean(env("WOOVI_APP_ID")),
      shipping:shippingReady(),
      database,
      autoReply:autoReply()
    },
    whatsappSession:session?{name:session.name,status:session.status,me:session.me||null}:null
  });
});

app.post("/api/shipping/quote",async(req,res)=>{
  const postalCode=cleanPostalCode(req.body?.postalCode||req.body?.cep||"");
  if(!/^\d{8}$/.test(postalCode)){
    return res.status(400).json({ok:false,error:"invalid_postal_code"});
  }
  try{
    const quote=await quoteShipping(postalCode);
    res.json({ok:true,...quote});
  }catch(error){
    const message=String(error?.message||error);
    const status=message==="shipping_not_configured"||message==="shipping_user_agent_missing_email"?503:502;
    res.status(status).json({ok:false,error:message.slice(0,300)});
  }
});

app.get("/api/contacts",async(req,res)=>{
  const limit=Math.min(Math.max(Number(req.query.limit)||50,1),200);
  const {rows}=await pool.query(`
    select c.*,
      (select body from sales_messages m where m.chat_id=c.chat_id order by created_at desc limit 1) as last_message
    from sales_contacts c
    order by c.last_seen_at desc
    limit $1
  `,[limit]);
  res.json({ok:true,contacts:rows});
});

app.post("/api/contacts/:chatId/agent",async(req,res)=>{
  const enabled=Boolean(req.body?.enabled);
  const result=await pool.query(
    "update sales_contacts set agent_enabled=$2,last_seen_at=now() where chat_id=$1 returning chat_id,agent_enabled",
    [req.params.chatId,enabled]
  );
  if(!result.rowCount) return res.status(404).json({ok:false,error:"contact_not_found"});
  res.json({ok:true,contact:result.rows[0]});
});

app.get("/api/contacts/:chatId/messages",async(req,res)=>{
  const limit=Math.min(Math.max(Number(req.query.limit)||80,1),200);
  const {rows}=await pool.query(`
    select provider_message_id,direction,body,created_at
    from sales_messages
    where chat_id=$1
    order by created_at desc
    limit $2
  `,[req.params.chatId,limit]);
  res.json({ok:true,messages:rows.reverse()});
});

app.post("/api/messages/send",async(req,res)=>{
  const chatId=String(req.body?.chatId||"");
  const text=String(req.body?.text||"").trim();
  if(!isPrivateChat(chatId)||!text) return res.status(400).json({ok:false,error:"invalid_message"});
  await ensureContact(chatId,{});
  const sent=await sendText(chatId,text);
  await saveMessage({
    providerId:String(sent?.id||crypto.randomUUID()),
    chatId,
    direction:"outbound",
    body:text,
    metadata:{manual:true}
  });
  await pool.query("update sales_contacts set last_outbound_at=now(),last_seen_at=now() where chat_id=$1",[chatId]);
  res.json({ok:true});
});

app.post("/api/agent/test-ai",async(_req,res)=>{
  if(!aiReady()) return res.status(503).json({ok:false,error:"ai_not_configured"});
  try{
    const base=env("AI_BASE_URL").replace(/\/$/,"");
    const response=await fetch(base+"/chat/completions",{
      method:"POST",
      headers:{"Authorization":"Bearer "+env("AI_API_KEY"),"Content-Type":"application/json"},
      body:JSON.stringify({model:env("AI_MODEL"),messages:[{role:"user",content:"Responda somente OK"}],temperature:0}),
      signal:AbortSignal.timeout(20000)
    });
    res.status(response.ok?200:502).json({ok:response.ok,status:response.status});
  }catch(error){
    res.status(502).json({ok:false,error:String(error?.message||error)});
  }
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
  res.sendStatus(200);

  if(event==="session.status"){
    console.log(JSON.stringify({event:"waha_session_status",status:req.body?.payload?.status||null}));
    return;
  }
  if(event==="message"){
    processInbound(req.body?.payload||{},req.body?.id||req.get("x-webhook-request-id")||"")
      .catch(err=>console.error("waha_inbound_error",String(err?.message||err).slice(0,500)));
  }
});

app.get("/{*splat}",(_req,res)=>{
  res.sendFile(path.join(__dirname,"public","index.html"));
});

async function selfTestAi(){
  if(env("AI_SELFTEST_ON_BOOT").toLowerCase()!=="true") return;
  if(!aiReady()){
    console.log(JSON.stringify({event:"ai_selftest",ok:false,error:"not_configured"}));
    return;
  }
  try{
    const base=env("AI_BASE_URL").replace(/\/$/,"");
    const response=await fetch(base+"/chat/completions",{
      method:"POST",
      headers:{
        "Authorization":"Bearer "+env("AI_API_KEY"),
        "Content-Type":"application/json"
      },
      body:JSON.stringify({
        model:env("AI_MODEL"),
        temperature:0,
        max_tokens:8,
        messages:[{role:"user",content:"Responda apenas OK"}]
      }),
      signal:AbortSignal.timeout(20000)
    });
    console.log(JSON.stringify({event:"ai_selftest",ok:response.ok,status:response.status}));
  }catch(error){
    console.log(JSON.stringify({event:"ai_selftest",ok:false,error:String(error?.message||error).slice(0,120)}));
  }
}

async function boot(){
  await migrate();
  await selfTestAi();
  app.listen(port,"0.0.0.0",()=>{
    console.log("Vendedor NFC autônomo na porta "+port);
    setTimeout(()=>{
      ensureSession()
        .then(s=>console.log(JSON.stringify({event:"waha_session_boot",status:s?.status||null})))
        .catch(e=>console.error("waha_session_boot_error",String(e?.message||e)));
    },2500);
  });
}

boot().catch(err=>{
  console.error("boot_error",err);
  process.exit(1);
});
