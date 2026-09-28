const express=require("express");
const path=require("path");
const crypto=require("crypto");
const {Pool}=require("pg");

const app=express();
const BUILD_VERSION="freight-v2";
const port=process.env.PORT||3000;
const env=(n)=>(process.env[n]||"").trim();
const sessionName=()=>env("WAHA_SESSION_NAME")||"vendedor-nfc";
const wahaBase=()=>env("WAHA_API_BASE_URL").replace(/\/$/,"");
const autoReply=()=>env("AGENT_AUTOREPLY").toLowerCase()==="true";
const aiReady=()=>Boolean(env("AI_API_KEY")&&env("AI_BASE_URL")&&env("AI_MODEL"));
const shippingConfigured=()=>Boolean(
  env("SHIP_FROM_POSTAL_CODE") &&
  env("SHIP_WIDTH_CM") &&
  env("SHIP_HEIGHT_CM") &&
  env("SHIP_LENGTH_CM") &&
  env("SHIP_WEIGHT_KG") &&
  env("MELHOR_ENVIO_USER_AGENT").includes("@") &&
  (
    (env("MELHOR_ENVIO_CLIENT_ID") && env("MELHOR_ENVIO_CLIENT_SECRET")) ||
    env("MELHOR_ENVIO_TOKEN")
  )
);

function cleanPostalCode(value){
  return String(value||"").replace(/\D/g,"").slice(0,8);
}

function extractPostalCode(text){
  const m=String(text||"").match(/\b\d{5}[-. ]?\d{3}\b/);
  return m?cleanPostalCode(m[0]):"";
}

function normalizedSecret(value){
  let v=String(value||"").trim();
  v=v.replace(/^Bearer\s+/i,"").trim();
  if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))){
    v=v.slice(1,-1).trim();
  }
  return v;
}

function shippingConfig(){
  return {
    base:(env("MELHOR_ENVIO_BASE_URL")||"https://melhorenvio.com.br").replace(/\/$/,""),
    userAgent:env("MELHOR_ENVIO_USER_AGENT"),
    from:cleanPostalCode(env("SHIP_FROM_POSTAL_CODE")),
    width:Number(env("SHIP_WIDTH_CM")),
    height:Number(env("SHIP_HEIGHT_CM")),
    length:Number(env("SHIP_LENGTH_CM")),
    weight:Number(env("SHIP_WEIGHT_KG")),
    insurance:Number(env("SALES_PRODUCT_PRICE")||79.90)
  };
}

function melhorEnvioRedirectUri(){
  return env("MELHOR_ENVIO_REDIRECT_URI") ||
    (env("PUBLIC_BASE_URL").replace(/\/$/,"")+"/api/integrations/melhor-envio/callback");
}

function integrationKey(){
  const raw=env("APP_ENCRYPTION_KEY");
  if(!raw) throw new Error("integration_encryption_key_missing");
  if(/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw,"hex");
  return crypto.createHash("sha256").update(raw).digest();
}

function encryptSecret(value){
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv("aes-256-gcm",integrationKey(),iv);
  const encrypted=Buffer.concat([cipher.update(String(value),"utf8"),cipher.final()]);
  const tag=cipher.getAuthTag();
  return [iv,tag,encrypted].map(x=>x.toString("base64url")).join(".");
}

function decryptSecret(value){
  const parts=String(value||"").split(".");
  if(parts.length!==3) throw new Error("invalid_encrypted_secret");
  const [iv,tag,data]=parts.map(x=>Buffer.from(x,"base64url"));
  const decipher=crypto.createDecipheriv("aes-256-gcm",integrationKey(),iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data),decipher.final()]).toString("utf8");
}

async function exchangeMelhorEnvioToken(payload){
  const cfg=shippingConfig();
  const endpoint=cfg.base+"/oauth/token";
  const body=new URLSearchParams();
  for(const [key,value] of Object.entries(payload)){
    if(value!==undefined&&value!==null&&String(value)!=="") body.set(key,String(value));
  }
  const response=await fetch(endpoint,{
    method:"POST",
    headers:{
      "Accept":"application/json",
      "Content-Type":"application/x-www-form-urlencoded",
      "User-Agent":cfg.userAgent
    },
    body,
    signal:AbortSignal.timeout(20000)
  });
  const raw=await response.text();
  let data=null;
  try{data=JSON.parse(raw);}catch{}
  if(!response.ok || !data?.access_token){
    throw new Error("melhor_envio_oauth_"+response.status+":"+(data?.message||data?.error||raw).slice(0,220));
  }
  return data;
}

async function saveMelhorEnvioTokens(data){
  const expiresIn=Math.max(Number(data?.expires_in)||2592000,60);
  const refreshToken=data?.refresh_token||"";
  await pool.query(`
    insert into integration_tokens(provider,access_token_enc,refresh_token_enc,expires_at,refresh_expires_at,scope,metadata,updated_at)
    values('melhor_envio',$1,$2,now()+($3||' seconds')::interval,now()+interval '45 days',$4,$5::jsonb,now())
    on conflict(provider) do update set
      access_token_enc=excluded.access_token_enc,
      refresh_token_enc=case when excluded.refresh_token_enc<>'' then excluded.refresh_token_enc else integration_tokens.refresh_token_enc end,
      expires_at=excluded.expires_at,
      refresh_expires_at=case when excluded.refresh_token_enc<>'' then excluded.refresh_expires_at else integration_tokens.refresh_expires_at end,
      scope=excluded.scope,
      metadata=excluded.metadata,
      updated_at=now()
  `,[
    encryptSecret(data.access_token),
    refreshToken?encryptSecret(refreshToken):"",
    String(expiresIn),
    String(data.scope||"shipping-calculate"),
    JSON.stringify({token_type:data.token_type||"Bearer"})
  ]);
}

async function getStoredMelhorEnvioToken(){
  const {rows}=await pool.query(`
    select access_token_enc,refresh_token_enc,expires_at,refresh_expires_at,scope
    from integration_tokens where provider='melhor_envio' limit 1
  `);
  if(!rows[0]) return null;
  return {
    accessToken:decryptSecret(rows[0].access_token_enc),
    refreshToken:rows[0].refresh_token_enc?decryptSecret(rows[0].refresh_token_enc):"",
    expiresAt:rows[0].expires_at,
    refreshExpiresAt:rows[0].refresh_expires_at,
    scope:rows[0].scope
  };
}

async function refreshMelhorEnvioToken(stored){
  if(!stored?.refreshToken) throw new Error("melhor_envio_reauthorization_required");
  if(stored.refreshExpiresAt && new Date(stored.refreshExpiresAt).getTime()<=Date.now()){
    throw new Error("melhor_envio_reauthorization_required");
  }
  const data=await exchangeMelhorEnvioToken({
    grant_type:"refresh_token",
    client_id:env("MELHOR_ENVIO_CLIENT_ID"),
    client_secret:env("MELHOR_ENVIO_CLIENT_SECRET"),
    refresh_token:stored.refreshToken
  });
  await saveMelhorEnvioTokens(data);
  return data.access_token;
}

async function getMelhorEnvioAccessToken({forceRefresh=false}={}){
  const stored=await getStoredMelhorEnvioToken().catch(()=>null);
  if(stored){
    const expires=new Date(stored.expiresAt).getTime();
    if(!forceRefresh && expires>Date.now()+5*60*1000) return stored.accessToken;
    return await refreshMelhorEnvioToken(stored);
  }
  const legacy=normalizedSecret(env("MELHOR_ENVIO_TOKEN"));
  if(legacy && !forceRefresh) return legacy;
  throw new Error("melhor_envio_not_authorized");
}

async function melhorEnvioConnected(){
  try{
    const stored=await getStoredMelhorEnvioToken();
    return Boolean(stored?.accessToken && stored?.refreshToken);
  }catch{
    return false;
  }
}

async function melhorEnvioApi(pathname,{method="GET",body,forceRefresh=false}={}){
  const cfg=shippingConfig();
  const token=await getMelhorEnvioAccessToken({forceRefresh});
  const response=await fetch(cfg.base+pathname,{
    method,
    headers:{
      "Accept":"application/json",
      ...(body?{"Content-Type":"application/json"}:{}),
      "Authorization":"Bearer "+token,
      "User-Agent":cfg.userAgent
    },
    ...(body?{body:JSON.stringify(body)}:{}),
    signal:AbortSignal.timeout(20000)
  });
  if(response.status===401 && !forceRefresh){
    return melhorEnvioApi(pathname,{method,body,forceRefresh:true});
  }
  return response;
}

let melhorEnvioServicesCache={at:0,services:[]};

async function listMelhorEnvioServices(){
  const now=Date.now();
  if(melhorEnvioServicesCache.services.length && now-melhorEnvioServicesCache.at<60*60*1000){
    return melhorEnvioServicesCache.services;
  }
  const response=await melhorEnvioApi("/api/v2/me/shipment/services");
  const raw=await response.text();
  let data=null;
  try{data=JSON.parse(raw);}catch{}
  if(!response.ok || !Array.isArray(data)){
    throw new Error("melhor_envio_services_"+response.status+":"+String(raw).slice(0,180));
  }
  const services=data.map(x=>({
    id:x?.id,
    name:x?.name||"",
    company:x?.company?.name||x?.company?.name||""
  })).filter(x=>x.id!==undefined&&x.id!==null);
  melhorEnvioServicesCache={at:now,services};
  return services;
}

async function quoteShipping(toPostalCode){
  if(!shippingConfigured()) throw new Error("shipping_not_configured");
  const cfg=shippingConfig();
  if(!/^\d{8}$/.test(toPostalCode)) throw new Error("invalid_postal_code");
  if(!cfg.userAgent || !cfg.userAgent.includes("@")) throw new Error("shipping_user_agent_missing_email");

  const mode=(env("SHIP_CARRIER_MODE")||"all").toLowerCase();
  let serviceIds=[];
  if(mode==="correios"){
    serviceIds=[1,2];
  }else{
    try{
      const services=await listMelhorEnvioServices();
      serviceIds=services.map(x=>x.id);
    }catch(error){
      console.error("melhor_envio_services_error",String(error?.message||error).slice(0,220));
    }
  }

  const response=await melhorEnvioApi("/api/v2/me/shipment/calculate",{
    method:"POST",
    body:{
      from:{postal_code:cfg.from},
      to:{postal_code:toPostalCode},
      volumes:[{
        width:cfg.width,
        height:cfg.height,
        length:cfg.length,
        weight:cfg.weight,
        insurance:cfg.insurance
      }],
      options:{receipt:false,own_hand:false},
      ...(serviceIds.length?{services:serviceIds.join(",")}:{})
    }
  });

  const raw=await response.text();
  let data;
  try{data=JSON.parse(raw);}catch{data=null;}
  if(!response.ok) throw new Error("melhor_envio_"+response.status+":"+(data?.message||raw).slice(0,220));

  const list=Array.isArray(data)?data:[];
  const failures=list
    .filter(x=>x && x.error)
    .map(x=>({
      id:x.id||null,
      name:x.name||"",
      company:x.company?.name||"",
      error:String(x.error||"").slice(0,180)
    }));
  let valid=list
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

  const correiosOnly=(env("SHIP_CARRIER_MODE")||"correios").toLowerCase()==="correios";
  if(correiosOnly){
    const correios=valid.filter(x=>String(x.company||"").toLowerCase().includes("correios"));
    if(correios.length) valid=correios;
  }

  valid.sort((a,b)=>a.price-b.price || a.deliveryTime-b.deliveryTime);
  const cheapest=valid[0]||null;
  const fastest=[...valid].sort((a,b)=>(a.deliveryTime||9999)-(b.deliveryTime||9999)||a.price-b.price)[0]||null;
  const rawSummary=list.slice(0,12).map(x=>({
    id:x?.id||null,
    name:x?.name||"",
    company:x?.company?.name||"",
    price:x?.price??null,
    custom_price:x?.custom_price??null,
    delivery_time:x?.delivery_time??null,
    custom_delivery_time:x?.custom_delivery_time??null,
    error:x?.error??null
  }));
  return {toPostalCode,options:valid.slice(0,10),cheapest,fastest,failures:failures.slice(0,10),rawSummary};
}



function superFreteConfigured(){
  return Boolean(
    env("SUPERFRETE_TOKEN") &&
    env("SHIP_FROM_POSTAL_CODE") &&
    env("SHIP_WIDTH_CM") &&
    env("SHIP_HEIGHT_CM") &&
    env("SHIP_LENGTH_CM") &&
    env("SHIP_WEIGHT_KG")
  );
}

function superFreteConfig(){
  return {
    base:(env("SUPERFRETE_BASE_URL")||"https://api.superfrete.com").replace(/\/$/,""),
    token:normalizedSecret(env("SUPERFRETE_TOKEN")),
    userAgent:env("SUPERFRETE_USER_AGENT")||env("MELHOR_ENVIO_USER_AGENT")||"Vendedor-NFC/1.0",
    from:cleanPostalCode(env("SHIP_FROM_POSTAL_CODE")),
    width:Number(env("SHIP_WIDTH_CM")),
    height:Number(env("SHIP_HEIGHT_CM")),
    length:Number(env("SHIP_LENGTH_CM")),
    weight:Number(env("SHIP_WEIGHT_KG"))
  };
}

async function quoteSuperFrete(toPostalCode){
  if(!superFreteConfigured()) throw new Error("superfrete_not_configured");
  const cfg=superFreteConfig();
  if(!/^\d{8}$/.test(toPostalCode)) throw new Error("invalid_postal_code");

  const response=await fetch(cfg.base+"/api/v0/calculator",{
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
      services:"1,2,3,17,31",
      package:{
        height:cfg.height,
        width:cfg.width,
        length:cfg.length,
        weight:cfg.weight
      }
    }),
    signal:AbortSignal.timeout(20000)
  });

  const raw=await response.text();
  let data=null;
  try{data=JSON.parse(raw);}catch{}
  if(!response.ok){
    throw new Error("superfrete_"+response.status+":"+(data?.message||data?.error||raw).slice(0,220));
  }

  const list=Array.isArray(data)?data:(Array.isArray(data?.data)?data.data:[]);
  const options=list.map(x=>({
    provider:"superfrete",
    id:x?.id??x?.service??null,
    name:x?.name||x?.service_name||x?.service||"",
    company:x?.company?.name||x?.company||x?.carrier||"",
    price:Number(x?.custom_price??x?.price??x?.cost??0),
    deliveryTime:Number(x?.custom_delivery_time??x?.delivery_time??x?.deliveryTime??0),
    error:x?.error||null
  })).filter(x=>!x.error&&Number.isFinite(x.price)&&x.price>0);

  options.sort((a,b)=>a.price-b.price || a.deliveryTime-b.deliveryTime);
  const cheapest=options[0]||null;
  const fastest=[...options].sort((a,b)=>(a.deliveryTime||9999)-(b.deliveryTime||9999)||a.price-b.price)[0]||null;

  const rawSummary=list.slice(0,12).map(x=>({
    id:x?.id??x?.service??null,
    name:x?.name||x?.service_name||x?.service||"",
    company:x?.company?.name||x?.company||x?.carrier||"",
    price:x?.custom_price??x?.price??x?.cost??null,
    deliveryTime:x?.custom_delivery_time??x?.delivery_time??x?.deliveryTime??null,
    error:x?.error??null
  }));

  return {provider:"superfrete",toPostalCode,options,cheapest,fastest,rawSummary};
}

async function quoteBestShipping(toPostalCode){
  const results=await Promise.allSettled([
    quoteShipping(toPostalCode),
    quoteSuperFrete(toPostalCode),
    quoteFrenet(toPostalCode)
  ]);

  const providers=[];
  const all=[];
  const errors=[];

  for(const result of results){
    if(result.status==="fulfilled"){
      const quote=result.value;
      const provider=quote.provider||"melhor_envio";
      providers.push({
        provider,
        options:quote.options?.length||0,
        cheapest:quote.cheapest||null,
        fastest:quote.fastest||null
      });
      for(const option of quote.options||[]){
        all.push({
          ...option,
          provider:option.provider||provider
        });
      }
    }else{
      errors.push(String(result.reason?.message||result.reason||"unknown_error").slice(0,220));
    }
  }

  const usable=all.filter(x=>Number.isFinite(Number(x.price))&&Number(x.price)>0);
  usable.sort((a,b)=>Number(a.price)-Number(b.price)||(Number(a.deliveryTime)||9999)-(Number(b.deliveryTime)||9999));
  const cheapest=usable[0]||null;
  const fastest=[...usable].sort((a,b)=>(Number(a.deliveryTime)||9999)-(Number(b.deliveryTime)||9999)||Number(a.price)-Number(b.price))[0]||null;

  return {
    toPostalCode,
    cheapest,
    fastest,
    options:usable.slice(0,20),
    providers,
    errors
  };
}


function frenetConfigured(){
  return Boolean(
    env("FRENET_TOKEN") &&
    env("SHIP_FROM_POSTAL_CODE") &&
    env("SHIP_WIDTH_CM") &&
    env("SHIP_HEIGHT_CM") &&
    env("SHIP_LENGTH_CM") &&
    env("SHIP_WEIGHT_KG")
  );
}

function frenetConfig(){
  return {
    base:(env("FRENET_BASE_URL")||"https://api.frenet.com.br").replace(/\/$/,""),
    token:normalizedSecret(env("FRENET_TOKEN")),
    from:cleanPostalCode(env("SHIP_FROM_POSTAL_CODE")),
    width:Number(env("SHIP_WIDTH_CM")),
    height:Number(env("SHIP_HEIGHT_CM")),
    length:Number(env("SHIP_LENGTH_CM")),
    weight:Number(env("SHIP_WEIGHT_KG")),
    invoiceValue:Number(env("SALES_PRODUCT_PRICE")||79.90)
  };
}

async function quoteFrenet(toPostalCode){
  if(!frenetConfigured()) throw new Error("frenet_not_configured");
  const cfg=frenetConfig();
  if(!/^\d{8}$/.test(toPostalCode)) throw new Error("invalid_postal_code");

  const response=await fetch(cfg.base+"/shipping/quote",{
    method:"POST",
    headers:{
      "Accept":"application/json",
      "Content-Type":"application/json",
      "token":cfg.token
    },
    body:JSON.stringify({
      SellerCEP:cfg.from,
      RecipientCEP:toPostalCode,
      ShipmentInvoiceValue:cfg.invoiceValue,
      RecipientCountry:"BR",
      ShippingItemArray:[{
        Quantity:1,
        Weight:cfg.weight,
        Length:cfg.length,
        Height:cfg.height,
        Width:cfg.width,
        Diameter:0,
        SKU:"placa-nfc",
        Category:"Placa NFC",
        isFragile:false,
        ProductName:"Placa NFC personalizada"
      }]
    }),
    signal:AbortSignal.timeout(20000)
  });

  const raw=await response.text();
  let data=null;
  try{data=JSON.parse(raw);}catch{}
  if(!response.ok){
    throw new Error("frenet_"+response.status+":"+(data?.Message||data?.message||raw).slice(0,220));
  }

  const list=
    (Array.isArray(data)?data:null) ||
    data?.ShippingSevicesArray ||
    data?.ShippingServicesArray ||
    data?.shippingServices ||
    data?.services ||
    [];

  const options=(Array.isArray(list)?list:[]).map(x=>({
    provider:"frenet",
    id:x?.ServiceCode??x?.serviceCode??x?.id??null,
    name:x?.ServiceDescription||x?.serviceDescription||x?.name||"",
    company:x?.Carrier||x?.carrier||x?.CarrierCode||"",
    price:Number(x?.ShippingPrice??x?.shippingPrice??x?.price??0),
    deliveryTime:Number(x?.DeliveryTime??x?.deliveryTime??0),
    error:(x?.Error===true||x?.error===true)?(x?.Msg||x?.Message||"service_error"):null
  })).filter(x=>!x.error&&Number.isFinite(x.price)&&x.price>0);

  options.sort((a,b)=>a.price-b.price || a.deliveryTime-b.deliveryTime);
  const cheapest=options[0]||null;
  const fastest=[...options].sort((a,b)=>(a.deliveryTime||9999)-(b.deliveryTime||9999)||a.price-b.price)[0]||null;

  const rawSummary=(Array.isArray(list)?list:[]).slice(0,20).map(x=>({
    serviceCode:x?.ServiceCode??x?.serviceCode??x?.id??null,
    service:x?.ServiceDescription||x?.serviceDescription||x?.name||"",
    carrier:x?.Carrier||x?.carrier||x?.CarrierCode||"",
    price:x?.ShippingPrice??x?.shippingPrice??x?.price??null,
    deliveryTime:x?.DeliveryTime??x?.deliveryTime??null,
    error:x?.Error??x?.error??null
  }));

  return {provider:"frenet",toPostalCode,options,cheapest,fastest,rawSummary};
}

const pool=new Pool({
  connectionString:env("DATABASE_URL"),
  max:5,
  idleTimeoutMillis:30000,
  connectionTimeoutMillis:10000
});

const queues=new Map();
const replyTimers=new Map();
const replyVersions=new Map();

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
    create table if not exists integration_tokens(
      provider text primary key,
      access_token_enc text not null,
      refresh_token_enc text not null default '',
      expires_at timestamptz not null,
      refresh_expires_at timestamptz,
      scope text,
      metadata jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now()
    );
    create table if not exists oauth_states(
      provider text not null,
      state text primary key,
      expires_at timestamptz not null,
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
    "Converse em português do Brasil como um bom vendedor de WhatsApp: natural, direto, cordial e atento ao que o cliente acabou de dizer.",
    "Use o histórico da conversa. Não repita perguntas já respondidas e não recomece a conversa a cada mensagem.",
    "Prefira frases curtas e vocabulário cotidiano. Evite texto com cara de atendimento automático, roteiro engessado ou redação publicitária.",
    "Normalmente responda em uma mensagem curta. Quando realmente ajudar a leitura, use duas mensagens curtas separadas por uma linha em branco. Nunca use mais de duas.",
    "Não faça textão. Não use títulos, listas, markdown ou várias perguntas na mesma resposta, salvo se o cliente pedir detalhes.",
    "Não comece toda resposta com 'Olá', 'Perfeito', 'Entendi' ou outras muletas. Varie naturalmente e vá direto ao ponto.",
    "Pode usar contrações e pontuação de conversa, mas mantenha português claro e profissional. Emoji só ocasionalmente, quando combinar com o tom do cliente.",
    "Faça no máximo uma pergunta por vez para avançar a venda.",
    "Se o cliente mandar várias mensagens seguidas, considere todas antes de responder.",
    "Se o cliente estiver apenas confirmando algo curto, responda curto; não transforme uma confirmação em apresentação de vendas.",
    "Nunca invente preço, prazo, estoque, desconto, frete, instalação, garantia, depoimento ou resultado.",
    "Se preço ou entrega estiverem NÃO CONFIGURADOS, diga que precisa confirmar antes de informar.",
    "Para frete, nunca invente valor. Peça o CEP do cliente e use apenas a cotação real disponível nas integrações de frete.",
    "Diferencie prazo de produção/postagem do prazo de transporte da transportadora.",
    "Não prometa aumento garantido de avaliações, vendas ou faturamento.",
    "Não envie várias mensagens seguidas sem motivo; no máximo duas partes para uma mesma resposta.",
    "Se a pessoa perguntar diretamente se você é robô, IA ou atendimento automático, responda com transparência que é o assistente de vendas automatizado da empresa. Nunca afirme falsamente ser uma pessoa.",
    "Não invente experiências pessoais, sentimentos, nome próprio, cargo ou histórias para parecer humano.",
    "Se a pessoa pedir para parar, sair, remover o contato ou não receber mensagens, confirme brevemente e encerre.",
    "Se houver pedido fora das regras comerciais, diga que precisa confirmar antes de prometer."
  ].join("\n");
}

async function generateReply(chatId){
  const history=await recentHistory(chatId,24);
  let shippingContext="";
  const lastInbound=[...history].reverse().find(m=>m.direction==="inbound");
  const cep=extractPostalCode(lastInbound?.body||"");
  if(cep && shippingConfigured()){
    try{
      const quote=await quoteBestShipping(cep);
      const cheapest=quote.cheapest;
      const fastest=quote.fastest;
      if(cheapest){
        shippingContext="\nCOTAÇÃO REAL DE FRETE PARA O CEP "+cep+
          ": opção mais barata via "+(cheapest.provider==="superfrete"?"SuperFrete":cheapest.provider==="frenet"?"Frenet":"Melhor Envio")+" — "+cheapest.company+" "+cheapest.name+
          " por R$ "+cheapest.price.toFixed(2).replace(".",",")+
          (cheapest.deliveryTime?" com prazo estimado de "+cheapest.deliveryTime+" dia(s) úteis de transporte":"")+".";
        if(fastest && fastest.id!==cheapest.id){
          shippingContext+=" Opção mais rápida via "+(fastest.provider==="superfrete"?"SuperFrete":fastest.provider==="frenet"?"Frenet":"Melhor Envio")+": "+fastest.company+" "+fastest.name+
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
      temperature:Math.min(Math.max(Number(env("AGENT_TEMPERATURE")||0.5),0),1),
      max_tokens:Math.min(Math.max(Number(env("AGENT_MAX_TOKENS")||220),80),400),
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

function sleep(ms){
  return new Promise(resolve=>setTimeout(resolve,Math.max(0,ms||0)));
}

function randomBetween(min,max){
  const a=Math.min(Number(min)||0,Number(max)||0);
  const b=Math.max(Number(min)||0,Number(max)||0);
  return Math.round(a+Math.random()*(b-a));
}

function outboundChatId(chatId){
  const id=String(chatId||"");
  return id.endsWith("@s.whatsapp.net")?id.replace(/@s\.whatsapp\.net$/,"@c.us"):id;
}

async function sendSeen(chatId){
  try{
    await waha("/api/sendSeen",{
      method:"POST",
      headers:{"Content-Type":"application/json","Accept":"application/json"},
      body:JSON.stringify({session:sessionName(),chatId:outboundChatId(chatId)})
    });
  }catch{}
}

async function setChatPresence(chatId,presence){
  try{
    await waha("/api/"+encodeURIComponent(sessionName())+"/presence",{
      method:"POST",
      headers:{"Content-Type":"application/json","Accept":"application/json"},
      body:JSON.stringify({chatId:outboundChatId(chatId),presence})
    });
  }catch{}
}

function splitHumanReply(value){
  let text=String(value||"")
    .replace(/^["']|["']$/g,"")
    .replace(/\n{3,}/g,"\n\n")
    .trim();
  if(!text) return [];

  let parts=text.split(/\n\s*\n/).map(x=>x.trim()).filter(Boolean);
  if(parts.length>2){
    parts=[parts[0],parts.slice(1).join(" ")];
  }

  const maxChars=Math.min(Math.max(Number(env("AGENT_MAX_CHARS_PER_MESSAGE")||520),240),800);
  if(parts.length===1 && parts[0].length>maxChars){
    const source=parts[0];
    const target=Math.min(maxChars,Math.max(280,Math.round(source.length*0.55)));
    let cut=-1;
    for(let i=target;i>=Math.max(180,target-140);i--){
      if(/[.!?]/.test(source[i]||"")){cut=i+1;break;}
    }
    if(cut<0){
      for(let i=target;i>=Math.max(180,target-120);i--){
        if(/\s/.test(source[i]||"")){cut=i;break;}
      }
    }
    if(cut>0) parts=[source.slice(0,cut).trim(),source.slice(cut).trim()];
  }

  return parts.slice(0,2).map(x=>x.slice(0,maxChars).trim()).filter(Boolean);
}

function typingDelayFor(text){
  const min=Math.min(Math.max(Number(env("AGENT_TYPING_MIN_MS")||1800),500),5000);
  const max=Math.min(Math.max(Number(env("AGENT_TYPING_MAX_MS")||6500),min),12000);
  const chars=String(text||"").length;
  const calculated=900+chars*28+randomBetween(150,850);
  return Math.min(Math.max(calculated,min),max);
}

async function sendText(chatId,text){
  const res=await waha("/api/sendText",{
    method:"POST",
    headers:{"Content-Type":"application/json","Accept":"application/json"},
    body:JSON.stringify({
      session:sessionName(),
      chatId:outboundChatId(chatId),
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

async function sendHumanizedReply(chatId,reply){
  const parts=splitHumanReply(reply);
  if(!parts.length) throw new Error("empty_humanized_reply");

  const readMin=Math.min(Math.max(Number(env("AGENT_READ_MIN_MS")||900),0),5000);
  const readMax=Math.min(Math.max(Number(env("AGENT_READ_MAX_MS")||2200),readMin),8000);
  await sleep(randomBetween(readMin,readMax));

  const sentMessages=[];
  for(let i=0;i<parts.length;i++){
    const part=parts[i];
    await setChatPresence(chatId,"typing");
    try{
      await sleep(typingDelayFor(part));
      const sent=await sendText(chatId,part);
      sentMessages.push({sent,body:part,index:i,total:parts.length});
    }finally{
      await setChatPresence(chatId,"paused");
    }

    if(i<parts.length-1){
      const betweenMin=Math.min(Math.max(Number(env("AGENT_BETWEEN_MESSAGES_MIN_MS")||650),250),2500);
      const betweenMax=Math.min(Math.max(Number(env("AGENT_BETWEEN_MESSAGES_MAX_MS")||1400),betweenMin),4000);
      await sleep(randomBetween(betweenMin,betweenMax));
    }
  }
  return sentMessages;
}

function wantsOptOut(text){
  const v=String(text||"").toLowerCase();
  return /\b(parar|pare|sair|remover|remova|cancelar|não me chame|nao me chame|não mande|nao mande|stop)\b/i.test(v);
}

function scheduleAgentReply(chatId){
  const version=(replyVersions.get(chatId)||0)+1;
  replyVersions.set(chatId,version);

  const previousTimer=replyTimers.get(chatId);
  if(previousTimer) clearTimeout(previousTimer);

  const settle=Math.min(Math.max(Number(env("AGENT_SETTLE_MS")||2600),700),7000);
  const timer=setTimeout(()=>{
    replyTimers.delete(chatId);

    const previous=queues.get(chatId)||Promise.resolve();
    const next=previous.then(async()=>{
      if(replyVersions.get(chatId)!==version) return;

      await sendSeen(chatId);
      const reply=await generateReply(chatId);

      // If another client message arrived while the AI was composing, discard
      // this stale answer and let the newer turn be handled instead.
      if(replyVersions.get(chatId)!==version) return;

      const sentMessages=await sendHumanizedReply(chatId,reply);
      for(const item of sentMessages){
        await saveMessage({
          providerId:String(item.sent?.id||crypto.randomUUID()),
          chatId,
          direction:"outbound",
          body:item.body,
          metadata:{
            model:env("AI_MODEL"),
            humanized:true,
            part:item.index+1,
            parts:item.total
          }
        });
      }
      if(sentMessages.length){
        await pool.query("update sales_contacts set last_outbound_at=now(),last_seen_at=now() where chat_id=$1",[chatId]);
      }
    }).catch(err=>{
      setChatPresence(chatId,"paused").catch(()=>{});
      console.error("agent_reply_error",String(err?.message||err).slice(0,500));
    }).finally(()=>{
      if(queues.get(chatId)===next) queues.delete(chatId);
    });

    queues.set(chatId,next);
  },settle);

  replyTimers.set(chatId,timer);
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
      await sendSeen(chatId);
      await setChatPresence(chatId,"typing");
      await sleep(randomBetween(700,1300));
      await setChatPresence(chatId,"paused");
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

  scheduleAgentReply(chatId);
}

app.get("/health",async(_req,res)=>{
  let db=false,wahaOk=false;
  try{await pool.query("select 1");db=true;}catch{}
  try{const r=await waha("/api/server/version");wahaOk=r.ok;}catch{}
  res.status(db?200:503).json({ok:db,service:"vendedor-autonomo-nfc",database:db,waha:wahaOk});
});

app.get("/api/status",async(_req,res)=>{
  let session=null,wahaReachable=false,database=false;
  let shippingConnected=false;
  try{await pool.query("select 1");database=true;}catch{}
  try{
    const r=await waha("/api/server/version");
    wahaReachable=r.ok;
    if(wahaReachable) session=await getSession();
  }catch{}
  try{shippingConnected=await melhorEnvioConnected();}catch{}
  const whatsapp=session?.status==="WORKING";
  res.json({
    ok:true,
    build:BUILD_VERSION,
    isolated:true,
    agent:whatsapp&&database&&aiReady()&&autoReply()?"active":"setup",
    integrations:{
      whatsapp,
      waha:wahaReachable,
      ai:aiReady(),
      leads:Boolean(env("GOOGLE_PLACES_API_KEY")),
      woovi:Boolean(env("WOOVI_APP_ID")),
      shipping:shippingConnected,
      shippingConfigured:shippingConfigured(),
      superfrete:superFreteConfigured(),
      frenet:frenetConfigured(),
      database,
      autoReply:autoReply()
    },
    whatsappSession:session?{name:session.name,status:session.status,me:session.me||null}:null
  });
});

app.get("/api/integrations/melhor-envio/status",async(_req,res)=>{
  const connected=await melhorEnvioConnected();
  res.json({
    ok:true,
    connected,
    configured:shippingConfigured(),
    callback:melhorEnvioRedirectUri(),
    scope:"shipping-calculate"
  });
});

app.get("/api/integrations/melhor-envio/connect",async(_req,res)=>{
  if(!env("MELHOR_ENVIO_CLIENT_ID")||!env("MELHOR_ENVIO_CLIENT_SECRET")){
    return res.status(503).send("Credenciais do Melhor Envio não configuradas.");
  }
  if(!env("MELHOR_ENVIO_USER_AGENT").includes("@")){
    return res.status(503).send("MELHOR_ENVIO_USER_AGENT precisa conter um e-mail válido.");
  }
  const state=crypto.randomBytes(32).toString("hex");
  await pool.query("delete from oauth_states where provider='melhor_envio' or expires_at<now()");
  await pool.query(
    "insert into oauth_states(provider,state,expires_at) values('melhor_envio',$1,now()+interval '10 minutes')",
    [state]
  );
  const cfg=shippingConfig();
  const url=new URL(cfg.base+"/oauth/authorize");
  url.searchParams.set("client_id",env("MELHOR_ENVIO_CLIENT_ID"));
  url.searchParams.set("redirect_uri",melhorEnvioRedirectUri());
  url.searchParams.set("response_type","code");
  url.searchParams.set("state",state);
  url.searchParams.set("scope","shipping-calculate");
  res.redirect(url.toString());
});

app.get("/api/integrations/melhor-envio/callback",async(req,res)=>{
  const code=String(req.query.code||"");
  const state=String(req.query.state||"");
  const oauthError=String(req.query.error||"");
  if(oauthError){
    return res.redirect("/?melhor_envio=error&reason="+encodeURIComponent(oauthError));
  }
  if(!code||!state){
    return res.status(400).send("Retorno OAuth inválido.");
  }
  const result=await pool.query(
    "delete from oauth_states where provider='melhor_envio' and state=$1 and expires_at>now() returning state",
    [state]
  );
  if(!result.rowCount){
    return res.status(400).send("Autorização expirada ou inválida. Volte ao painel e tente conectar novamente.");
  }
  try{
    const data=await exchangeMelhorEnvioToken({
      grant_type:"authorization_code",
      client_id:env("MELHOR_ENVIO_CLIENT_ID"),
      client_secret:env("MELHOR_ENVIO_CLIENT_SECRET"),
      redirect_uri:melhorEnvioRedirectUri(),
      code
    });
    await saveMelhorEnvioTokens(data);
    return res.redirect("/?melhor_envio=connected");
  }catch(error){
    console.error("melhor_envio_oauth_error",String(error?.message||error).slice(0,300));
    return res.redirect("/?melhor_envio=error");
  }
});

app.post("/api/integrations/melhor-envio/disconnect",async(_req,res)=>{
  await pool.query("delete from integration_tokens where provider='melhor_envio'");
  res.json({ok:true});
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

async function selfTestCombinedShipping(){
  if(env("COMBINED_SHIPPING_SELFTEST_ON_BOOT").toLowerCase()!=="true") return;
  const destination=cleanPostalCode(env("SUPERFRETE_SELFTEST_DESTINATION")||"01001000");
  try{
    const quote=await quoteBestShipping(destination);
    console.log(JSON.stringify({
      event:"combined_shipping_selftest",
      ok:Boolean(quote.cheapest),
      destination,
      cheapest:quote.cheapest,
      fastest:quote.fastest,
      providers:quote.providers,
      errors:quote.errors
    }));
  }catch(error){
    console.log(JSON.stringify({
      event:"combined_shipping_selftest",
      ok:false,
      destination,
      error:String(error?.message||error).slice(0,300)
    }));
  }
}

async function selfTestFrenet(){
  if(env("FRENET_SELFTEST_ON_BOOT").toLowerCase()!=="true") return;
  const destination=cleanPostalCode(env("FRENET_SELFTEST_DESTINATION")||"01001000");
  try{
    const quote=await quoteFrenet(destination);
    console.log(JSON.stringify({
      event:"frenet_selftest",
      ok:Boolean(quote.cheapest),
      destination,
      options:quote.options.length,
      cheapest:quote.cheapest,
      fastest:quote.fastest,
      rawSummary:quote.rawSummary
    }));
  }catch(error){
    console.log(JSON.stringify({
      event:"frenet_selftest",
      ok:false,
      destination,
      error:String(error?.message||error).slice(0,300)
    }));
  }
}

async function selfTestSuperFrete(){
  if(env("SUPERFRETE_SELFTEST_ON_BOOT").toLowerCase()!=="true") return;
  const destination=cleanPostalCode(env("SUPERFRETE_SELFTEST_DESTINATION")||"01001000");
  try{
    const quote=await quoteSuperFrete(destination);
    console.log(JSON.stringify({
      event:"superfrete_selftest",
      ok:Boolean(quote.cheapest),
      destination,
      options:quote.options.length,
      cheapest:quote.cheapest,
      rawSummary:quote.rawSummary
    }));
  }catch(error){
    console.log(JSON.stringify({
      event:"superfrete_selftest",
      ok:false,
      destination,
      error:String(error?.message||error).slice(0,300)
    }));
  }
}

async function selfTestShipping(){
  if(env("SHIPPING_SELFTEST_ON_BOOT").toLowerCase()!=="true") return;
  const destination=cleanPostalCode(env("SHIPPING_SELFTEST_DESTINATION")||"01001000");
  try{
    const quote=await quoteShipping(destination);
    console.log(JSON.stringify({
      event:"shipping_selftest",
      ok:Boolean(quote.cheapest),
      destination,
      options:quote.options.length,
      cheapest:quote.cheapest?{
        company:quote.cheapest.company,
        service:quote.cheapest.name,
        price:quote.cheapest.price,
        deliveryTime:quote.cheapest.deliveryTime
      }:null,
      failures:quote.failures,
      rawSummary:quote.rawSummary,
      discoveredServices:(await listMelhorEnvioServices().catch(()=>[])).map(x=>({id:x.id,name:x.name,company:x.company})).slice(0,40)
    }));
  }catch(error){
    console.log(JSON.stringify({
      event:"shipping_selftest",
      ok:false,
      destination,
      error:String(error?.message||error).slice(0,240)
    }));
  }
}

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
  await selfTestShipping();
  await selfTestSuperFrete();
  await selfTestFrenet();
  await selfTestCombinedShipping();
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
