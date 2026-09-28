const STAGES=[
  {id:'captar',label:'Captar'},
  {id:'mapear',label:'Mapear'},
  {id:'mensagem',label:'1ª mensagem'},
  {id:'prova',label:'Prova/Objeções'},
  {id:'fechamento',label:'Fechamento/Pós-venda'}
];
const SCRIPTS={
  captar:{title:'Roteiro de captação',text:'Procure negócios locais que já atendem pelo WhatsApp e dependem da reputação no Google. Antes de abordar, registre nome, nicho, cidade, nota, quantidade de avaliações e um concorrente próximo para comparação.'},
  mapear:{title:'Checklist de mapeamento',text:'Checklist antes de abordar:\n\n1. Confirmar nome do negócio.\n2. Confirmar WhatsApp/telefone.\n3. Conferir nota e quantidade de avaliações no Google.\n4. Conferir um concorrente próximo.\n5. Não citar nenhum número sem verificar.\n6. Escolher um ponto real de melhoria para a abordagem.'},
  primeira:{title:'Primeira mensagem',text:'Oi! Tudo bem? Vi o perfil da [NOME DO NEGÓCIO] no Google e vocês têm uma nota muito boa. Percebi que alguns concorrentes próximos estão acumulando mais avaliações, e isso pode fazer diferença na hora de o cliente escolher. Posso te mostrar em 30 segundos uma forma simples de facilitar a avaliação do cliente na hora?'},
  prova:{title:'Mensagem de prova',text:'Olha como funciona: o cliente só encosta o celular na placa e já abre direto a tela de avaliação do Google. Vou te mandar um vídeo rapidinho e uma foto de uma instalação para você visualizar melhor.'},
  caro:{title:'Objeção: “Tá caro”',text:'Entendo. A ideia é que seja um pagamento único e que a placa continue sendo usada todos os dias. Em vez de depender do cliente lembrar de procurar a empresa depois, você deixa o caminho para avaliar pronto no balcão. Se fizer sentido, posso te mostrar a opção mais simples.'},
  funciona:{title:'Objeção: “Isso funciona?”',text:'Funciona como um atalho por NFC: o celular compatível encosta na placa e abre o link configurado, como a página de avaliação do Google. O resultado em número de avaliações depende de quantos clientes realmente usam e avaliam; por isso eu prefiro te mostrar a placa funcionando antes.'},
  avaliacoes:{title:'Objeção: “Já tenho avaliações”',text:'Isso é ótimo — significa que vocês já têm uma base forte. A placa não substitui o que já fazem; ela só reduz o atrito para novos clientes avaliarem na hora, enquanto a experiência ainda está fresca.'},
  fechamento:{title:'Fechamento por escolha',text:'Perfeito. Para eu já deixar isso encaminhado: para o seu espaço fica melhor a placa no balcão ou na parede?\n\nE para entrega, fica melhor amanhã ou sexta?'},
  followup:{title:'Follow-ups',text:'Depois de 2 dias:\nOi! Passando rapidinho porque não sei se você conseguiu ver minha mensagem. Se quiser, te mando um vídeo de poucos segundos mostrando como a placa funciona.\n\nDepois de 5 dias:\nOi! Última mensagem para não ficar te incomodando. Se em algum momento fizer sentido facilitar as avaliações do Google aí no negócio, me chama que te mostro sem compromisso.\n\nPós-venda:\nOi! Tudo certo com a placa? Chegaram novas avaliações desde que começou a usar? Se lembrar de algum comerciante que também poderia aproveitar, me indica que eu entro em contato sem compromisso.'}
};

const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
let leads=JSON.parse(localStorage.getItem('salesMapLeads')||'[]');
let editingId=null;

function save(){localStorage.setItem('salesMapLeads',JSON.stringify(leads));renderAll();}
function money(v){return new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(v||0));}
function showToast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1800)}
function fmtDate(v){if(!v)return '—';const [y,m,d]=v.split('-');return `${d}/${m}/${y}`}

function initSelects(){
  $('#stage').innerHTML=STAGES.map(s=>`<option value="${s.id}">${s.label}</option>`).join('');
  $('#stageFilter').innerHTML='<option value="all">Todas as etapas</option>'+STAGES.map(s=>`<option value="${s.id}">${s.label}</option>`).join('');
}
function switchView(view){
  $$('.view').forEach(v=>v.classList.remove('active')); $(`#${view}View`).classList.add('active');
  $$('.tab').forEach(t=>t.classList.toggle('active',t.dataset.view===view));
}
$$('.tab').forEach(t=>t.onclick=()=>switchView(t.dataset.view));

function openLead(lead=null){
  editingId=lead?.id||null; $('#dialogTitle').textContent=lead?'Editar lead':'Novo lead';
  $('#deleteLeadBtn').classList.toggle('hidden',!lead);
  const data=lead||{name:'',niche:'',city:'',phone:'',stage:'captar',status:'novo',value:'',followup:'',notes:''};
  ['name','niche','city','phone','stage','status','value','followup','notes'].forEach(k=>$('#'+k).value=data[k]??'');
  $('#leadDialog').showModal();
}
$('#addLeadBtn').onclick=()=>openLead();
$('#closeDialog').onclick=$('#cancelBtn').onclick=()=>$('#leadDialog').close();
$('#leadForm').addEventListener('submit',e=>{
  e.preventDefault();
  const obj={id:editingId||crypto.randomUUID(),name:$('#name').value.trim(),niche:$('#niche').value.trim(),city:$('#city').value.trim(),phone:$('#phone').value.trim(),stage:$('#stage').value,status:$('#status').value,value:Number($('#value').value||0),followup:$('#followup').value,notes:$('#notes').value.trim(),updatedAt:new Date().toISOString()};
  if(!obj.name)return;
  if(editingId) leads=leads.map(l=>l.id===editingId?{...l,...obj}:l); else leads.unshift(obj);
  $('#leadDialog').close(); save(); showToast('Lead salvo');
});
$('#deleteLeadBtn').onclick=()=>{if(!editingId)return;if(confirm('Excluir este lead?')){leads=leads.filter(l=>l.id!==editingId);$('#leadDialog').close();save();showToast('Lead excluído')}};

function renderKanban(){
  const q=$('#searchInput').value.toLowerCase().trim(); const filter=$('#stageFilter').value;
  const filtered=leads.filter(l=>(filter==='all'||l.stage===filter)&&(!q||`${l.name} ${l.niche} ${l.city}`.toLowerCase().includes(q)));
  $('#kanban').innerHTML=STAGES.map(s=>{
    const ls=filtered.filter(l=>l.stage===s.id);
    return `<section class="column" data-stage="${s.id}"><div class="column-head"><b>${s.label}</b><span class="column-count">${ls.length}</span></div>${ls.map(l=>`<article class="lead-card" data-id="${l.id}"><h3>${esc(l.name)}</h3><div class="lead-meta"><span>${esc(l.niche||'Sem nicho')} • ${esc(l.city||'Sem cidade')}</span><span><i class="status-pill ${l.status}">${l.status}</i> ${l.followup?`• Follow-up ${fmtDate(l.followup)}`:''}</span><span>${l.value?money(l.value):'Sem valor definido'}</span></div></article>`).join('')}</section>`
  }).join('');
  $$('.lead-card').forEach(c=>c.onclick=()=>openLead(leads.find(l=>l.id===c.dataset.id)));
}
function esc(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
$('#searchInput').oninput=renderKanban; $('#stageFilter').onchange=renderKanban;

function renderDashboard(){
  const total=leads.length, answered=leads.filter(l=>['respondeu','andamento','fechado'].includes(l.status)).length, closed=leads.filter(l=>l.status==='fechado').length, revenue=leads.filter(l=>l.status==='fechado').reduce((a,l)=>a+Number(l.value||0),0);
  $('#kpiTotal').textContent=total; $('#kpiAnswered').textContent=answered; $('#kpiClosed').textContent=closed; $('#kpiConversion').textContent=total?Math.round(closed/total*100)+'%':'0%'; $('#kpiRevenue').textContent=money(revenue);
  const max=Math.max(1,...STAGES.map(s=>leads.filter(l=>l.stage===s.id).length));
  $('#funnelBars').innerHTML=STAGES.map(s=>{const n=leads.filter(l=>l.stage===s.id).length;return `<div class="bar-row"><div class="bar-label"><span>${s.label}</span><b>${n}</b></div><div class="bar"><i style="width:${n/max*100}%"></i></div></div>`}).join('');
  const upcoming=leads.filter(l=>l.followup&&l.status!=='fechado'&&l.status!=='perdido').sort((a,b)=>a.followup.localeCompare(b.followup)).slice(0,8);
  $('#followupList').innerHTML=upcoming.length?upcoming.map(l=>`<div class="followup-item"><div><b>${esc(l.name)}</b><br><small>${esc(l.phone||l.niche||'')}</small></div><div>${fmtDate(l.followup)}</div></div>`).join(''):'<p style="color:var(--muted)">Nenhum follow-up agendado.</p>';
}
function renderAll(){
  $('#leadCount').textContent=leads.length; renderKanban(); renderDashboard();
}

function openScript(key){const s=SCRIPTS[key]; if(!s)return; $('#scriptTitle').textContent=s.title; $('#scriptText').value=s.text; $('#copyFeedback').textContent=''; $('#scriptDialog').showModal();}
$$('[data-script]').forEach(b=>b.onclick=()=>openScript(b.dataset.script));
$('#closeScript').onclick=()=>$('#scriptDialog').close();
$('#copyScriptBtn').onclick=async()=>{await navigator.clipboard.writeText($('#scriptText').value);$('#copyFeedback').textContent='Copiado!';showToast('Mensagem copiada')};

$('#exportBtn').onclick=()=>{
  const payload={exportedAt:new Date().toISOString(),leads};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='mapa-vendas-backup.json'; a.click(); URL.revokeObjectURL(a.href);
};

initSelects(); renderAll();