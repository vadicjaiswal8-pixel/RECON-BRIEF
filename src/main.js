import { supabase } from './supabase.js';

function esc(s){ if(s===undefined||s===null) return ''; return String(s).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

let currentUserId = null;
let analystName = '';
let currentReport = null;

/* ---------- AUTH ---------- */

let authMode = 'signin';

function toggleAuthMode(){
  authMode = authMode === 'signin' ? 'signup' : 'signin';
  document.getElementById('authTitle').textContent = authMode === 'signin' ? 'Sign in' : 'Create an account';
  document.getElementById('authSubmitBtn').textContent = authMode === 'signin' ? 'Sign In' : 'Sign Up';
}

async function handleAuthSubmit(){
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const errBox = document.getElementById('authError');
  errBox.innerHTML = '';
  if(!email || !password){ errBox.innerHTML = '<div class="err">Enter email and password.</div>'; return; }
  try{
    if(authMode === 'signin'){
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if(error) throw error;
    } else {
      const { error } = await supabase.auth.signUp({ email, password });
      if(error) throw error;
      errBox.innerHTML = '<div class="emptyNote">Account created. If email confirmation is on, check your inbox, then sign in.</div>';
    }
  }catch(e){
    errBox.innerHTML = '<div class="err">' + esc(e.message) + '</div>';
  }
}

async function handleLogout(){
  await supabase.auth.signOut();
}

function updateAuthUI(session){
  const authCard = document.getElementById('authCard');
  const appRoot = document.getElementById('appRoot');
  const logoutBtn = document.getElementById('logoutBtn');
  const userLabel = document.getElementById('userLabel');
  if(session && session.user){
    authCard.classList.add('hidden');
    appRoot.classList.remove('hidden');
    logoutBtn.classList.remove('hidden');
    userLabel.textContent = session.user.email;
    currentUserId = session.user.id;
    analystName = session.user.email;
    loadSavedReports();
  } else {
    authCard.classList.remove('hidden');
    appRoot.classList.add('hidden');
    logoutBtn.classList.add('hidden');
    currentUserId = null;
  }
}

supabase.auth.onAuthStateChange((_event, session)=> updateAuthUI(session));
supabase.auth.getSession().then(({data})=> updateAuthUI(data.session));

/* ---------- AI (Gemini + Groq backup) ---------- */

async function callGemini(prompt, attempt = 1){
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' }
    })
  });
  if(!res.ok){
    if((res.status === 503 || res.status === 429) && attempt < 3){
      await new Promise(r => setTimeout(r, attempt * 1200));
      return callGemini(prompt, attempt + 1);
    }
    throw new Error('Gemini unavailable');
  }
  const json = await res.json();
  const text = json.candidates && json.candidates[0] && json.candidates[0].content &&
    json.candidates[0].content.parts && json.candidates[0].content.parts[0] &&
    json.candidates[0].content.parts[0].text;
  if(!text) throw new Error('Gemini returned no content.');
  return JSON.parse(text);
}

async function callGroq(prompt){
  const apiKey = import.meta.env.VITE_GROQ_API_KEY;
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    })
  });
  if(!res.ok){
    const errText = await res.text();
    throw new Error('Backup AI also failed: ' + errText.slice(0, 200));
  }
  const json = await res.json();
  const text = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if(!text) throw new Error('Backup AI returned no content.');
  return JSON.parse(text);
}

async function callAI(prompt){
  try{
    return await callGemini(prompt);
  }catch(e){
    return await callGroq(prompt);
  }
}

/* ---------- WEB RESEARCH (Tavily) ---------- */

async function tavilySearch(query){
  const apiKey = import.meta.env.VITE_TAVILY_API_KEY;
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: 5, include_raw_content: true })
  });
  if(!res.ok) return [];
  const json = await res.json();
  return json.results || [];
}

async function fetchWebContext(industry, target, competitors, onProgress){
  const compList = competitors.split(',').map(s=>s.trim()).filter(Boolean);
  const queries = [
    `${target} ${industry} revenue market share financials 2026`,
    `${target} vs ${compList.join(' vs ')} ${industry} comparison`,
    ...compList.slice(0,4).map(c => `${c} ${industry} revenue positioning 2026`)
  ];
  let sources = [];
  for(const q of queries){
    if(onProgress) onProgress(q);
    try{
      const results = await tavilySearch(q);
      results.forEach(r=>{
        if(r.url && !sources.find(s=>s.url===r.url)){
          sources.push({
            title: r.title || r.url,
            url: r.url,
            description: r.content ? r.content.slice(0,300) : '',
            fullText: r.raw_content ? r.raw_content.slice(0,2200) : null
          });
        }
      });
    }catch(e){ /* one query failing shouldn't kill the run */ }
  }
  sources = sources.slice(0, 20);
  const text = sources.map((s,i)=>{
    const tag = s.fullText ? 'FULL PAGE CONTENT' : 'snippet only';
    const body = s.fullText || s.description;
    return `[${i+1}] ${s.title} (${s.url}) — ${tag}:\n${body}`;
  }).join('\n\n');
  return { text, sources };
}

/* ---------- DOWNLOADS ---------- */

function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ---------- REPORT RENDER / EXPORT ---------- */

async function downloadWord(){
  if(!currentReport){ showError('Nothing to download yet — run an analysis first.'); return; }
  if(!window.docx){ showError('Word library failed to load — try again in a moment.'); return; }
  const { data, industry, target, competitors, objective } = currentReport;
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } = window.docx;
  const H = (t) => new Paragraph({ text: t, heading: HeadingLevel.HEADING_1, spacing:{before:280, after:120} });
  const P = (t) => new Paragraph({ children:[new TextRun(t||'')], spacing:{after:100} });
  const Bul = (items) => (items||[]).map(t => new Paragraph({ text: t, bullet:{level:0}, spacing:{after:60} }));
  const cell = (t, header) => new TableCell({ children:[new Paragraph({ children:[new TextRun({text:String(t||''), bold:!!header})] })], width:{size:2000,type:WidthType.DXA} });
  const children = [
    new Paragraph({ text: `${target} — Competitive Intelligence Report`, heading: HeadingLevel.TITLE, spacing:{after:80} }),
    new Paragraph({ children:[new TextRun({text:`Industry: ${industry}  ·  Competitors: ${competitors}  ·  Objective: ${objective}  ·  Generated ${new Date().toLocaleDateString()}`, italics:true, size:18})], spacing:{after:280} }),
    H('Executive Summary'), P(data.executive_summary)
  ];
  if(data._sources && data._sources.length){
    children.push(H('Live Web Sources'));
    data._sources.forEach((s,i)=>children.push(P(`[${i+1}] ${s.title} — ${s.url}`)));
  }
  if(data.benchmark_matrix && data.benchmark_matrix.rows){
    children.push(H('Competitive Benchmarking Matrix'));
    const rows = [new TableRow({children:data.benchmark_matrix.columns.map(c=>cell(c,true))})];
    data.benchmark_matrix.rows.forEach(r=>rows.push(new TableRow({children:r.map(c=>cell(c))})));
    children.push(new Table({rows}));
  }
  if(data.scores){
    children.push(new Paragraph({text:'', spacing:{before:200}}));
    children.push(H('Competitive Strength Index (avg of 5 axes, /5)'));
    Object.keys(data.scores.companies).forEach(name=>{
      const vals = data.scores.companies[name];
      const avg = (vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(1);
      children.push(P(`${name}: ${avg} / 5`));
    });
  }
  if(data.swot){
    children.push(H('SWOT Analysis'));
    ['strengths','weaknesses','opportunities','threats'].forEach(k=>{
      children.push(new Paragraph({ text:k.charAt(0).toUpperCase()+k.slice(1), heading:HeadingLevel.HEADING_2, spacing:{before:160,after:60} }));
      children.push(...Bul(data.swot[k]));
    });
  }
  if(data.vulnerabilities && data.vulnerabilities.length){ children.push(H('Strategic Vulnerabilities')); children.push(...Bul(data.vulnerabilities)); }
  if(data.strategic_takeaways && data.strategic_takeaways.length){ children.push(H('Key Strategic Takeaways')); children.push(...Bul(data.strategic_takeaways)); }
  if(data.recommendations && data.recommendations.length){
    children.push(H('Actionable Recommendations'));
    data.recommendations.forEach(r=>{ children.push(new Paragraph({children:[new TextRun({text:r.title,bold:true})]})); children.push(P(r.detail)); });
  }
  const doc = new Document({ sections:[{ children }] });
  try{
    const blob = await Packer.toBlob(doc);
    const safeName = (target || 'report').replace(/[^a-z0-9]+/gi,'-').toLowerCase();
    downloadBlob(blob, `${safeName}-competitive-intel-report.docx`);
  }catch(e){
    showError('Word export failed: ' + (e && e.message ? e.message : 'unknown error'));
  }
}

function guessLogoDomain(name){
  return (name||'').toLowerCase().trim().replace(/[^a-z0-9]+/g,'') + '.com';
}

async function tryFetchLogoDataUrl(companyName){
  try{
    const domain = guessLogoDomain(companyName);
    const res = await fetch(`https://www.google.com/s2/favicons?domain=${domain}&sz=128`);
    if(!res.ok) return null;
    const blob = await res.blob();
    if(blob.size < 200) return null;
    return await new Promise((resolve)=>{
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  }catch(e){ return null; }
}

async function downloadPdf(){
  if(!currentReport){ showError('Nothing to download yet — run an analysis first.'); return; }
  if(!window.jspdf){ showError('PDF library failed to load — try again in a moment.'); return; }
  const { data, industry, target, competitors, objective } = currentReport;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const margin = 40; const pageW = 595 - margin*2;
  const ACCENT = [37, 99, 235];
  const DARK = [20, 24, 33];

  doc.setFillColor(DARK[0], DARK[1], DARK[2]);
  doc.rect(0, 0, 595, 842, 'F');
  doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]);
  doc.rect(0, 0, 595, 8, 'F');

  const logoData = await tryFetchLogoDataUrl(target);
  let coverY = 260;
  if(logoData){
    try{
      doc.setFillColor(255,255,255);
      doc.roundedRect(247, 150, 100, 100, 8, 8, 'F');
      doc.addImage(logoData, 'PNG', 262, 165, 70, 70);
      coverY = 300;
    }catch(e){ /* skip logo if it fails to embed */ }
  }
  doc.setTextColor(255,255,255);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(30);
  doc.text(target, 297, coverY, { align: 'center' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(13);
  doc.setTextColor(180,190,205);
  doc.text('Competitive Intelligence Report', 297, coverY + 26, { align: 'center' });
  doc.setDrawColor(ACCENT[0], ACCENT[1], ACCENT[2]);
  doc.line(247, coverY + 45, 347, coverY + 45);
  doc.setFontSize(10);
  doc.text(industry, 297, coverY + 70, { align: 'center' });
  doc.text('vs. ' + competitors, 297, coverY + 88, { align: 'center' });
  doc.text(objective, 297, coverY + 106, { align: 'center' });
  doc.setFontSize(9);
  doc.setTextColor(120,130,145);
  doc.text('Generated ' + new Date().toLocaleDateString(), 297, coverY + 140, { align: 'center' });

  doc.addPage();
  let y = 60;

  function checkPageBreak(neededSpace){
    if(y + neededSpace > 790){ doc.addPage(); y = 50; }
  }

  function addHeader(text){
    checkPageBreak(40);
    y += 10;
    doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]);
    doc.rect(margin, y, 4, 16, 'F');
    doc.setTextColor(DARK[0], DARK[1], DARK[2]);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
    doc.text(text, margin + 12, y + 12);
    y += 26;
  }

  function addText(text, size, bold, gap, color){
    doc.setFontSize(size); doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setTextColor(color ? color[0] : 40, color ? color[1] : 44, color ? color[2] : 52);
    const lines = doc.splitTextToSize(text, pageW);
    lines.forEach(line=>{
      checkPageBreak(size*1.4);
      doc.text(line, margin, y); y += size*1.35;
    });
    y += gap||6;
  }

  addHeader('Overview');
  addText(`${industry}  ·  vs. ${competitors}  ·  ${objective}`, 9, false, 12, [110,118,132]);
  addHeader('Executive Summary');
  addText(data.executive_summary||'', 10, false, 12);

  if(data.benchmark_matrix && data.benchmark_matrix.rows){
    addHeader('Competitive Benchmarking Matrix');
    doc.autoTable({ startY: y, margin:{left:margin,right:margin}, head:[data.benchmark_matrix.columns], body:data.benchmark_matrix.rows, styles:{fontSize:8, cellPadding:4}, headStyles:{fillColor:ACCENT} });
    y = doc.lastAutoTable.finalY + 20;
  }

  if(data.swot){
    addHeader('SWOT Analysis');
    ['strengths','weaknesses','opportunities','threats'].forEach(k=>{
      checkPageBreak(20);
      addText(k.charAt(0).toUpperCase()+k.slice(1), 10, true, 2, ACCENT);
      (data.swot[k]||[]).forEach(i=>addText('•  '+i, 9, false, 1));
      y += 6;
    });
  }

  if(data.vulnerabilities && data.vulnerabilities.length){
    addHeader('Strategic Vulnerabilities');
    data.vulnerabilities.forEach(v=>addText('•  '+v, 9, false, 4));
    y += 4;
  }

  if(data.strategic_takeaways && data.strategic_takeaways.length){
    addHeader('Key Strategic Takeaways');
    data.strategic_takeaways.forEach(t=>addText('•  '+t, 9, false, 4));
    y += 4;
  }

  if(data.recommendations && data.recommendations.length){
    addHeader('Actionable Recommendations');
    data.recommendations.forEach(r=>{ addText(r.title, 10, true, 2, ACCENT); addText(r.detail, 9, false, 10); });
  }

  if(data._sources && data._sources.length){
    addHeader('Sources');
    data._sources.forEach((s,i)=>addText(`[${i+1}] ${s.title} — ${s.url}`, 8, false, 4, [110,118,132]));
  }

  try{
    const blob = doc.output('blob');
    const safeName = (target || 'report').replace(/[^a-z0-9]+/gi,'-').toLowerCase();
    downloadBlob(blob, `${safeName}-competitive-intel-report.pdf`);
  }catch(e){
    showError('PDF export failed: ' + (e && e.message ? e.message : 'unknown error'));
  }
}

/* ---------- EXAMPLES ---------- */

const EXAMPLE_CASES = [
  { industry: 'Online Food Delivery (India)', target: 'Zomato', competitors: 'Swiggy, ONDC-based apps, Magicpin', objective: 'Competitive positioning review', reportType: 'standard', extra: 'Focus on quick-commerce (Blinkit) as a strategic distraction vs. core food delivery margins.' },
  { industry: 'D2C Beauty & Personal Care (India)', target: 'Nykaa', competitors: 'Myntra Beauty, Purplle, Tira', objective: 'Market entry strategy', reportType: 'deepdive', extra: 'Weight Tier 2/3 city expansion specifically.' },
  { industry: 'Consumer Electronics — Audio Wearables (India)', target: 'boAt', competitors: 'Noise, OnePlus, Boult', objective: 'Brand perception audit', reportType: 'brief', extra: '' },
  { industry: 'Digital Payments & Fintech (India)', target: 'PhonePe', competitors: 'Google Pay, Paytm, Amazon Pay', objective: 'Competitive positioning review', reportType: 'standard', extra: 'Cover how each is diversifying beyond UPI (lending, insurance, wealth) as margins on payments compress.' },
  { industry: 'Ride-Hailing & Mobility (India)', target: 'Ola', competitors: 'Uber, Rapido, inDrive', objective: 'Product gap analysis', reportType: 'case', extra: '' }
];

function loadExample(){
  const ex = EXAMPLE_CASES[Math.floor(Math.random()*EXAMPLE_CASES.length)];
  document.getElementById('industry').value = ex.industry;
  document.getElementById('target').value = ex.target;
  document.getElementById('competitors').value = ex.competitors;
  document.getElementById('objective').value = ex.objective;
  document.getElementById('reportType').value = ex.reportType;
  document.getElementById('extraInstructions').value = ex.extra;
  document.getElementById('errorBox').classList.add('hidden');
  document.getElementById('setupCard').scrollIntoView({behavior:'smooth', block:'start'});
}

async function suggestCompetitors(){
  const industry = document.getElementById('industry').value.trim();
  const target = document.getElementById('target').value.trim();
  if(!industry || !target){ showError('Fill in Target Industry and Target Company first — the suggestion needs both.'); return; }
  const btn = document.getElementById('suggestBtn');
  if(btn){ btn.disabled = true; btn.textContent = '…'; }
  try{
    const result = await callAI(`For the company "${target}" in the "${industry}" industry, name their 3-4 most relevant real, direct competitors — the companies a strategy analyst would actually put in a competitive set for this company, not just other big names in the space. Return JSON: {"competitors": ["Name 1", "Name 2", "Name 3"]}`);
    const names = (result.competitors || []).filter(Boolean);
    if(names.length) document.getElementById('competitors').value = names.join(', ');
    else showError('Could not suggest competitors — try naming them yourself.');
  }catch(e){
    showError('Competitor suggestion failed: ' + (e && e.message ? e.message : 'unknown error'));
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = 'Suggest'; }
  }
}

function backToSetup(){
  document.getElementById('setupCard').classList.remove('hidden');
  document.getElementById('topActions').classList.add('hidden');
  document.getElementById('results').classList.add('hidden');
}

if(window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

async function parseUploadedFile(){
  const input = document.getElementById('uploadFile');
  const file = input && input.files && input.files[0];
  if(!file) return { text: '', name: '' };
  const name = file.name;
  const ext = name.split('.').pop().toLowerCase();
  try{
    if(ext === 'csv'){ const text = await file.text(); return { text: text.slice(0, 8000), name }; }
    if(ext === 'xlsx' || ext === 'xls'){
      const buf = await file.arrayBuffer();
      const wb = window.XLSX.read(buf, { type: 'array' });
      let out = '';
      wb.SheetNames.forEach(sn=>{ out += `--- Sheet: ${sn} ---\n` + window.XLSX.utils.sheet_to_csv(wb.Sheets[sn]) + '\n\n'; });
      return { text: out.slice(0, 8000), name };
    }
    if(ext === 'docx'){
      const buf = await file.arrayBuffer();
      const result = await window.mammoth.extractRawText({ arrayBuffer: buf });
      return { text: (result.value||'').slice(0, 8000), name };
    }
    if(ext === 'pdf'){
      const buf = await file.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
      let out = '';
      for(let p=1; p<=Math.min(pdf.numPages, 25); p++){
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        out += content.items.map(it=>it.str).join(' ') + '\n\n';
        if(out.length > 8000) break;
      }
      return { text: out.slice(0, 8000), name };
    }
    return { text: '', name };
  }catch(e){
    showError('Could not read the uploaded file (' + name + '): ' + (e && e.message ? e.message : 'unknown error'));
    return { text: '', name: '' };
  }
}

/* ---------- SAVED REPORTS (Supabase) ---------- */

async function saveReport(inputs, data){
  try{
    if(!currentUserId) return null;
    const { data: row, error } = await supabase.from('reports').insert({
      user_id: currentUserId,
      industry: inputs.industry, target: inputs.target, competitors: inputs.competitors,
      objective: inputs.objective, data: data, analyst: analystName || 'Unidentified analyst',
      verification: { status: 'unverified', note: '', at: null, by: null }
    }).select().single();
    if(error) throw error;
    if(currentReport) currentReport.savedId = row.id;
    loadSavedReports();
    return row.id;
  }catch(e){ return null; }
}

async function loadSavedReports(){
  const list = document.getElementById('savedList');
  if(!currentUserId){ list.innerHTML = '<div class="emptyNote">Sign in to see your saved reports.</div>'; return; }
  try{
    const { data: rows, error } = await supabase.from('reports').select('*').order('created_at', { ascending: false }).limit(20);
    if(error) throw error;
    if(!rows || !rows.length){ list.innerHTML = '<div class="emptyNote">No saved reports yet — run an analysis to save it here.</div>'; return; }
    let verified = 0, flagged = 0, reviewed = 0;
    let html = '';
    rows.forEach(r=>{
      const d = new Date(r.created_at);
      const v = r.verification || {};
      if(v.status === 'verified'){ verified++; reviewed++; }
      if(v.status === 'flagged'){ flagged++; reviewed++; }
      const vTag = v.status === 'verified' ? '<span style="color:var(--sage);">✓ verified</span>' : v.status === 'flagged' ? '<span style="color:var(--oxblood);">✕ flagged</span>' : '';
      const conf = r.data && r.data._confidence;
      const confTag = conf && conf.total ? `<span style="color:${conf.pct>=75?'var(--sage)':conf.pct>=50?'var(--amber)':'var(--oxblood)'};">${conf.pct}% grounded</span>` : '';
      html += `<div class="savedRow">
        <div class="savedMeta" data-id="${r.id}" style="flex:1;">
          <b>${esc(r.target)} <span style="color:var(--paper-dim); font-weight:400;">vs ${esc(r.competitors)}</span></b>
          <span>${esc(r.industry)} · ${esc(r.analyst||'Unidentified analyst')} · ${d.toLocaleDateString()}${confTag ? ' · '+confTag : ''}${vTag ? ' · '+vTag : ''}</span>
        </div>
        <button class="savedDel" data-del-id="${r.id}" title="Delete">✕</button>
      </div>`;
    });
    const statLine = reviewed > 0
      ? `<div class="emptyNote" style="margin-bottom:10px; font-style:normal;">Validated accuracy: <b style="color:var(--paper);">${verified}/${reviewed}</b> reviewed reports confirmed accurate${flagged ? `, ${flagged} flagged` : ''}.</div>`
      : `<div class="emptyNote" style="margin-bottom:10px;">No reports independently verified yet — open one and mark it after checking the sources.</div>`;
    list.innerHTML = statLine + html;
    list.querySelectorAll('.savedMeta').forEach(el=>{
      el.addEventListener('click', ()=> openSaved(el.getAttribute('data-id')));
    });
    list.querySelectorAll('.savedDel').forEach(el=>{
      el.addEventListener('click', (e)=>{ e.stopPropagation(); deleteSaved(el.getAttribute('data-del-id')); });
    });
  }catch(e){
    list.innerHTML = '<div class="emptyNote">Couldn\'t load saved reports.</div>';
  }
}

async function openSaved(id){
  try{
    const { data: r, error } = await supabase.from('reports').select('*').eq('id', id).single();
    if(error || !r) return;
    render(r.data, r.target, r.competitors, r.industry, r.objective);
    currentReport.savedId = id;
    currentReport.analyst = r.analyst;
    currentReport.verification = r.verification || { status:'unverified', note:'' };
    renderVerificationPanel();
    document.getElementById('setupCard').classList.add('hidden');
    document.getElementById('topActions').classList.remove('hidden');
    document.getElementById('status').textContent = 'VIEWING SAVED';
    document.getElementById('results').scrollIntoView({behavior:'smooth'});
  }catch(e){ showError('Could not open that saved report.'); }
}

async function deleteSaved(id){
  try{ await supabase.from('reports').delete().eq('id', id); loadSavedReports(); }catch(e){ /* best-effort */ }
}

function renderVerificationPanel(){
  const box = document.getElementById('verifyBox');
  if(!box || !currentReport) return;
  const v = currentReport.verification || { status:'unverified', note:'' };
  const statusLabel = v.status === 'verified' ? 'Marked accurate' : v.status === 'flagged' ? 'Flagged with issues' : 'Not yet reviewed';
  box.innerHTML = `<div class="panel" style="margin-top:0;">
    <p class="panel-kicker">Verification</p>
    <p class="emptyNote" style="font-style:normal; margin-bottom:12px;">Status: <b style="color:${v.status==='verified'?'var(--sage)':v.status==='flagged'?'var(--oxblood)':'var(--paper)'}">${statusLabel}</b>${v.by ? ` · by ${esc(v.by)}` : ''}</p>
    <div class="field"><label>Note (what did you check?)</label><textarea id="verifyNote" rows="2" placeholder="e.g. Confirmed FY25 revenue against investor presentation">${esc(v.note||'')}</textarea></div>
    <div class="topActions" style="margin-bottom:0;">
      <button class="btn2" id="verifyOkBtn">✓ Mark accurate</button>
      <button class="btn2" id="verifyFlagBtn">✕ Flag issues</button>
    </div>
  </div>`;
  document.getElementById('verifyOkBtn').addEventListener('click', ()=>setVerification('verified'));
  document.getElementById('verifyFlagBtn').addEventListener('click', ()=>setVerification('flagged'));
}

async function setVerification(status){
  if(!currentReport || !currentReport.savedId){ showError('Save this report first (it saves automatically after a run) before verifying it.'); return; }
  const note = document.getElementById('verifyNote').value.trim();
  const verification = { status, note, at: Date.now(), by: analystName || 'Unidentified analyst' };
  currentReport.verification = verification;
  try{ await supabase.from('reports').update({ verification }).eq('id', currentReport.savedId); }catch(e){ /* best-effort */ }
  renderVerificationPanel();
  loadSavedReports();
}

/* ---------- MAIN ANALYSIS RUN ---------- */

async function runAnalysis(){
  if(!currentUserId){ showError('Please sign in first.'); return; }
  const industry = document.getElementById('industry').value.trim();
  const target = document.getElementById('target').value.trim();
  const competitors = document.getElementById('competitors').value.trim();
  const objective = document.getElementById('objective').value;
  const reportType = document.getElementById('reportType').value;
  const extraInstructions = document.getElementById('extraInstructions').value.trim();

  if(!industry || !target || !competitors){ showError("Fill in industry, target company, and at least 2 competitors."); return; }

  document.getElementById('runBtn').disabled = true;
  document.getElementById('errorBox').classList.add('hidden');
  document.getElementById('results').classList.add('hidden');
  document.getElementById('loading').classList.remove('hidden');
  document.getElementById('status').textContent = 'RUNNING';

  document.getElementById('loadingText').textContent = 'Reading uploaded file…';
  const uploaded = await parseUploadedFile();
  const uploadedContext = uploaded.text;
  const uploadedFileName = uploaded.name;

  const webContext = await fetchWebContext(industry, target, competitors, (q)=>{
    document.getElementById('loadingText').textContent = 'Searching — ' + q;
  });
  document.getElementById('loadingText').textContent = 'Synthesizing report…';

  const reportTypeInstructions = {
    standard: 'Standard depth and tone — balanced detail across all sections.',
    brief: 'Executive brief: be concise everywhere — shorter executive summary (2-3 sentences), fewer but sharper SWOT/takeaway bullets (3 each), tight recommendation detail (1 sentence each).',
    deepdive: 'Analyst deep-dive: go longer and more detailed everywhere — richer executive summary (5-6 sentences), 6-8 items per SWOT quadrant, more granular benchmark_matrix rows.',
    case: 'Case-interview style: frame the benchmark_matrix and SWOT explicitly around structured frameworks, and make strategic_takeaways read like case conclusions building toward the recommendations.'
  };

  const prompt = `You are an elite market intelligence and corporate strategy analyst. Run a full competitive intelligence analysis for:

Industry: ${industry}
Target Company: ${target}
Competitor Set: ${competitors}
Primary Objective: ${objective}
Report Style: ${reportTypeInstructions[reportType] || reportTypeInstructions.standard}
${extraInstructions ? `Additional instructions from the requester (follow these closely): ${extraInstructions}\n` : ''}
${webContext.text ? `Below are live research sources gathered for this run. Ground your analysis in these wherever relevant, and cite the source number [n] inline wherever you use something from them:\n\n${webContext.text}\n\nRULE: for every numeric or factual claim (revenue, market share, funding, pricing, headcount), you must either (a) cite the [n] source it came from, or (b) explicitly mark it as "(estimate)". If two sources disagree, say so explicitly.` : ''}${uploadedContext ? `\nThe analyst also uploaded supporting data (file: ${uploadedFileName}). Treat this as a primary, high-trust source — cite it as "(per uploaded data)" wherever used:\n\n${uploadedContext}\n` : ''}Use your own knowledge only to fill genuine gaps, marking those as "(estimate)". Be specific and concrete, not generic.

Return a JSON object matching exactly this schema:

{
  "executive_summary": "3-5 sentence 'so what' summary, specific to the named companies",
  "footprint": {"${target}": "1-2 sentences: scale, geography, financial position", "<competitor1>": "...", "<competitor2>": "..."},
  "benchmark_matrix": {
    "columns": ["Vector", "${target}", "<competitor1>", "<competitor2>", "..."],
    "rows": [ ["Pricing Strategy", "...", "...", "..."], ["Product/Service Line", "...", "...", "..."], ["Positioning & USP", "...", "...", "..."], ["Marketing Channels", "...", "...", "..."], ["Distribution/GTM", "...", "...", "..."], ["Financial Position", "...", "...", "..."] ]
  },
  "swot": { "strengths": ["...", "..."], "weaknesses": ["...", "..."], "opportunities": ["...", "..."], "threats": ["...", "..."] },
  "scores": {
    "axes": ["Pricing Power", "Product Strength", "Brand/Marketing", "Distribution Reach", "Financial Strength"],
    "companies": { "${target}": [1,1,1,1,1], "<competitor1>": [1,1,1,1,1] }
  },
  "vulnerabilities": ["Specific area where a named competitor is winning share and why, with the mechanism", "..."],
  "strategic_takeaways": ["...", "...", "..."],
  "recommendations": [ {"title": "Short action title", "detail": "2-3 sentence concrete next step tied to the objective"}, {"title": "...", "detail": "..."}, {"title": "...", "detail": "..."} ]
}

Include exactly 6 benchmark_matrix rows as listed above, populated for every company in the competitor set. Include 4-6 items per SWOT quadrant. Rate every company on each of the 5 fixed axes on a 1-5 integer scale, genuinely differentiated. Include 3-4 vulnerabilities naming the specific competitor and mechanism. Include exactly 3 recommendations.`;

  try{
    const data = await callAI(prompt);
    data._sources = webContext.sources;
    data._uploadedFile = uploadedFileName || null;
    data._confidence = computeConfidence(data);
    render(data, target, competitors, industry, objective);
    document.getElementById('status').textContent = 'COMPLETE';
    document.getElementById('setupCard').classList.add('hidden');
    document.getElementById('topActions').classList.remove('hidden');
    saveReport({industry, target, competitors, objective}, data).then(()=> renderVerificationPanel());
  }catch(e){
    showError("Analysis failed: " + e.message);
    document.getElementById('status').textContent = 'ERROR';
  }finally{
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('runBtn').disabled = false;
  }
}

function showError(msg){
  const box = document.getElementById('errorBox');
  box.innerHTML = '<div class="err">' + esc(msg) + '</div>';
  box.classList.remove('hidden');
  box.scrollIntoView({behavior:'smooth', block:'center'});
}

function computeConfidence(d){
  const parts = [
    d.executive_summary,
    JSON.stringify(d.benchmark_matrix && d.benchmark_matrix.rows || []),
    JSON.stringify(d.vulnerabilities || []),
    JSON.stringify(d.strategic_takeaways || []),
    JSON.stringify((d.recommendations||[]).map(r=>r.detail))
  ].join(' ');
  const cited = (parts.match(/\[\d+\]/g) || []).length;
  const estimated = (parts.match(/\(estimate\)/gi) || []).length;
  const total = cited + estimated;
  const pct = total > 0 ? Math.round((cited/total)*100) : null;
  return { cited, estimated, total, pct };
}

function palette(i){ const c = ['#c99a47','#b1584a','#6f9c7e','#7c8bb0','#9b7fc2','#5aa8a8']; return c[i % c.length]; }

function renderRadar(scores){
  const axes = scores.axes || [];
  const companies = Object.keys(scores.companies || {});
  if(!axes.length || !companies.length) return '';
  const n = axes.length, R = 110, cx = 150, cy = 130;
  const angle = i => (Math.PI*2*i/n) - Math.PI/2;
  const pt = (i, val) => { const r = (val/5)*R; return [cx + r*Math.cos(angle(i)), cy + r*Math.sin(angle(i))]; };
  let svg = `<svg viewBox="0 0 300 270" style="width:100%; max-width:340px; display:block; margin:0 auto;">`;
  [0.2,0.4,0.6,0.8,1].forEach(f=>{
    const ring = axes.map((_,i)=>pt(i,5*f).join(',')).join(' ');
    svg += `<polygon points="${ring}" fill="none" stroke="var(--line)" stroke-width="1"/>`;
  });
  axes.forEach((a,i)=>{
    const [x,y] = pt(i,5);
    svg += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="var(--line)" stroke-width="1"/>`;
    const lx = cx + (R+18)*Math.cos(angle(i)), ly = cy + (R+18)*Math.sin(angle(i));
    svg += `<text x="${lx}" y="${ly}" font-size="8.5" fill="var(--paper-dim)" text-anchor="middle" dominant-baseline="middle">${esc(a)}</text>`;
  });
  companies.forEach((name,ci)=>{
    const vals = scores.companies[name] || [];
    const pts = vals.map((v,i)=>pt(i,v).join(',')).join(' ');
    const col = palette(ci);
    svg += `<polygon points="${pts}" fill="${col}" fill-opacity="0.12" stroke="${col}" stroke-width="2"/>`;
  });
  svg += `</svg>`;
  let legend = `<div class="legend">${companies.map((c,i)=>`<span><span class="dot" style="background:${palette(i)}"></span>${esc(c)}</span>`).join('')}</div>`;
  let bars = '';
  companies.forEach((name,ci)=>{
    const vals = scores.companies[name] || [];
    const avg = vals.length ? (vals.reduce((a,b)=>a+b,0)/vals.length) : 0;
    bars += `<div class="scorebar-row"><div class="scorebar-label">${esc(name)}</div>
      <div class="scorebar-track"><div class="scorebar-fill" style="width:${(avg/5*100).toFixed(0)}%; background:${palette(ci)}"></div></div>
      <div class="scorebar-val">${avg.toFixed(1)}</div></div>`;
  });
  return `<div class="entry"><div class="entryHead"><span class="folio">D</span><h2 class="entryTitle">Competitive Strength Index</h2></div>
    <div class="entryBody">${svg}${legend}
    <div style="margin-top:16px; padding-top:14px; border-top:1px solid var(--line);">
      <div style="font-size:12.5px; color:var(--paper-dim); margin-bottom:10px; font-weight:500;">Composite score, average of ${axes.length} axes</div>
      ${bars}
    </div></div></div>`;
}

function renderConfidenceBadge(c){
  if(!c || c.total === 0) return '';
  const color = c.pct >= 75 ? 'var(--sage)' : c.pct >= 50 ? 'var(--amber)' : 'var(--oxblood)';
  return `<div style="margin-top:14px; padding-top:12px; border-top:1px solid var(--line); display:flex; align-items:center; gap:10px;">
    <div style="font-family:var(--data); font-size:20px; font-weight:600; color:${color};">${c.pct}%</div>
    <div class="metaLine" style="margin-top:0;">grounded — <b style="color:var(--paper);">${c.cited}</b> cited claim${c.cited===1?'':'s'}, <b style="color:var(--paper);">${c.estimated}</b> marked as estimate${c.estimated===1?'':'s'}</div>
  </div>`;
}

function render(d, target, competitors, industry, objective){
  currentReport = { data: d, target, competitors, industry, objective };
  const metaLine = [industry, objective, `vs. ${competitors}`].filter(Boolean).join(' — ');
  const attribution = analystName ? `Prepared by ${analystName}` : '';
  let html = '';

  html += `<div class="entry"><div class="entryHead"><span class="folio">A</span><h2 class="entryTitle">${esc(target)}</h2></div>
    <div class="entryBody"><div class="metaLine">${esc(metaLine)}</div>
    ${attribution ? `<div class="metaLine" style="opacity:.7;">${esc(attribution)}</div>` : ''}
    <p class="exec" style="margin-top:14px;">${esc(d.executive_summary||'')}</p>
    ${renderConfidenceBadge(d._confidence)}
    </div></div>`;

  if(d._sources && d._sources.length){
    html += `<div class="entry"><div class="entryHead"><span class="folio">B</span><h2 class="entryTitle">Live Web Sources</h2></div>
    <div class="entryBody">
    ${d._uploadedFile ? `<p class="metaLine" style="margin-bottom:10px;">+ analyst-uploaded file: <b style="color:var(--paper);">${esc(d._uploadedFile)}</b></p>` : ''}
    <ol style="margin:0; padding-left:18px; font-size:12.5px; line-height:1.8;">
    ${d._sources.map(s=>`<li><a href="${esc(s.url)}" target="_blank" rel="noopener" style="color:var(--brass);">${esc(s.title)}</a>${s.fullText ? ' <span style="color:var(--sage); font-size:11px;">· full text read</span>' : ''}</li>`).join('')}
    </ol></div></div>`;
  }

  if(d.footprint){
    html += `<div class="entry"><div class="entryHead"><span class="folio">B</span><h2 class="entryTitle">Operational Footprint</h2></div>
    <div class="entryBody"><div class="overflow"><table><tbody>`;
    Object.keys(d.footprint).forEach(k=>{ html += `<tr><td style="width:32%; font-family:var(--sans); font-weight:500;">${esc(k)}</td><td style="font-family:var(--sans); font-weight:400;">${esc(d.footprint[k])}</td></tr>`; });
    html += `</tbody></table></div></div></div>`;
  }

  if(d.benchmark_matrix && d.benchmark_matrix.columns){
    html += `<div class="entry"><div class="entryHead"><span class="folio">D</span><h2 class="entryTitle">Competitive Benchmarking Matrix</h2></div>
    <div class="entryBody"><div class="overflow"><table><thead><tr>${d.benchmark_matrix.columns.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>`;
    (d.benchmark_matrix.rows||[]).forEach(row=>{ html += '<tr>' + row.map(cell=>`<td>${esc(cell)}</td>`).join('') + '</tr>'; });
    html += `</tbody></table></div></div></div>`;
  }

  if(d.swot){
    html += `<div class="entry"><div class="entryHead"><span class="folio">D</span><h2 class="entryTitle">SWOT & Gap Analysis</h2></div>
    <div class="entryBody"><div class="swotCross">
      <div class="swotQ q-s"><h4>Strengths</h4><ul>${(d.swot.strengths||[]).map(s=>`<li>${esc(s)}</li>`).join('')}</ul></div>
      <div class="swotQ q-w"><h4>Weaknesses</h4><ul>${(d.swot.weaknesses||[]).map(s=>`<li>${esc(s)}</li>`).join('')}</ul></div>
      <div class="swotQ q-o"><h4>Opportunities</h4><ul>${(d.swot.opportunities||[]).map(s=>`<li>${esc(s)}</li>`).join('')}</ul></div>
      <div class="swotQ q-t"><h4>Threats</h4><ul>${(d.swot.threats||[]).map(s=>`<li>${esc(s)}</li>`).join('')}</ul></div>
    </div></div></div>`;
  }

  if(d.scores) html += renderRadar(d.scores);

  if(d.vulnerabilities && d.vulnerabilities.length){
    html += `<div class="entry"><div class="entryHead"><span class="folio">D</span><h2 class="entryTitle">Strategic Vulnerabilities</h2></div>
    <div class="entryBody">${d.vulnerabilities.map(v=>`<div class="vuln"><p>${esc(v)}</p></div>`).join('')}</div></div>`;
  }

  if(d.strategic_takeaways && d.strategic_takeaways.length){
    html += `<div class="entry"><div class="entryHead"><span class="folio">E</span><h2 class="entryTitle">Key Strategic Takeaways</h2></div>
    <div class="entryBody"><ul style="margin:0; padding-left:18px; font-size:13.5px; line-height:1.8;">${d.strategic_takeaways.map(t=>`<li>${esc(t)}</li>`).join('')}</ul></div></div>`;
  }

  if(d.recommendations && d.recommendations.length){
    html += `<div class="entry"><div class="entryHead"><span class="folio">E</span><h2 class="entryTitle">Actionable Recommendations</h2></div>
    <div class="entryBody">${d.recommendations.map(r=>`<div class="reco"><b>${esc(r.title)}</b><p>${esc(r.detail)}</p></div>`).join('')}</div></div>`;
  }

  html += `<div id="verifyBox"></div>`;

  document.getElementById('results').innerHTML = html;
  document.getElementById('results').classList.remove('hidden');
}

/* ---------- WIRE UP BUTTONS ---------- */

Object.assign(window, {
  handleAuthSubmit, toggleAuthMode, handleLogout,
  runAnalysis, suggestCompetitors, loadExample, backToSetup,
  downloadWord, downloadPdf
});

