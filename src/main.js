import { supabase } from './supabase.js';

function esc(s){ if(s===undefined||s===null) return ''; return String(s).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
const $ = (id) => document.getElementById(id);

let currentUserId = null;
let analystName = '';
let currentReport = null;

/* ---------- AUTH ---------- */

let authMode = 'signin';

function setAuthMode(mode){
  authMode = mode;
  $('tabSignIn').classList.toggle('active', mode === 'signin');
  $('tabSignUp').classList.toggle('active', mode === 'signup');
  $('authSubmitBtn').textContent = mode === 'signin' ? 'Sign In' : 'Create Account';
  $('authHeading').textContent = mode === 'signin' ? 'Welcome back' : 'Create your account';
  $('authSub').textContent = mode === 'signin' ? 'Sign in to open your case files.' : 'Sign up to start building competitive reports.';
  $('authError').innerHTML = '';
}

async function handleAuthSubmit(){
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  const errBox = $('authError');
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
  if(session && session.user){
    $('authScreen').classList.add('hidden');
    $('appRoot').classList.remove('hidden');
    $('userLabel').textContent = session.user.email;
    currentUserId = session.user.id;
    analystName = session.user.email;
    loadSavedReports();
  } else {
    $('authScreen').classList.remove('hidden');
    $('appRoot').classList.add('hidden');
    currentUserId = null;
  }
}

$('authPassword').addEventListener('keydown', (e)=>{ if(e.key === 'Enter') handleAuthSubmit(); });
supabase.auth.onAuthStateChange((_event, session)=> updateAuthUI(session));
supabase.auth.getSession().then(({data})=> updateAuthUI(data.session));

/* ---------- AI (Gemini + Groq backup) ---------- */

async function callGemini(prompt){
  const res = await fetch('/api/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'gemini',
      prompt
    })
  });

  const json = await res.json();

  if(!res.ok){
    throw new Error(json.error || 'Gemini request failed.');
  }

  if(!json.data){
    throw new Error('Gemini returned no usable data.');
  }

  return json.data;
}

async function callGroq(prompt){
  const res = await fetch('/api/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'groq',
      prompt
    })
  });

  const json = await res.json();

  if(!res.ok){
    throw new Error(json.error || 'Backup AI request failed.');
  }

  if(!json.data){
    throw new Error('Backup AI returned no usable data.');
  }

  return json.data;
}

async function callAI(prompt, fallbackPrompt){
  let geminiError;
  try{
    return await callGemini(prompt);
  }catch(e){
    geminiError = e;
  }
  try{
    // The backup AI has a smaller input limit, so it gets the trimmed-down prompt.
    return await callGroq(fallbackPrompt || prompt);
  }catch(e2){
    throw new Error(geminiError.message + '  |  ' + e2.message);
  }
}

/* ---------- WEB RESEARCH (Tavily) ---------- */

async function tavilySearch(query, maxResults = 5){
  const res = await fetch('/api/research', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      maxResults
    })
  });

  if(!res.ok){
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error || 'Research request failed.');
  }

  const json = await res.json();

  return Array.isArray(json.results) ? json.results : [];
}

async function fetchWebContext(industry, target, competitors, onProgress, spec){
  spec = spec || REPORT_SPECS.standard;
  const compList = competitors.split(',').map(s=>s.trim()).filter(Boolean);
  const queries = [
    `${target} ${industry} revenue market share financials 2026`,
    `${target} vs ${compList.join(' vs ')} ${industry} comparison`
  ];
  if(!spec.lean){
    queries.push(...compList.slice(0,4).map(c => `${c} ${industry} revenue positioning 2026`));
  }
  if(spec.deep){
    queries.push(
      `${industry} market size growth trends regulation 2026`,
      `${target} strategy recent developments 2026`
    );
  }
  let sources = [];
  for(const q of queries){
    if(onProgress) onProgress(q);
    try{
      const results = await tavilySearch(q, spec.maxResults);
      results.forEach(r=>{
        if(r.url && !sources.find(s=>s.url===r.url)){
          sources.push({
            title: r.title || r.url,
            url: r.url,
            description: r.content ? r.content.slice(0,300) : '',
            fullText: r.raw_content ? r.raw_content.slice(0, spec.rawChars) : null
          });
        }
      });
    }catch(e){ /* one query failing shouldn't kill the run */ }
  }
  sources = sources.slice(0, spec.sourceCap);
  const fmt = (list, chars) => list.map((s,i)=>{
    const tag = s.fullText ? 'FULL PAGE CONTENT' : 'snippet only';
    const body = (s.fullText || s.description).slice(0, chars);
    return `[${i+1}] ${s.title} (${s.url}) — ${tag}:\n${body}`;
  }).join('\n\n');
  // textLight = the same numbering, but fewer/shorter sources, for the backup AI's smaller input limit
  return { text: fmt(sources, spec.rawChars), textLight: fmt(sources.slice(0, 8), 1000), sources };
}

/* ---------- REPORT TYPES: length and depth ---------- */

const STD_ROWS = ['Pricing Strategy','Product/Service Line','Positioning & USP','Marketing Channels','Distribution/GTM','Financial Position'];

const REPORT_SPECS = {
  brief: {
    styleNote: 'Executive brief for a board-level skim: ruthlessly concise, lead with the conclusion, no background or filler. Every sentence must earn its place.',
    summary: '2-3 sentences', footprint: '1 short sentence',
    rows: ['Pricing Strategy','Positioning & USP','Distribution/GTM','Financial Position'],
    cell: 'under 15 words per cell', swot: '2-3 short bullets (under 12 words each)',
    vulns: 2, vulnLen: '1 sentence each', takeaways: 2, recos: 2, recoLen: '1 sentence each',
    marketContext: false, lean: true, deep: false, maxResults: 3, rawChars: 1200, sourceCap: 8
  },
  standard: {
    styleNote: 'Standard depth and tone: balanced detail across all sections.',
    summary: '3-5 sentences', footprint: '1-2 sentences',
    rows: STD_ROWS,
    cell: '1-2 sentences per cell', swot: '4-5 bullets',
    vulns: 3, vulnLen: '1-2 sentences each', takeaways: 3, recos: 3, recoLen: '2-3 sentences each',
    marketContext: false, lean: false, deep: false, maxResults: 5, rawChars: 2200, sourceCap: 15
  },
  deepdive: {
    styleNote: 'Analyst deep-dive: exhaustive and evidence-heavy. Explain mechanisms and second-order effects, use specific numbers, dates and named examples wherever the sources allow, and never stay generic. This report should be roughly three times as long and detailed as a standard one.',
    summary: '6-8 sentences', footprint: '4-6 sentences covering scale, geography, business mix, financials and recent strategic moves',
    rows: [...STD_ROWS, 'Customer Segments & Geography', 'Technology & Operations'],
    cell: '2-4 sentences per cell with specific evidence', swot: '6-8 detailed bullets (each 1-2 sentences)',
    vulns: 5, vulnLen: '3-4 sentences each explaining the mechanism', takeaways: 6, recos: 5,
    recoLen: '4-5 sentences each with a first step, who should own it, and how success would be measured',
    marketContext: true, lean: false, deep: true, maxResults: 8, rawChars: 3500, sourceCap: 25
  },
  case: {
    styleNote: 'Case-interview style: structured, framework-driven and MECE. Frame the analysis with classic case-prep logic, and write the takeaways as a case conclusion in which each one builds on the last and leads directly to the recommendations.',
    summary: '3-4 sentences framed as situation, complication, answer', footprint: '2 sentences',
    rows: STD_ROWS,
    cell: '1-2 sentences per cell, framework-oriented', swot: '4-5 bullets',
    vulns: 3, vulnLen: '2 sentences each', takeaways: 4, recos: 3, recoLen: '3 sentences each with a clear rationale',
    marketContext: false, lean: false, deep: false, maxResults: 5, rawChars: 2200, sourceCap: 15
  }
};

function buildPrompt(spec, c){
  const rowsJson = spec.rows.map(r => `["${r}", "...", "...", "..."]`).join(', ');
  const schema = `{
  "executive_summary": "${spec.summary}, specific to the named companies — the 'so what'",
  "footprint": {"${c.target}": "${spec.footprint}: scale, geography, financial position", "<competitor1>": "...", "<competitor2>": "..."},${spec.marketContext ? `
  "market_context": "2-3 paragraphs separated by a blank line: market size, growth drivers, regulation and the structural trends shaping this industry, with cited figures",` : ''}
  "benchmark_matrix": {
    "columns": ["Vector", "${c.target}", "<competitor1>", "<competitor2>", "..."],
    "rows": [ ${rowsJson} ]
  },
  "swot": { "strengths": ["...", "..."], "weaknesses": ["...", "..."], "opportunities": ["...", "..."], "threats": ["...", "..."] },
  "scores": {
    "axes": ["Pricing Power", "Product Strength", "Brand/Marketing", "Distribution Reach", "Financial Strength"],
    "companies": { "${c.target}": [1,1,1,1,1], "<competitor1>": [1,1,1,1,1] }
  },
  "vulnerabilities": ["Specific area where a named competitor is winning share and why, with the mechanism", "..."],
  "strategic_takeaways": ["...", "..."],
  "recommendations": [ {"title": "Short action title", "detail": "concrete next step tied to the objective"} ]
}`;

  const requirements = `
LENGTH AND DEPTH REQUIREMENTS — MANDATORY.

These requirements define the minimum expected depth of the report. Do not produce a generic template response.

EXECUTIVE SUMMARY:
${spec.summary}

FOOTPRINT:
${spec.footprint}
For every named company, explain relevant scale, geography, business model, financial/business position, and other information supported by the research.

BENCHMARK MATRIX:
Create exactly ${spec.rows.length} rows (${spec.rows.join(', ')}).
Every row must contain meaningful, company-specific information. Do not use generic filler.

SECTION DETAIL:
${spec.cell}

SWOT:
${spec.swot}
Every SWOT point must be specific to the target company and grounded in the supplied research. Where evidence is insufficient, say so rather than inventing a claim.

SCORES:
Every company must be rated on all 5 axes using 1–5 integers.
Scores must be differentiated and supported by the research. Do not assign arbitrary or identical scores.

VULNERABILITIES:
${spec.vulns}
Each vulnerability must identify the specific issue, the relevant evidence, and why it matters.

STRATEGIC TAKEAWAYS:
Exactly ${spec.takeaways} strategic takeaways.
Each takeaway must explain:
1. What the evidence shows.
2. Why it matters.
3. What strategic implication follows.

RECOMMENDATIONS:
Exactly ${spec.recos} recommendations.
Each recommendation must be tied to the stated objective and supported by the research.
${spec.recoLen}

EVIDENCE DISCIPLINE:
- Separate directly supported facts from analytical interpretation.
- Do not present assumptions as facts.
- Do not invent financial figures, market shares, management statements, competitors, or events.
- When evidence is insufficient, explicitly state "Insufficient evidence".
- Prefer specific evidence over generic business language.
- Major findings should be traceable to the supplied sources.

ANALYTICAL DEPTH:
${spec.deep
  ? `This is a DEEP-DIVE analysis. Go beyond description.
Explain mechanisms, causes, implications, competitive dynamics, financial/business drivers, and strategic consequences wherever the evidence supports them.
Connect findings across sections instead of treating each section as isolated.
Use relevant analytical frameworks only when they genuinely help answer the objective.
Do not add frameworks merely for decoration.`
  : `Match the requested report depth. Do not artificially inflate the report with repetitive prose or irrelevant frameworks.`}

FRAMEWORK DISCIPLINE:
Use SWOT and the requested analytical structures only where supported by evidence.
If another framework would materially improve the analysis, use it only when relevant to the objective and available evidence.
Never force a framework simply to make the report appear more sophisticated.

SOURCE DISCIPLINE:
Use the supplied research evidence as the basis for analysis.
Do not manufacture citations or sources.
When multiple sources provide conflicting information, acknowledge the discrepancy rather than silently choosing one.

QUALITY BAR:
The report should read like analyst work, not an AI-generated generic business essay.
Prioritize specificity, evidence, reasoning, and actionable insight over repetition or unnecessary length.
`;
  return `You are an elite market intelligence and corporate strategy analyst. Run a full competitive intelligence analysis for:

Industry: ${c.industry}
Target Company: ${c.target}
Competitor Set: ${c.competitors}
Primary Objective: ${c.objective}
Report Style: ${spec.styleNote}
${c.extraInstructions ? `Additional instructions from the requester (follow these closely): ${c.extraInstructions}\n` : ''}
${c.webText ? `Below are live research sources gathered for this run. Ground your analysis in these wherever relevant, and cite the source number [n] inline wherever you use something from them:\n\n${c.webText}\n\nRULE: for every numeric or factual claim (revenue, market share, funding, pricing, headcount), you must either (a) cite the [n] source it came from, or (b) explicitly mark it as "(estimate)". If two sources disagree, say so explicitly.` : ''}${c.uploadedContext ? `\nThe analyst also uploaded supporting data (file: ${c.uploadedFileName}). Treat this as a primary, high-trust source — cite it as "(per uploaded data)" wherever used:\n\n${c.uploadedContext}\n` : ''}Use your own knowledge only to fill genuine gaps, marking those as "(estimate)". Be specific and concrete, not generic.

Return a JSON object matching exactly this schema:

${schema}

${requirements}`;
}

/* ---------- DOWNLOADS ---------- */

function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

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
  if(data.market_context){
    children.push(H('Market Context'));
    String(data.market_context).split(/\n\s*\n/).forEach(p=>children.push(P(p)));
  }
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

  const coverY = 320;
  const logoData = await tryFetchLogoDataUrl(target);
  let logoDrawn = false;
  if(logoData){
    try{
      doc.setFillColor(255,255,255);
      doc.circle(297, 220, 50, 'F');
      doc.addImage(logoData, 'PNG', 267, 190, 60, 60);
      logoDrawn = true;
    }catch(e){ /* fall through to the generic badge */ }
  }
  if(!logoDrawn){
    doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]);
    doc.circle(297, 220, 50, 'F');
    doc.setTextColor(255,255,255);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(42);
    doc.text((target || '?').trim().charAt(0).toUpperCase(), 297, 236, { align: 'center' });
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
  if(data.market_context){
    addHeader('Market Context');
    String(data.market_context).split(/\n\s*\n/).forEach(p=>addText(p, 10, false, 8));
  }

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

/* ---------- EXAMPLES / FORM HELPERS ---------- */

const EXAMPLE_CASES = [
  { industry: 'Online Food Delivery (India)', target: 'Zomato', competitors: 'Swiggy, ONDC-based apps, Magicpin', objective: 'Competitive positioning review', reportType: 'standard', extra: 'Focus on quick-commerce (Blinkit) as a strategic distraction vs. core food delivery margins.' },
  { industry: 'D2C Beauty & Personal Care (India)', target: 'Nykaa', competitors: 'Myntra Beauty, Purplle, Tira', objective: 'Market entry strategy', reportType: 'deepdive', extra: 'Weight Tier 2/3 city expansion specifically.' },
  { industry: 'Consumer Electronics — Audio Wearables (India)', target: 'boAt', competitors: 'Noise, OnePlus, Boult', objective: 'Brand perception audit', reportType: 'brief', extra: '' },
  { industry: 'Digital Payments & Fintech (India)', target: 'PhonePe', competitors: 'Google Pay, Paytm, Amazon Pay', objective: 'Competitive positioning review', reportType: 'standard', extra: 'Cover how each is diversifying beyond UPI (lending, insurance, wealth) as margins on payments compress.' },
  { industry: 'Ride-Hailing & Mobility (India)', target: 'Ola', competitors: 'Uber, Rapido, inDrive', objective: 'Product gap analysis', reportType: 'case', extra: '' }
];

function renderExampleChips(){
  const box = $('exampleChips');
  box.innerHTML = '';
  [0, 1, 3].forEach(i=>{
    const ex = EXAMPLE_CASES[i];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.textContent = `${ex.target} vs ${ex.competitors.split(',')[0].trim()}`;
    btn.addEventListener('click', ()=> loadExample(i));
    box.appendChild(btn);
  });
}

function loadExample(i){
  const idx = (typeof i === 'number') ? i : Math.floor(Math.random()*EXAMPLE_CASES.length);
  const ex = EXAMPLE_CASES[idx];
  $('industry').value = ex.industry;
  $('target').value = ex.target;
  $('competitors').value = ex.competitors;
  $('objective').value = ex.objective;
  $('reportType').value = ex.reportType;
  $('extraInstructions').value = ex.extra;
  $('errorBox').classList.add('hidden');
  $('setupCard').scrollIntoView({behavior:'smooth', block:'start'});
}

async function suggestCompetitors(){
  const industry = $('industry').value.trim();
  const target = $('target').value.trim();
  if(!industry || !target){ showError('Fill in Target Industry and Target Company first — the suggestion needs both.'); return; }
  const btn = $('suggestBtn');
  if(btn){ btn.disabled = true; btn.textContent = '…'; }
  try{
    const result = await callAI(`For the company "${target}" in the "${industry}" industry, name their 3-4 most relevant real, direct competitors — the companies a strategy analyst would actually put in a competitive set for this company, not just other big names in the space. Return JSON: {"competitors": ["Name 1", "Name 2", "Name 3"]}`);
    const names = (result.competitors || []).filter(Boolean);
    if(names.length) $('competitors').value = names.join(', ');
    else showError('Could not suggest competitors — try naming them yourself.');
  }catch(e){
    showError('Competitor suggestion failed: ' + (e && e.message ? e.message : 'unknown error'));
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = 'Suggest'; }
  }
}

function backToSetup(){
  currentReport = null;
  ['industry','target','competitors','extraInstructions'].forEach(id=>{ $(id).value = ''; });
  $('uploadFile').value = '';
  $('results').classList.add('hidden');
  $('topActions').classList.add('hidden');
  $('errorBox').classList.add('hidden');
  $('emptyState').classList.remove('hidden');
  $('status').textContent = 'READY';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

if(window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

async function parseUploadedFile(){
  const input = $('uploadFile');
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
  const list = $('savedList');
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
          <span>${esc(r.industry)} · ${d.toLocaleDateString()}${confTag ? ' · '+confTag : ''}${vTag ? ' · '+vTag : ''}</span>
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
    $('industry').value = r.industry || '';
    $('target').value = r.target || '';
    $('competitors').value = r.competitors || '';
    if(r.objective) $('objective').value = r.objective;
    $('errorBox').classList.add('hidden');
    $('emptyState').classList.add('hidden');
    render(r.data, r.target, r.competitors, r.industry, r.objective);
    currentReport.savedId = id;
    currentReport.analyst = r.analyst;
    currentReport.verification = r.verification || { status:'unverified', note:'' };
    renderVerificationPanel();
    $('topActions').classList.remove('hidden');
    $('status').textContent = 'VIEWING SAVED';
    $('rightCol').scrollIntoView({behavior:'smooth', block:'start'});
  }catch(e){ showError('Could not open that saved report.'); }
}

async function deleteSaved(id){
  try{ await supabase.from('reports').delete().eq('id', id); loadSavedReports(); }catch(e){ /* best-effort */ }
}

function renderVerificationPanel(){
  const box = $('verifyBox');
  if(!box || !currentReport) return;
  const v = currentReport.verification || { status:'unverified', note:'' };
  const statusLabel = v.status === 'verified' ? 'Marked accurate' : v.status === 'flagged' ? 'Flagged with issues' : 'Not yet reviewed';
  box.innerHTML = `<h3>Verification</h3>
    <p class="emptyNote" style="font-style:normal; margin:0 0 12px;">Status: <b style="color:${v.status==='verified'?'var(--sage)':v.status==='flagged'?'var(--oxblood)':'var(--paper)'}">${statusLabel}</b>${v.by ? ` · by ${esc(v.by)}` : ''}</p>
    <div class="field"><label>Note (what did you check?)</label><textarea id="verifyNote" rows="2" placeholder="e.g. Confirmed FY25 revenue against investor presentation">${esc(v.note||'')}</textarea></div>
    <div class="topActions" style="margin-bottom:0;">
      <button class="btn2" id="verifyOkBtn">✓ Mark accurate</button>
      <button class="btn2" id="verifyFlagBtn">✕ Flag issues</button>
    </div>`;
  $('verifyOkBtn').addEventListener('click', ()=>setVerification('verified'));
  $('verifyFlagBtn').addEventListener('click', ()=>setVerification('flagged'));
}

async function setVerification(status){
  if(!currentReport || !currentReport.savedId){ showError('Save this report first (it saves automatically after a run) before verifying it.'); return; }
  const note = $('verifyNote').value.trim();
  const verification = { status, note, at: Date.now(), by: analystName || 'Unidentified analyst' };
  currentReport.verification = verification;
  try{ await supabase.from('reports').update({ verification }).eq('id', currentReport.savedId); }catch(e){ /* best-effort */ }
  renderVerificationPanel();
  loadSavedReports();
}

/* ---------- MAIN ANALYSIS RUN ---------- */

async function runAnalysis(){
  if(!currentUserId){ showError('Please sign in first.'); return; }
  const industry = $('industry').value.trim();
  const target = $('target').value.trim();
  const competitors = $('competitors').value.trim();
  const objective = $('objective').value;
  const reportType = $('reportType').value;
  const extraInstructions = $('extraInstructions').value.trim();

  if(!industry || !target || !competitors){ showError("Fill in industry, target company, and at least 2 competitors."); return; }

  currentReport = null;
  $('runBtn').disabled = true;
  $('errorBox').classList.add('hidden');
  $('results').classList.add('hidden');
  $('topActions').classList.add('hidden');
  $('emptyState').classList.add('hidden');
  $('loading').classList.remove('hidden');
  $('status').textContent = 'RUNNING';

  $('loadingText').textContent = 'Reading uploaded file…';
  const uploaded = await parseUploadedFile();
  const uploadedContext = uploaded.text;
  const uploadedFileName = uploaded.name;

  const spec = REPORT_SPECS[reportType] || REPORT_SPECS.standard;
  const webContext = await fetchWebContext(industry, target, competitors, (q)=>{
    $('loadingText').textContent = 'Searching — ' + q;
  }, spec);
  $('loadingText').textContent = 'Synthesizing report…';

  const base = { industry, target, competitors, objective, extraInstructions, uploadedContext, uploadedFileName };
  const prompt = buildPrompt(spec, { ...base, webText: webContext.text });
  const lightPrompt = buildPrompt(spec, { ...base, webText: webContext.textLight });

  try{
    const data = await callAI(prompt, lightPrompt);
    data._sources = webContext.sources;
    data._uploadedFile = uploadedFileName || null;
    data._confidence = computeConfidence(data);
    render(data, target, competitors, industry, objective);
    $('status').textContent = 'COMPLETE';
    $('topActions').classList.remove('hidden');
    saveReport({industry, target, competitors, objective}, data).then(()=> renderVerificationPanel());
  }catch(e){
    showError("Analysis failed: " + e.message);
    $('emptyState').classList.remove('hidden');
    $('status').textContent = 'ERROR';
  }finally{
    $('loading').classList.add('hidden');
    $('runBtn').disabled = false;
  }
}

function showError(msg){
  const box = $('errorBox');
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

/* ---------- REPORT RENDERING ---------- */

function palette(i){ const c = ['#5ec8ff','#ef5b4e','#5fd6a0','#ffab1f','#9b7fc2','#5aa8a8']; return c[i % c.length]; }

function renderStrengthCard(scores){
  const axes = scores.axes || [];
  const companies = Object.keys(scores.companies || {});
  if(!axes.length || !companies.length) return '';
  const n = axes.length, R = 100, cx = 150, cy = 130;
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
  const legend = `<div class="legend">${companies.map((c,i)=>`<span><span class="dot" style="background:${palette(i)}"></span>${esc(c)}</span>`).join('')}</div>`;
  let bars = '';
  companies.forEach((name,ci)=>{
    const vals = scores.companies[name] || [];
    const avg = vals.length ? (vals.reduce((a,b)=>a+b,0)/vals.length) : 0;
    bars += `<div class="scorebar-row"><div class="scorebar-label">${esc(name)}</div>
      <div class="scorebar-track"><div class="scorebar-fill" style="width:${(avg/5*100).toFixed(0)}%; background:${palette(ci)}"></div></div>
      <div class="scorebar-val">${avg.toFixed(1)}</div></div>`;
  });
  return `<div class="card"><h3>Competitive Strength Index</h3>${svg}${legend}
    <div style="margin-top:16px; padding-top:14px; border-top:1px solid var(--line);">${bars}</div></div>`;
}

function renderConfidenceBadge(c){
  if(!c || c.total === 0) return '';
  const color = c.pct >= 75 ? 'var(--sage)' : c.pct >= 50 ? 'var(--amber)' : 'var(--oxblood)';
  return `<div class="confBadge" style="border-color:${color};"><b style="color:${color};">${c.pct}%</b> grounded — ${c.cited} cited claim${c.cited===1?'':'s'}, ${c.estimated} marked as estimate${c.estimated===1?'':'s'}</div>`;
}

function render(d, target, competitors, industry, objective){
  currentReport = { data: d, target, competitors, industry, objective };
  const metaLine = [industry, objective, `vs. ${competitors}`].filter(Boolean).join(' — ');
  const attribution = analystName ? `Prepared by ${analystName}` : '';
  let html = '';

  html += `<div class="reportMasthead">
    <h2>${esc(target)}</h2>
    <div class="metaLine">${esc(metaLine)}</div>
    ${attribution ? `<div class="metaLine" style="opacity:.7;">${esc(attribution)}</div>` : ''}
    ${renderConfidenceBadge(d._confidence)}
  </div>`;

  html += `<div class="cardGrid">`;

  html += `<div class="card fullCard"><h3>Executive Summary</h3><p class="exec">${esc(d.executive_summary||'')}</p></div>`;

  if(d.market_context){
    html += `<div class="card fullCard"><h3>Market Context</h3>${String(d.market_context).split(/\n\s*\n/).map(p=>`<p class="exec" style="margin:0 0 12px;">${esc(p)}</p>`).join('')}</div>`;
  }

  if(d.footprint){
    html += `<div class="card fullCard"><h3>Operational Footprint</h3><div class="overflow"><table><tbody>`;
    Object.keys(d.footprint).forEach(k=>{ html += `<tr><td style="width:24%;">${esc(k)}</td><td style="font-family:var(--sans); font-weight:400;">${esc(d.footprint[k])}</td></tr>`; });
    html += `</tbody></table></div></div>`;
  }

  if(d.benchmark_matrix && d.benchmark_matrix.columns){
    html += `<div class="card fullCard"><h3>Competitive Benchmarking Matrix</h3><div class="overflow"><table><thead><tr>${d.benchmark_matrix.columns.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>`;
    (d.benchmark_matrix.rows||[]).forEach(row=>{ html += '<tr>' + row.map(cell=>`<td>${esc(cell)}</td>`).join('') + '</tr>'; });
    html += `</tbody></table></div></div>`;
  }

  if(d.swot){
    html += `<div class="card fullCard"><h3>SWOT &amp; Gap Analysis</h3><div class="swotGrid">
      <div class="swotQ q-s"><h4>Strengths</h4><ul>${(d.swot.strengths||[]).map(s=>`<li>${esc(s)}</li>`).join('')}</ul></div>
      <div class="swotQ q-w"><h4>Weaknesses</h4><ul>${(d.swot.weaknesses||[]).map(s=>`<li>${esc(s)}</li>`).join('')}</ul></div>
      <div class="swotQ q-o"><h4>Opportunities</h4><ul>${(d.swot.opportunities||[]).map(s=>`<li>${esc(s)}</li>`).join('')}</ul></div>
      <div class="swotQ q-t"><h4>Threats</h4><ul>${(d.swot.threats||[]).map(s=>`<li>${esc(s)}</li>`).join('')}</ul></div>
    </div></div>`;
  }

  if(d.scores) html += renderStrengthCard(d.scores);

  if(d.vulnerabilities && d.vulnerabilities.length){
    html += `<div class="card"><h3>Strategic Vulnerabilities</h3>${d.vulnerabilities.map(v=>`<div class="vuln"><p>${esc(v)}</p></div>`).join('')}</div>`;
  }

  if(d.strategic_takeaways && d.strategic_takeaways.length){
    html += `<div class="card"><h3>Key Strategic Takeaways</h3><ul style="margin:0; padding-left:18px;">${d.strategic_takeaways.map(t=>`<li style="margin-bottom:8px;">${esc(t)}</li>`).join('')}</ul></div>`;
  }

  if(d.recommendations && d.recommendations.length){
    html += `<div class="card"><h3>Actionable Recommendations</h3>${d.recommendations.map(r=>`<div class="reco"><b>${esc(r.title)}</b><p>${esc(r.detail)}</p></div>`).join('')}</div>`;
  }

  if(d._sources && d._sources.length){
    html += `<div class="card fullCard"><h3>Live Web Sources</h3>
    ${d._uploadedFile ? `<p class="metaLine" style="margin-bottom:10px;">+ analyst-uploaded file: <b style="color:var(--paper);">${esc(d._uploadedFile)}</b></p>` : ''}
    <ol style="margin:0; padding-left:18px; font-size:12.5px; line-height:1.8;">
    ${d._sources.map(s=>`<li><a href="${esc(s.url)}" target="_blank" rel="noopener" style="color:var(--brass);">${esc(s.title)}</a>${s.fullText ? ' <span style="color:var(--sage); font-size:11px;">· full text read</span>' : ''}</li>`).join('')}
    </ol></div>`;
  }

  html += `<div class="card fullCard" id="verifyBox"></div>`;
  html += `</div>`;

  $('results').innerHTML = html;
  $('results').classList.remove('hidden');
  renderVerificationPanel();
}

/* ---------- WIRE UP BUTTONS ---------- */

renderExampleChips();

Object.assign(window, {
  setAuthMode, handleAuthSubmit, handleLogout,
  runAnalysis, suggestCompetitors, loadExample, backToSetup,
  downloadWord, downloadPdf
});