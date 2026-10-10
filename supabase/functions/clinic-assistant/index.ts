import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Server key: the sb_secret_ key (SUPABASE_SECRET_KEYS JSON, name "default").
const SB_SECRET: string = (() => { try { return JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default; } catch { return undefined; } })()
  ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Anthropic key lives in the function secrets only (Oct 2026 lockdown - never hardcode keys).
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const MODEL = 'claude-sonnet-5';
const STOP_WORDS = new Set(['how','do','i','the','a','an','to','for','is','it','in','on','of','and','or','my','me','can','what','which','where','when','why','does','should','would','could','treat','treatment','program','use','best','help','find','show','get','with','this','that']);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonRes(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// Strip characters that would break a PostgREST or() filter
const clean = (s: string) => (s || '').replace(/[,()*%\\:."']/g, ' ').trim();

const RANK: Record<string, number> = { admin: 1, practitioner: 2, viewer: 3 };

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, SB_SECRET);

    // === AUTH: signed-in staff only ===
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: userData } = token ? await sb.auth.getUser(token) : { data: { user: null } };
    const email = (userData?.user?.email || '').toLowerCase();
    if (!email) return jsonRes({ error: 'Please sign in' }, 401);
    const { data: access } = await sb.from('staff_access').select('role').eq('email', email).in('tool', ['bio', 'all']);
    const role = (access || []).map((a: any) => a.role).sort((a: string, b: string) => (RANK[a] || 9) - (RANK[b] || 9))[0];
    if (!role) return jsonRes({ error: 'Not authorised' }, 403);

    const body = await req.json();
    const { question, action, protocolId } = body;
    const userEmail = email;
    const need = (allowed: string[]) => allowed.includes(role) ? null : jsonRes({ error: 'Not authorised' }, 403);

    // === APPROVE ACTION ===
    if (action === 'approve') {
      const deny = need(['admin']); if (deny) return deny;
      await sb.from('bio_kelly_protocols').update({ status: 'approved' }).eq('id', protocolId);
      return jsonRes({ success: true });
    }

    // === DELETE ACTION ===
    if (action === 'delete') {
      const deny = need(['admin']); if (deny) return deny;
      await sb.from('bio_kelly_protocols').delete().eq('id', protocolId);
      return jsonRes({ success: true });
    }

    // === INCORPORATE ACTION ===
    if (action === 'incorporate') {
      const deny = need(['admin']); if (deny) return deny;
      const { data: proto } = await sb.from('bio_kelly_protocols').select('*').eq('id', protocolId).single();
      if (!proto) return jsonRes({ error: 'Protocol not found' });

      const prompt = `You are a BICOM Optima bioresonance database admin. Incorporate this clinical note.\n\nNote: "${proto.transcription}"\nProgram: ${proto.related_program || 'none'}\nCondition: ${proto.related_condition || 'none'}\nCategory: ${proto.category || 'none'}\n\nReturn JSON with:\n- programs_to_update: [{program_number, field_to_update: "special_notes", value: "the insight"}]\n- new_entries: [{program_number, name, description, category, subcategory}] if new program\n- summary: one sentence\n\nReturn ONLY valid JSON.`;

      const ai = await callClaude(prompt, 1024);
      try {
        const parsed = JSON.parse(stripFences(ai));
        for (const u of (parsed.programs_to_update || [])) {
          await sb.from('bio_programs').update({ special_notes: u.value }).eq('program_number', u.program_number);
        }
        for (const e of (parsed.new_entries || [])) {
          await sb.from('bio_programs').insert({ ...e, source: 'kelly_protocol', is_optima_ldf: (e.program_number||'').startsWith('3') });
        }
        await sb.from('bio_kelly_protocols').update({ incorporated: true }).eq('id', protocolId);
        return jsonRes({ success: true, summary: parsed.summary });
      } catch {
        await sb.from('bio_kelly_protocols').update({ incorporated: true }).eq('id', protocolId);
        return jsonRes({ success: true, summary: 'Note saved (could not auto-parse for DB update).' });
      }
    }

    // === TREATMENT PLAN ACTION ===
    if (action === 'treatment_plan') {
      const deny = need(['admin', 'practitioner']); if (deny) return deny;
      const { symptoms, conditions, pathways, programCategories } = body;

      const systemPrompt = `You are a senior clinical treatment plan generator for a BICOM Optima bioresonance and naturopathic practice run by Peace of Eden Holistic Health.

You generate TWO documents from a patient symptom picture:

## DOCUMENT 1: BIORESONANCE PROTOCOL
This is the session-by-session BICOM treatment plan. It must include:
- **Testing protocol**: What to test for using vials - candida vial, specific strain vials, mycotoxins, 5 element assessment, meridian testing, blockage assessment. The bioresonance testing FINDS what is wrong - you recommend what to look for based on the symptom picture.
- **Strain priority order**: Always metals > chemicals > candida > parasites > bacteria > viruses > vaccinations
- **Drainage first**: Open liver, kidney, lymph pathways before treating strains
- **Session plan**: Recommended programs per session with program numbers, therapy modes, times. First session starts everything (naturopathic protocol begins simultaneously).
- **Progression notes**: What to test at each follow-up, when to expect shifts
- **5 Element assessment**: Which elements to check based on presentation
- **Meridian focus**: Which meridians are likely involved

## DOCUMENT 2: NATUROPATHIC PATHWAYS
This is the take-home protocol for the patient. It must include:
- **Diet protocol**: Specific to their presentation (always check if candida diet applies)
- **Herbal medicine**: Specific herbs with Latin names, actions, dosages, contraindications
- **Nutritional medicine**: Specific nutrients with therapeutic dosages, forms, and why
- **Tissue salts**: Schuessler salts relevant to their picture
- **Flower essences**: Bach and Australian Bush Flower essences for their emotional picture
- **Homeopathic recommendations**: Including candida spray protocol if applicable (15C > 30C > 60C > 200C)
- **Probiotics**: Natren Bifido Factor / Megadophilus protocol if candida is suspected
- **Lifestyle**: Including hip release/nervous system regulation if stress/trauma/somatic patterns present
- **Biochemical reasoning**: The WHY behind each recommendation - which pathways are involved
- **Nutrigenomics flags**: Which genetic variants to consider testing for
- **Psychoneuroimmunology**: HPA axis, vagal tone, gut-brain considerations

CRITICAL RULES:
- You CAN start treating candida without clearing metals first. Metals and co-infections are treated over time and accelerate healing but are not prerequisites.
- Naturopathic protocol starts SESSION 1 alongside bioresonance.
- Always consider systemic candida as a potential upstream root cause, especially for: autoimmune conditions, MCAS, POTS, skin conditions, allergies, recurrent infections, ear infections, immune deficiency.
- Post-COVID patients: spike protein depletes Bifidobacterium which is colonisation resistance against candida.
- Mother-to-baby transmission via breast milk - ask about maternal history.
- Candida produces acetaldehyde (IARC Group 1 carcinogen) that destroys tight junctions.
- If candida is suspected, the full protocol is: anti-candida diet + homeopathic candida sprays (15C start) + Natren Bifido Factor powder 1 tsp in room temp water, stand 5 min, drink, no food 20 min. Transition to Megadophilus at 200C stage.
- Peanuts are an absolute no-go on candida protocol. All nuts must be WELL roasted. Vinegar counts as fermented.
- Diet compliance is binary - ANY break causes a flare showing where candida manifests.
- Companion somatic work: hip release and nervous system regulation (psoas-diaphragm-vagal tone loop).
- Use ONLY program numbers and data from the provided database context. Never invent program numbers.
- Format both documents with clear headings, tables where appropriate, and clinical reasoning.
- Use HTML formatting (h3, strong, ul/li, table/tr/td) for clean display.`;

      const userMsg = `PATIENT SYMPTOM PICTURE:\n${symptoms}\n\nAVAILABLE CONDITIONS IN DATABASE (${(conditions||[]).length}):\n${JSON.stringify(conditions||[], null, 0).slice(0, 12000)}\n\nAVAILABLE CLINICAL PATHWAYS (${(pathways||[]).length}):\n${JSON.stringify(pathways||[], null, 0).slice(0, 8000)}\n\nAVAILABLE BICOM PROGRAM CATEGORIES:\n${(programCategories||[]).join(', ')}\n\nGenerate both documents now. Return as JSON with two keys: "bioresonance" (HTML string) and "naturopathic" (HTML string).`;

      const ai = await callClaude(userMsg, 8000, systemPrompt);

      // Try to parse as JSON first
      try {
        const parsed = JSON.parse(stripFences(ai));
        return jsonRes({ bioresonance: parsed.bioresonance, naturopathic: parsed.naturopathic });
      } catch {
        // If not valid JSON, try to extract the two sections
        const bioMatch = ai.match(/"bioresonance"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        const natMatch = ai.match(/"naturopathic"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (bioMatch && natMatch) {
          return jsonRes({ bioresonance: bioMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'), naturopathic: natMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') });
        }
        // Last resort - split on a marker
        const parts = ai.split(/(?:NATUROPATHIC PATHWAYS|DOCUMENT 2)/i);
        return jsonRes({
          bioresonance: parts[0] || ai,
          naturopathic: parts[1] || 'Could not separate naturopathic section. Full response included in bioresonance section.'
        });
      }
    }

    // === QUESTION ACTION ===
    const ql = clean((question || '').toLowerCase().replace(/[?!.,]/g, ''));
    const keywords = ql.split(/\s+/).filter((w: string) => w.length > 2 && !STOP_WORDS.has(w));
    const searchTerm = keywords.join(' ') || ql;

    const searches = await Promise.all([
      sb.from('bio_programs').select('program_number, name, description, therapy_mode, time_minutes, category, subcategory, special_notes').or(`name.ilike.%${searchTerm}%,description.ilike.%${searchTerm}%,subcategory.ilike.%${searchTerm}%`).limit(10),
      sb.from('bio_strains').select('*').or(`name.ilike.%${searchTerm}%,category.ilike.%${searchTerm}%`).limit(5),
      sb.from('bio_constitutional').select('*').or(`name.ilike.%${searchTerm}%,category.ilike.%${searchTerm}%`).limit(5),
      sb.from('bio_symptoms').select('*').ilike('symptom', `%${searchTerm}%`).limit(3),
      sb.from('bio_kelly_protocols').select('*').eq('status', 'approved').ilike('transcription', `%${searchTerm}%`).limit(5),
    ]);

    let extraProgs: any[] = [];
    let extraStrains: any[] = [];
    let extraConst: any[] = [];
    for (const kw of keywords.slice(0, 4)) {
      const [p, s, c] = await Promise.all([
        sb.from('bio_programs').select('program_number, name, therapy_mode, time_minutes, category, subcategory, special_notes').or(`name.ilike.%${kw}%,subcategory.ilike.%${kw}%`).limit(8),
        sb.from('bio_strains').select('*').or(`name.ilike.%${kw}%,category.ilike.%${kw}%`).limit(3),
        sb.from('bio_constitutional').select('*').or(`name.ilike.%${kw}%,category.ilike.%${kw}%`).limit(3),
      ]);
      if (p.data) extraProgs.push(...p.data);
      if (s.data) extraStrains.push(...s.data);
      if (c.data) extraConst.push(...c.data);
    }

    const dedup = (arr: any[], key: string) => arr.filter((p, i, a) => a.findIndex((x: any) => x[key] === p[key] && (x.name||'') === (p.name||'')) === i);
    const programs = dedup([...(searches[0].data || []), ...extraProgs], 'program_number').slice(0, 25);
    const strains = dedup([...(searches[1].data || []), ...extraStrains], 'name').slice(0, 8);
    const constitutional = dedup([...(searches[2].data || []), ...extraConst], 'name').slice(0, 8);
    const symptoms = searches[3].data || [];
    const kellyNotes = searches[4].data || [];

    const context = [
      programs.length ? `PROGRAMS (${programs.length}):\n${programs.map((p: any) => `- ${p.program_number}: ${p.name} | ${p.therapy_mode||'?'} | ${p.time_minutes||'?'}min | ${p.category}/${p.subcategory}${p.special_notes ? ' | Kelly: '+p.special_notes : ''}`).join('\n')}` : '',
      strains.length ? `STRAINS (${strains.length}):\n${strains.map((s: any) => `- ${s.name} (${s.category}): 1st=${s.first_treatment_program}, follow-up=${s.followup_treatment_program}, spin=${s.spin_tester_setting||'n/a'}`).join('\n')}` : '',
      constitutional.length ? `CONSTITUTIONAL (${constitutional.length}):\n${constitutional.map((c: any) => `- ${c.name} (${c.category}): programs ${(c.programs||[]).join(', ')}`).join('\n')}` : '',
      symptoms.length ? `SYMPTOMS:\n${symptoms.map((s: any) => `- ${s.symptom}: causes [${(s.possible_causes||[]).join(', ')}], programs [${(s.recommended_programs||[]).join(', ')}]${s.kelly_notes ? ' | Kelly: '+s.kelly_notes : ''}`).join('\n')}` : '',
      kellyNotes.length ? `KELLY'S NOTES:\n${kellyNotes.map((k: any) => `- ${k.transcription} (re: program ${k.related_program||'general'})`).join('\n')}` : ''
    ].filter(Boolean).join('\n\n');

    const hasContext = programs.length > 0 || strains.length > 0 || constitutional.length > 0 || symptoms.length > 0;

    const sysPrompt = `You are the Clinic Assistant for a BICOM Optima bioresonance practice.\n\nRules:\n- Concise and practical - used mid-session\n- Always include program numbers with therapy mode and time\n- Highlight Kelly's notes with "Kelly's tip:"\n- If you cannot answer, say "I'll flag this for Kelly to review"\n- Never invent program numbers\n- Under 200 words\n- Use plain language`;

    const userMsg = hasContext
      ? `Question: "${question}"\n\nDatabase results:\n${context}\n\nAnswer using ONLY this data.`
      : `Question: "${question}"\n\nNo data found. Tell user and offer to escalate to Kelly.`;

    const answer = await callClaude(userMsg, 512, sysPrompt);
    const shouldEscalate = !hasContext || (answer.toLowerCase().includes('flag') && answer.toLowerCase().includes('kelly'));

    if (shouldEscalate && role !== 'admin') {
      await sb.from('bio_kelly_protocols').insert({
        transcription: `QUESTION FROM ${userEmail}: ${question}`,
        category: 'question',
        added_by: userEmail,
        role: role,
        status: 'pending'
      });
    }

    return jsonRes({ answer, escalated: shouldEscalate });

  } catch (err: any) {
    console.error('clinic-assistant error', err?.message);
    return jsonRes({ error: 'Something went wrong' }, 500);
  }
});

function stripFences(s: string) {
  return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
}

async function callClaude(prompt: string, maxTokens: number, system?: string) {
  if (!ANTHROPIC_KEY) { console.error('ANTHROPIC_API_KEY secret is not set'); return 'Could not generate a response.'; }
  const body: any = { model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
  if (system) body.system = system;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) console.error('anthropic error', res.status, data?.error?.type, data?.error?.message);
  return data.content?.[0]?.text || 'Could not generate a response.';
}
