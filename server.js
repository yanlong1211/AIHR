const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const ROOT = __dirname;
function loadLocalEnv() {
  const envFile = path.join(ROOT, '.env.local');
  if (!fs.existsSync(envFile)) return;
  const content = fs.readFileSync(envFile, 'utf8');
  content.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) return;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  });
}
loadLocalEnv();
const PORT = Number(process.env.PORT || 4173);
const DATA_FILE = path.join(ROOT, '.hireflow-data.json');
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const USE_MOCK_AI = /^(1|true|yes|on)$/i.test(process.env.USE_MOCK_AI || '');
const MODEL_BASE_URL = process.env.LLM_BASE_URL || process.env.AI_BASE_URL || (DEEPSEEK_API_KEY ? 'https://api.deepseek.com' : '');
const MODEL_API_KEY = process.env.LLM_API_KEY || process.env.AI_API_KEY || DEEPSEEK_API_KEY;
const MODEL_NAME = process.env.LLM_MODEL || process.env.AI_MODEL || 'deepseek-chat';
const MODEL_PROVIDER = process.env.LLM_PROVIDER || (MODEL_BASE_URL.includes('deepseek.com') ? 'deepseek' : 'compatible');
const MODEL_TIMEOUT_MS = Math.max(10_000, Number(process.env.LLM_TIMEOUT_MS || 45_000));
function isModelConfigured() { return !USE_MOCK_AI && Boolean(MODEL_BASE_URL && MODEL_API_KEY); }
const execFileAsync = promisify(execFile);
const PDFTOTEXT_COMMAND = process.env.PDFTOTEXT_PATH || 'pdftotext';
const ORG_OPTIONS = { departments: ['技术中心', '产品中心', '运营中心', '数据中心', '职能部门'], recruiters: ['林晓雯', '周宁'] };
const OPTION_TYPES = { department: 'departments', recruiter: 'recruiters' };
function cloneOrgOptions() { return { departments: [...ORG_OPTIONS.departments], recruiters: [...ORG_OPTIONS.recruiters] }; }
function normalizeOrgOptions(value) { const next = value && typeof value === 'object' ? value : {}; const departments = Array.isArray(next.departments) ? [...new Set(next.departments.map(item => String(item).trim()).filter(Boolean))] : []; const recruiters = Array.isArray(next.recruiters) ? [...new Set(next.recruiters.map(item => String(item).trim()).filter(Boolean))] : []; return { departments: departments.length ? departments : [...ORG_OPTIONS.departments], recruiters: recruiters.length ? recruiters : [...ORG_OPTIONS.recruiters] }; }

function nowLabel() { const date = new Date(); const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).reduce((result, part) => (result[part.type] = part.value, result), {}); return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`; }
function generateCandidateId(usedIds = new Set()) { let candidateId; do { candidateId = `C-${nowLabel().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; } while (usedIds.has(candidateId)); return candidateId; }
function initialState() {
  return {
    orgOptions: cloneOrgOptions(),
    syncedAt: nowLabel(),
    metrics: { newThisWeek: 36, pending: 14, interviewRate: 38.5, savedHours: 6.5 },
    positions: [
      { id: 'pos-1', title: '后端开发', department: '技术中心', recruiter: '林晓雯', status: '招聘中', headcount: 2, deadline: '2026-10-15', description: '负责招聘平台后端服务与数据接口建设。', updatedAt: nowLabel() },
      { id: 'pos-2', title: '产品经理', department: '产品中心', recruiter: '林晓雯', status: '招聘中', headcount: 1, deadline: '2026-10-08', description: '负责招聘效率产品的需求分析与迭代。', updatedAt: nowLabel() },
      { id: 'pos-3', title: '前端开发', department: '技术中心', recruiter: '周宁', status: '暂停招聘', headcount: 1, deadline: '2026-10-30', description: '负责招聘工作台 Web 前端体验。', updatedAt: nowLabel() }
    ],
    candidates: [
      { id: 'seed-1', candidateId: 'C-20260924-0001', name: '王思远', role: '后端开发', positionId: 'pos-1', recruiter: '林晓雯', stage: '待安排面试', nextAction: '安排专业一面', sourceGroup: '技术招聘群', confidence: 96, updatedAt: nowLabel() },
      { id: 'seed-2', candidateId: 'C-20260924-0002', name: '李娜', role: '产品经理', positionId: 'pos-2', recruiter: '林晓雯', stage: '专业一面', nextAction: '等待专业一面反馈', sourceGroup: '产品招聘群', confidence: 93, updatedAt: nowLabel() },
      { id: 'seed-3', candidateId: 'C-20260924-0003', name: '陈嘉', role: '前端开发', positionId: 'pos-3', recruiter: '周宁', stage: '待沟通', nextAction: '确认薪资意向', sourceGroup: '技术招聘群', confidence: 89, updatedAt: nowLabel() }
    ],
    activities: [
      { icon: '✦', title: 'AI 提取', text: '王思远进入“待安排面试”', time: nowLabel() },
      { icon: '↗', title: '状态更新', text: '李娜 · 产品经理 → 专业一面', time: nowLabel() },
      { icon: '↻', title: '群聊同步', text: '“技术招聘群”已同步 8 条消息', time: nowLabel() }
    ],
    processedMessages: [],
    reviewQueue: [],
    trend: { labels: ['周一','周二','周三','周四','周五','周六','周日'], inbound: [24, 31, 27, 36, 33, 18, 22], advanced: [12, 17, 15, 21, 18, 10, 14] }
  };
}
function recalculateMetrics(state) {
  const candidates = Array.isArray(state.candidates) ? state.candidates : [];
  const activeCandidates = candidates.filter(candidate => !['已淘汰', '已录用'].includes(candidate.stage));
  const interviewedCandidates = activeCandidates.filter(candidate => ['专业一面', '专业二面', '面试中', '待发 Offer', 'Offer 沟通', '已录用'].includes(candidate.stage));
  state.positions.forEach(position => { position.hiredCount = candidates.filter(candidate => candidate.positionId === position.id && candidate.stage === '已录用').length; });
  state.metrics = {
    ...(state.metrics || {}),
    newThisWeek: candidates.length,
    pending: activeCandidates.length,
    interviewRate: activeCandidates.length ? Math.round(interviewedCandidates.length / activeCandidates.length * 1000) / 10 : 0,
    savedHours: Number(state.metrics?.savedHours || 0)
  };
  return state;
}
function readState() {
  try {
    const stored = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const defaults = initialState();
    let migrated = false;
    stored.positions = Array.isArray(stored.positions) ? stored.positions : defaults.positions;
    stored.candidates = Array.isArray(stored.candidates) ? stored.candidates : defaults.candidates;
    stored.activities = Array.isArray(stored.activities) ? stored.activities : defaults.activities;
    stored.processedMessages = Array.isArray(stored.processedMessages) ? stored.processedMessages : [];
    stored.reviewQueue = Array.isArray(stored.reviewQueue) ? stored.reviewQueue : [];
    const savedOrgOptions = normalizeOrgOptions(stored.orgOptions);
    if (JSON.stringify(savedOrgOptions) !== JSON.stringify(cloneOrgOptions())) migrated = true;
    ORG_OPTIONS.departments = savedOrgOptions.departments;
    ORG_OPTIONS.recruiters = savedOrgOptions.recruiters;
    stored.positions.forEach(position => { if (!ORG_OPTIONS.departments.includes(position.department)) { position.department = '技术中心'; migrated = true; } if (!ORG_OPTIONS.recruiters.includes(position.recruiter)) { position.recruiter = ORG_OPTIONS.recruiters[0]; migrated = true; } if (!position.updatedAt || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(position.updatedAt)) { position.updatedAt = nowLabel(); migrated = true; } });
    if (!stored.syncedAt || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(stored.syncedAt)) { stored.syncedAt = nowLabel(); migrated = true; }
    stored.activities.forEach(activity => { if (!activity.time || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(activity.time)) { activity.time = nowLabel(); migrated = true; } });
    const usedCandidateIds = new Set();
    stored.candidates.forEach(candidate => { if (!candidate.positionId) { candidate.positionId = stored.positions.find(position => position.title === candidate.role)?.id || null; migrated = true; } if (!candidate.candidateId || usedCandidateIds.has(candidate.candidateId)) { candidate.candidateId = generateCandidateId(usedCandidateIds); migrated = true; } usedCandidateIds.add(candidate.candidateId); if (!ORG_OPTIONS.recruiters.includes(candidate.recruiter)) { candidate.recruiter = stored.positions.find(position => position.id === candidate.positionId)?.recruiter || ORG_OPTIONS.recruiters[0]; migrated = true; } if (!candidate.updatedAt || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(candidate.updatedAt)) { candidate.updatedAt = nowLabel(); migrated = true; } if (candidate.stage === '面试中' && candidate.nextAction === '等待面试反馈') { candidate.stage = '专业一面'; migrated = true; } });
    const state = recalculateMetrics({ ...defaults, ...stored });
    if (migrated) writeState(state);
    return state;
  } catch { const state = initialState(); writeState(state); return recalculateMetrics(state); }
}
function writeState(state) { state.orgOptions = cloneOrgOptions(); recalculateMetrics(state); fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8'); }
function json(res, status, payload) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); }
function csvCell(value) { const text = String(value ?? ''); const safe = /^[=+\-@]/.test(text) ? `'${text}` : text; return `"${safe.replace(/"/g, '""')}"`; }
function exportCandidates(state, searchParams) {
  const scope = searchParams.get('scope') || 'active';
  const positionId = searchParams.get('positionId') || '';
  const query = (searchParams.get('q') || '').trim().toLowerCase();
  const recruiter = searchParams.get('recruiter') || '';
  const stage = searchParams.get('stage') || '';
  const hireStatus = searchParams.get('hireStatus') || '';
  const updatedDate = searchParams.get('updatedDate') || '';
  let candidates = [...state.candidates];
  if (scope === 'active') candidates = candidates.filter(item => !['已录用', '已淘汰'].includes(item.stage));
  if (scope === 'hired') candidates = candidates.filter(item => item.stage === '已录用');
  if (scope === 'today') candidates = candidates.filter(item => String(item.updatedAt || '').startsWith(nowLabel().slice(0, 10)));
  if (scope === 'position' && positionId) candidates = candidates.filter(item => item.positionId === positionId);
  if (scope === 'filtered') {
    if (query) candidates = candidates.filter(item => [item.candidateId, item.name, item.role, item.recruiter, item.phone, item.email, item.stage, item.nextAction, item.sourceGroup].join('|').toLowerCase().includes(query));
    if (positionId) candidates = candidates.filter(item => item.positionId === positionId);
    if (recruiter) candidates = candidates.filter(item => item.recruiter === recruiter);
    if (stage) candidates = candidates.filter(item => item.stage === stage);
    if (hireStatus === 'hired') candidates = candidates.filter(item => item.stage === '已录用');
    if (hireStatus === 'active') candidates = candidates.filter(item => item.stage !== '已录用');
  }
  if (updatedDate) candidates = candidates.filter(item => String(item.updatedAt || '').startsWith(updatedDate));
  return candidates;
}
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 12_000_000) { reject(new Error('上传内容超过 12MB')); req.destroy(); } });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); } });
    req.on('error', reject);
  });
}
function aiModeLabel() { return !USE_MOCK_AI && MODEL_BASE_URL && MODEL_API_KEY ? `模型：${MODEL_NAME}` : `规则兜底（${USE_MOCK_AI ? '已强制 Mock' : `模型默认：${MODEL_NAME}`}）`; }
function positionAcceptsNewCandidates(position) { return position?.status === '招聘中'; }
function normalizeModelText(value, fallback) { const text = String(value ?? '').trim(); return text || fallback; }
function normalizeModelStage(value, fallback) { return CANDIDATE_STAGES.includes(value) ? value : fallback; }
function normalizeMessages(text) {
  return String(text || '').split(/\r?\n+/).map(item => item.trim()).filter(Boolean);
}
function ruleExtract(message, sourceGroup) {
  const roles = ['后端开发','Java 开发','前端开发','产品经理','数据分析师','运营专员','算法工程师','测试工程师'];
  const clean = message.replace(/@[\u4e00-\u9fa5A-Za-z0-9_-]+/g, '').trim();
  const name = (clean.match(/^([\u4e00-\u9fa5]{2,4})(?=[，,。\s])/ ) || [,'待确认候选人'])[1];
  const role = roles.find(item => message.includes(item)) || (message.match(/(后端|Java|前端|产品|数据|运营|算法|测试)[^，。,\s]{0,6}/i) || [,'待确认岗位'])[1];
  const lower = message.toLowerCase();
  let stage = '待沟通';
  let nextAction = '联系候选人确认意向';
  if (message.includes('拒绝') || message.includes('不合适') || message.includes('淘汰') || message.includes('未录用') || message.includes('不录用')) { stage = '已淘汰'; nextAction = '归档候选人'; }
  else if (/已录用|确定录用|正式录用|已入职/.test(message)) { stage = '已录用'; nextAction = '办理入职手续'; }
  else if (/(专业一面|技术一面|一面)/.test(message) && /通过|完成|反馈通过/.test(message) && /(专业二面|二面)/.test(message)) { stage = '专业一面'; nextAction = '安排专业二面'; }
  else if (message.includes('专业二面') || message.includes('二面')) { stage = '专业二面'; nextAction = message.includes('通过') ? '等待录用审批' : '等待专业二面反馈'; }
  else if (message.includes('专业一面') || message.includes('技术一面') || message.includes('一面')) { if (/(安排|约|预约|确认时间|待面)/.test(message) && !/通过|完成|反馈通过/.test(message)) { stage = '待安排面试'; nextAction = '安排专业一面'; } else { stage = '专业一面'; nextAction = /通过|完成|反馈通过/.test(message) ? '安排专业二面' : '等待专业一面反馈'; } }
  else if (lower.includes('offer')) { stage = 'Offer 沟通'; nextAction = '推进 Offer 审批'; }
  else if (message.includes('面试反馈') || message.includes('通过面试')) { stage = '待发 Offer'; nextAction = '收集面试反馈并推进 Offer'; }
  else if (message.includes('面试') || message.includes('初筛通过') || message.includes('通过初筛')) { stage = '待安排面试'; nextAction = message.includes('技术一面') ? '安排技术一面' : '确认面试时间'; }
  else if (message.includes('简历') || message.includes('初筛')) { stage = '待筛选'; nextAction = '完成简历初筛'; }
  const time = (message.match(/(今天|明天|后天|周[一二三四五六日天])[^。\n，,]{0,15}(?:\d{1,2}[点时]\s*(?:\d{1,2}分)?|上午|下午)/) || [,''])[1];
  const confidence = Math.round(((name.startsWith('待确认') ? 0.25 : 0.4) + (role.startsWith('待确认') ? 0.1 : 0.3) + (stage !== '待沟通' ? 0.2 : 0.1)) * 100);
  const phone = message.match(/1[3-9]\d{9}/)?.[0] || '';
  const email = message.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
  return { name, role, stage, nextAction, interviewTime: time || null, phone, email, sourceGroup: sourceGroup || '未指定招聘群', confidence: Math.min(confidence, 99), rawMessage: message };
}
function extractJson(text) {
  const normalized = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = normalized.indexOf('{');
  const end = normalized.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回有效 JSON');
  try { return JSON.parse(normalized.slice(start, end + 1)); } catch { throw new Error('模型返回的 JSON 不完整或格式错误'); }
}
async function requestModelJson(messages, options = {}) {
  const endpoint = `${MODEL_BASE_URL.replace(/\/$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const payload = { model: MODEL_NAME, temperature: 0, max_tokens: options.maxTokens || 1200, messages };
    if (options.jsonMode !== false) payload.response_format = { type: 'json_object' };
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MODEL_API_KEY}` }, body: JSON.stringify(payload), signal: controller.signal });
    const responseText = await response.text();
    if (!response.ok) {
      let detail = '';
      try { const errorBody = JSON.parse(responseText); detail = errorBody.error?.message || errorBody.message || ''; } catch { detail = responseText.slice(0, 240); }
      throw new Error(`模型接口返回 ${response.status}${detail ? `：${detail}` : ''}`);
    }
    let result;
    try { result = JSON.parse(responseText); } catch { throw new Error('模型接口返回了无法解析的响应'); }
    return extractJson(result.choices?.[0]?.message?.content);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`DeepSeek 请求超时（>${Math.round(MODEL_TIMEOUT_MS / 1000)}秒）`);
    if (error.name === 'TypeError' && error.cause?.message) throw new Error(`DeepSeek 网络请求失败：${error.cause.message}`);
    throw error;
  } finally { clearTimeout(timer); }
}
async function modelExtract(message, sourceGroup, fallback) {
  if (USE_MOCK_AI || !MODEL_BASE_URL || !MODEL_API_KEY) return { data: fallback, mode: USE_MOCK_AI ? 'Mock/规则兜底' : '规则兜底' };
  const data = await requestModelJson([{ role: 'system', content: '你是招聘运营数据抽取器。只返回 JSON，不要解释。字段：name, role, recruiter, stage, nextAction, interviewTime, confidence。不要返回 candidateId 或任何候选人 ID，候选人 ID 必须由系统生成。stage 只能是：待筛选、待沟通、待安排面试、专业一面、专业二面、面试中、待发 Offer、Offer 沟通、已录用、已淘汰。招聘负责人未提供返回空字符串。' }, { role: 'user', content: `招聘群：${sourceGroup}\n消息：${message}` }]);
  const confidenceValue = Number(data.confidence ?? fallback.confidence);
  const modelRecruiter = ORG_OPTIONS.recruiters.includes(data.recruiter) ? data.recruiter : '';
  const { candidateId: ignoredCandidateId, id: ignoredId, ...modelData } = data;
  return { data: { ...fallback, ...modelData, name: normalizeModelText(data.name, fallback.name), role: normalizeModelText(data.role, fallback.role), recruiter: modelRecruiter, stage: normalizeModelStage(data.stage, fallback.stage), nextAction: normalizeModelText(data.nextAction, fallback.nextAction), interviewTime: data.interviewTime || fallback.interviewTime || null, sourceGroup, rawMessage: message, confidence: Math.max(0, Math.min(99, Math.round(confidenceValue * (confidenceValue <= 1 ? 100 : 1)))) }, mode: `模型：${MODEL_NAME}` };
}
function upsertCandidate(state, data, forcedExisting = null) {
  if (!data.positionId) data.positionId = state.positions.find(position => position.title === data.role)?.id || null;
  const existing = forcedExisting || findCandidateMatch(state, data);
  let candidateId = existing?.candidateId;
  if (!candidateId) candidateId = generateCandidateId(new Set(state.candidates.map(item => item.candidateId).filter(Boolean)));
  const assignedPosition = state.positions.find(position => position.id === data.positionId);
  const recruiter = ORG_OPTIONS.recruiters.includes(data.recruiter) ? data.recruiter : (existing?.recruiter || assignedPosition?.recruiter || ORG_OPTIONS.recruiters[0]);
  const candidate = { ...data, id: existing?.id || `c-${crypto.randomUUID()}`, candidateId, recruiter, hiredAt: data.stage === '已录用' ? (existing?.hiredAt || nowLabel()) : null, updatedAt: nowLabel() };
  if (existing) { Object.assign(existing, candidate); return { ...existing, created: false }; }
  state.candidates.unshift(candidate); return { ...candidate, created: true };
}
function recordActivity(state, title, text, icon = '✦') { state.activities.unshift({ icon, title, text, time: nowLabel() }); state.activities = state.activities.slice(0, 12); }
const CANDIDATE_STAGES = ['待筛选','待沟通','待安排面试','专业一面','专业二面','面试中','待发 Offer','Offer 沟通','已录用','已淘汰'];
const STAGE_NEXT_ACTIONS = { '待筛选': '完成简历初筛', '待沟通': '联系候选人确认意向', '待安排面试': '确认面试时间', '专业一面': '等待专业一面反馈', '专业二面': '等待专业二面反馈', '面试中': '等待面试反馈', '待发 Offer': '收集面试反馈并推进 Offer', 'Offer 沟通': '推进 Offer 审批', '已录用': '办理入职手续', '已淘汰': '归档候选人' };
function candidateMatchesByNameRole(state, data) { return state.candidates.filter(item => item.name === data.name && item.name !== '待确认候选人' && (data.positionId ? item.positionId === data.positionId : item.role === data.role)); }
function findCandidateMatch(state, data) { const strongMatch = state.candidates.find(item => (data.phone && item.phone === data.phone) || (data.email && item.email?.toLowerCase() === String(data.email).toLowerCase()) || (data.sourceMessageId && item.sourceMessageId === data.sourceMessageId)); if (strongMatch) return strongMatch; const nameMatches = candidateMatchesByNameRole(state, data); return nameMatches.length === 1 ? nameMatches[0] : null; }
function needsReview(candidate, state) { const baseReview = Number(candidate?.confidence) < 65 || candidate?.name === '待确认候选人' || candidate?.role === '待确认岗位'; const ambiguous = state && !candidate.candidateId && !candidate.phone && !candidate.email && candidateMatchesByNameRole(state, candidate).length > 1; return baseReview || ambiguous; }
function addReview(state, review) { const duplicate = state.reviewQueue.some(item => item.type === review.type && (review.sourceMessageId ? item.sourceMessageId === review.sourceMessageId : (review.existingCandidateId ? item.existingCandidateId === review.existingCandidateId : item.candidate?.name === review.candidate?.name && item.candidate?.role === review.candidate?.role))); if (!duplicate) state.reviewQueue.unshift({ id: `review-${crypto.randomUUID()}`, ...review, createdAt: nowLabel() }); }
async function extractPdfText(pdfBase64) {
  const filename = path.join(os.tmpdir(), `hireflow-resume-${crypto.randomUUID()}.pdf`);
  try {
    const encoded = String(pdfBase64 || '').replace(/^data:application\/pdf;base64,/i, '').replace(/\s/g, '');
    const pdf = Buffer.from(encoded, 'base64');
    if (pdf.length < 5 || pdf.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('上传内容不是有效 PDF');
    await fs.promises.writeFile(filename, pdf);
    let lastError;
    for (const args of [['-layout', '-enc', 'UTF-8'], ['-raw', '-enc', 'UTF-8'], ['-enc', 'UTF-8']]) {
      try {
        const result = await execFileAsync(PDFTOTEXT_COMMAND, [...args, filename, '-'], { maxBuffer: 3 * 1024 * 1024, windowsHide: true });
        const text = normalizeResumeText(result.stdout);
        if (text.length >= 40) return text;
      } catch (error) {
        lastError = error;
        const partialText = normalizeResumeText(error.stdout);
        if (partialText.length >= 40) return partialText;
      }
    }
    if (lastError) throw lastError;
    return '';
  } finally { await fs.promises.unlink(filename).catch(() => {}); }
}
function normalizeResumeText(text) { return String(text || '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim(); }
function cleanResumeName(value) {
  const cleaned = String(value || '').replace(/^(姓\s*名|候选人|name|full\s*name)\s*[:：]?/i, '').split(/(?:电话|手机|邮箱|email|phone|目标岗位|应聘岗位|工作经验|教育背景|项目经历|技能|skills)\s*[:：]?/i)[0].split(/[|｜,，;；\t]/)[0].trim();
  if (/^[\u4e00-\u9fa5]{2,4}$/.test(cleaned)) return cleaned;
  const english = cleaned.match(/^[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){1,2}/)?.[0];
  if (english && english.length <= 30) return english.replace(/\s+/g, ' ').trim();
  return '';
}
function extractResumeName(text) {
  const normalized = normalizeResumeText(text);
  const lines = normalized.split('\n').map(line => line.trim()).filter(Boolean);
  const labeled = normalized.match(/(?:姓\s*名|候选人|name|full\s*name)\s*[:：]?\s*([^\n|｜,，;；]{2,30})/i);
  const labeledName = cleanResumeName(labeled?.[1]);
  if (labeledName) return labeledName;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^(姓\s*名|候选人|name|full\s*name)[:：]?$/i.test(lines[index])) { const nextName = cleanResumeName(lines[index + 1]); if (nextName) return nextName; }
  }
  const blocked = /^(个人简历|简历|resume|curriculum vitae|基本信息|联系方式|个人信息|工作经历|工作经验|教育经历|项目经历|技能特长|专业技能|求职意向|自我评价|个人优势|校园经历|证书)$/i;
  for (const line of lines.slice(0, 12)) {
    const chinese = line.match(/(?<![A-Za-z])[\u4e00-\u9fa5]{2,4}(?![\u4e00-\u9fa5])/);
    const name = cleanResumeName(chinese?.[0]);
    if (name && !blocked.test(name)) return name;
    const english = cleanResumeName(line.match(/\b[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){1,2}\b/)?.[0]);
    if (english && !blocked.test(english)) return english;
  }
  return '待确认候选人';
}
function extractResumeYears(text) { const content = normalizeResumeText(text).replace(/\n/g, ' '); return (content.match(/(?:工作|相关|项目)?\s*经验[^0-9]{0,8}(\d{1,2})\s*年/i) || content.match(/(\d{1,2})\s*年(?:相关)?经验/i) || content.match(/(?:工作年限|从业年限)[^0-9]{0,8}(\d{1,2})/i) || content.match(/(?:work|professional|relevant)\s+experience[^0-9]{0,8}(\d{1,2})\s*years?/i) || content.match(/(\d{1,2})\s*years?\s+(?:of\s+)?experience/i) || [,'0'])[1]; }
function normalizeScore(value, fallback) { const numeric = Number(value); if (!Number.isFinite(numeric)) return fallback; const percent = numeric > 0 && numeric <= 1 ? numeric * 100 : numeric; return Math.max(0, Math.min(99, Math.round(percent))); }
function resumeMatchFallback(text, position) {
  const rawText = normalizeResumeText(text);
  const content = rawText.replace(/\s+/g, ' ').trim();
  const name = extractResumeName(rawText);
  const years = extractResumeYears(rawText);
  const keywordSource = `${position.title} ${position.department} ${position.description}`;
  const keywords = [...new Set(keywordSource.match(/[\u4e00-\u9fa5]{2,8}|[A-Za-z][A-Za-z+#.]{1,20}/g) || [])].filter(word => !['负责','招聘','中心','岗位','工作','开发'].includes(word));
  const roleSkills = {
    '后端': ['Java', 'Spring', 'Spring Boot', 'REST API', 'MySQL', 'Redis', '微服务', 'backend'],
    '前端': ['JavaScript', 'TypeScript', 'React', 'Vue', 'HTML', 'CSS', 'frontend'],
    '产品': ['产品设计', '需求分析', 'PRD', '原型', '用户研究', 'product'],
    '数据': ['SQL', 'Python', '数据分析', 'Tableau', 'Power BI', 'data analysis'],
    '测试': ['自动化测试', 'Selenium', 'Playwright', 'JMeter', 'API 测试', 'testing'],
    '算法': ['Python', '机器学习', '深度学习', 'TensorFlow', 'PyTorch', 'machine learning'],
    '运营': ['用户运营', '活动策划', '数据分析', '内容运营', 'operation']
  };
  const roleKey = Object.keys(roleSkills).find(key => position.title.includes(key));
  const allKeywords = [...new Set([...keywords, ...(roleKey ? roleSkills[roleKey] : [])])];
  const matched = allKeywords.filter(keyword => content.toLowerCase().includes(keyword.toLowerCase()));
  const score = Math.min(96, Math.max(35, Math.round(45 + matched.length / Math.max(roleKey ? roleSkills[roleKey].length : keywords.length, 1) * 45 + (Number(years) >= 2 ? 10 : 0))));
  const level = score >= 80 ? '高度匹配' : score >= 65 ? '较匹配' : '匹配度一般';
  const reasons = matched.length ? [`简历包含 ${matched.slice(0, 4).join('、')}`, Number(years) ? `识别到约 ${years} 年相关经验` : '已完成基础经历识别'] : ['暂未匹配到岗位关键词'];
  const gaps = allKeywords.filter(keyword => !matched.includes(keyword)).slice(0, 4);
  const skillDictionary = [...new Set(Object.values(roleSkills).flat())];
  const matchedSkills = skillDictionary.filter(skill => content.toLowerCase().includes(skill.toLowerCase()));
  const email = content.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
  const phone = content.match(/(?:1[3-9]\d{9}|(?:电话|手机)\s*[:：]?\s*1[3-9]\d{9})/)?.[0].replace(/^(?:电话|手机)\s*[:：]?\s*/i, '') || '';
  return { candidate: { name, role: position.title, positionId: position.id, stage: '待沟通', nextAction: 'HR 联系候选人确认意向', sourceGroup: '简历上传', confidence: score, workYears: Number(years), email, phone, skills: matchedSkills, updatedAt: nowLabel() }, profile: { name, years: Number(years), email, phone, matchedSkills }, match: { score, level, reasons, gaps, recommendation: score >= 75 ? '建议进入初筛' : '建议人工复核后决定是否推进' }, mode: '规则匹配' };
}
async function modelResumeMatch(text, position, fallback) {
  if (!isModelConfigured()) return { ...fallback, mode: USE_MOCK_AI ? 'Mock/规则兜底' : '规则匹配（未配置 DeepSeek）', aiUsed: false };
  const messages = [{ role: 'system', content: '你是招聘简历信息抽取和岗位匹配助手。只依据简历原文，无法确认的字段返回空字符串或 null，禁止猜测姓名、联系方式、年限和经历。返回 JSON：candidate{name,confidence}、profile{name,years,email,phone,matchedSkills}、match{score,level,reasons,gaps,recommendation}。score 为 0-100 整数，reasons/gaps 为字符串数组。不得作出录用决定。' }, { role: 'user', content: JSON.stringify({ position, resume: String(text).slice(0, 18000) }) }];
  let data;
  try { data = await requestModelJson(messages, { maxTokens: 1600 }); } catch (error) {
    if (!String(error.message).includes('模型接口返回 400')) throw error;
    data = await requestModelJson(messages, { maxTokens: 1600, jsonMode: false });
  }
  const modelCandidate = data.candidate || {};
  const modelName = cleanResumeName(modelCandidate.name) || fallback.candidate.name;
  const modelScore = normalizeScore(data.match?.score ?? modelCandidate.confidence, fallback.match.score);
  const modelYears = Number(data.profile?.years);
  const profile = { ...fallback.profile, ...(data.profile || {}), name: modelName, years: Number.isFinite(modelYears) ? modelYears : fallback.profile.years, email: fallback.profile.email || data.profile?.email || '', phone: fallback.profile.phone || data.profile?.phone || '' };
  return { ...fallback, ...data, candidate: { ...fallback.candidate, ...modelCandidate, name: modelName, positionId: position.id, role: position.title, sourceGroup: '简历上传', confidence: modelScore, workYears: profile.years, email: profile.email, phone: profile.phone, skills: Array.isArray(profile.matchedSkills) ? profile.matchedSkills : fallback.profile.matchedSkills, updatedAt: nowLabel() }, profile, match: { ...fallback.match, ...(data.match || {}), score: modelScore, reasons: Array.isArray(data.match?.reasons) ? data.match.reasons : fallback.match.reasons, gaps: Array.isArray(data.match?.gaps) ? data.match.gaps : fallback.match.gaps }, mode: `模型：${MODEL_NAME}`, aiUsed: true, aiProvider: MODEL_PROVIDER, aiModel: MODEL_NAME };
}
async function processOne(state, message, sourceGroup, sourceMessageId = '') {
  const messageKey = sourceMessageId || crypto.createHash('sha1').update(`${sourceGroup}|${message}`).digest('hex');
  if (state.processedMessages.includes(messageKey)) return { duplicate: true, messageKey };
  const fallback = ruleExtract(message, sourceGroup);
  let extraction = { data: fallback, mode: '规则兜底' };
  try { extraction = await modelExtract(message, sourceGroup, fallback); } catch { extraction = { data: fallback, mode: '规则兜底（模型不可用）' }; }
  extraction.data.sourceMessageId = messageKey;
  const matchedPosition = state.positions.find(position => message.includes(position.title) || extraction.data.role === position.title || (extraction.data.role && position.title.includes(extraction.data.role)));
  if (matchedPosition) { extraction.data.positionId = matchedPosition.id; extraction.data.role = matchedPosition.title; }
  const existingCandidate = findCandidateMatch(state, extraction.data);
  if (matchedPosition && !positionAcceptsNewCandidates(matchedPosition) && !existingCandidate) {
    state.processedMessages.push(messageKey);
    recordActivity(state, '消息拦截', `${extraction.data.name}关联的“${matchedPosition.title}”岗位暂不接收新候选人，未写入台账`, '⚠');
    return { duplicate: false, created: false, blocked: true, candidate: extraction.data, mode: extraction.mode, messageKey, reason: `${matchedPosition.status}岗位不能新增候选人` };
  }
  const reviewNeeded = needsReview(extraction.data, state);
  if (reviewNeeded) {
    const possibleMatches = candidateMatchesByNameRole(state, extraction.data);
    addReview(state, { type: 'message', candidate: { ...extraction.data, possibleCandidateIds: possibleMatches.map(item => item.candidateId) }, existingCandidateId: existingCandidate?.id || null, message, sourceGroup, sourceMessageId: messageKey, mode: extraction.mode });
    state.processedMessages.push(messageKey);
    recordActivity(state, '待人工确认', `${extraction.data.name}待确认后再写入台账`, '⚠');
    return { duplicate: false, created: false, pendingReview: true, candidate: extraction.data, mode: extraction.mode, messageKey };
  }
  const candidate = upsertCandidate(state, extraction.data);
  state.processedMessages.push(messageKey);
  recordActivity(state, 'AI 提取', `${candidate.name}进入“${candidate.stage}”`, '✦');
  state.metrics.newThisWeek += candidate.created ? 1 : 0;
  state.metrics.savedHours = Math.round((state.metrics.savedHours + 0.08) * 10) / 10;
  return { duplicate: false, created: candidate.created, candidate, mode: extraction.mode, messageKey };
}
async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/state') { const state = readState(); return json(res, 200, { ...state, orgOptions: ORG_OPTIONS, aiMode: aiModeLabel() }); }
  if (req.method === 'GET' && pathname === '/api/options') return json(res, 200, ORG_OPTIONS);
  if (req.method === 'POST' && pathname === '/api/org-options') { const body = await parseBody(req); const key = OPTION_TYPES[body.type]; const name = String(body.name || '').trim(); if (!key) return json(res, 400, { error: '选项类型不合法' }); if (!name || name.length > 30) return json(res, 400, { error: '选项名称不能为空且不能超过 30 个字符' }); const state = readState(); if (ORG_OPTIONS[key].some(item => item.toLowerCase() === name.toLowerCase())) return json(res, 409, { error: '该选项已存在' }); ORG_OPTIONS[key].push(name); writeState(state); return json(res, 201, { orgOptions: ORG_OPTIONS, state }); }
  if (req.method === 'DELETE' && pathname === '/api/org-options') { const body = await parseBody(req); const key = OPTION_TYPES[body.type]; const name = String(body.name || '').trim(); if (!key || !name) return json(res, 400, { error: '请选择要删除的有效选项' }); const state = readState(); const index = ORG_OPTIONS[key].findIndex(item => item === name); if (index < 0) return json(res, 404, { error: '选项不存在' }); if (ORG_OPTIONS[key].length <= 1) return json(res, 400, { error: '至少保留一个选项' }); const used = key === 'departments' ? state.positions.some(position => position.department === name) : state.positions.some(position => position.recruiter === name) || state.candidates.some(candidate => candidate.recruiter === name); if (used) return json(res, 409, { error: `“${name}”正在被使用，不能删除` }); ORG_OPTIONS[key].splice(index, 1); writeState(state); return json(res, 200, { orgOptions: ORG_OPTIONS, state }); }
  if (req.method === 'GET' && pathname === '/api/positions') { const state = readState(); return json(res, 200, { positions: state.positions }); }
  if (req.method === 'POST' && pathname === '/api/resumes/match') { const body = await parseBody(req); const state = readState(); const position = state.positions.find(item => item.id === body.positionId); if (!position) return json(res, 400, { error: '请选择有效岗位' }); if (!positionAcceptsNewCandidates(position)) return json(res, 400, { error: `${position.status}岗位不能继续匹配新简历` }); if (!body.pdfBase64) return json(res, 400, { error: '请上传 PDF 简历' }); let text; try { text = await extractPdfText(body.pdfBase64); } catch (error) { return json(res, 422, { error: `PDF 解析失败：${error.message.includes('ENOENT') ? '服务器未找到 pdftotext，请安装 Poppler 并配置 PATH 或 PDFTOTEXT_PATH' : '文件损坏或格式不受支持'}` }); } if (!text) return json(res, 422, { error: 'PDF 未提取到文字，可能是扫描图片型简历；请先 OCR 或上传可复制文字的 PDF。' }); const fallback = resumeMatchFallback(text, position); let result; try { result = await modelResumeMatch(text, position, fallback); } catch (error) { result = { ...fallback, mode: isModelConfigured() ? `规则匹配（${MODEL_PROVIDER} 调用失败）` : '规则匹配（未配置 DeepSeek）', aiUsed: false, aiError: error.message }; } const missingName = result.candidate?.name === '待确认候选人'; const lowConfidence = (result.match?.score || result.candidate?.confidence || 0) < 65; if (missingName || lowConfidence) result.match.reviewRequired = true; return json(res, 200, { fileName: body.fileName || 'resume.pdf', extractedText: text.slice(0, 5000), position, aiConfigured: isModelConfigured(), aiProvider: MODEL_PROVIDER, aiModel: MODEL_NAME, ...result }); }
  if (req.method === 'POST' && pathname === '/api/resumes/apply') { const body = await parseBody(req); const state = readState(); const cleanName = cleanResumeName(body.candidate?.name); if (!cleanName || cleanName === '待确认候选人' || !body.candidate?.positionId) return json(res, 400, { error: '请确认有效的候选人姓名和关联岗位后再入库' }); const position = state.positions.find(item => item.id === body.candidate.positionId); if (!position) return json(res, 400, { error: '关联岗位不存在' }); if (!positionAcceptsNewCandidates(position)) return json(res, 400, { error: `${position.status}岗位不能加入新候选人` }); const pendingCandidate = { ...body.candidate, name: cleanName, role: position.title, sourceGroup: '简历上传', rawMessage: `简历匹配：${position.title}` }; if (body.reviewRequired === true || needsReview(pendingCandidate, state)) { addReview(state, { type: 'resume', candidate: pendingCandidate, positionId: position.id, extractedText: body.extractedText || '' }); recordActivity(state, '待人工确认', `${cleanName}的简历匹配结果待确认，暂未写入正式台账`, '⚠'); writeState(state); return json(res, 200, { pendingReview: true, candidate: pendingCandidate, state }); } const candidate = upsertCandidate(state, pendingCandidate); recordActivity(state, '简历入库', `${candidate.name}已加入“${position.title}”候选人台账`, '▣'); writeState(state); return json(res, 200, { candidate, state }); }
  const candidateMatch = pathname.match(/^\/api\/candidates\/([^/]+)$/);
  if (candidateMatch && req.method === 'PUT') { const body = await parseBody(req); if (body.candidateId !== undefined) return json(res, 400, { error: '应聘者 ID 为系统生成字段，不能修改' }); const state = readState(); const candidate = state.candidates.find(item => item.id === candidateMatch[1]); if (!candidate) return json(res, 404, { error: '候选人不存在' }); if (body.stage !== undefined && !CANDIDATE_STAGES.includes(body.stage)) return json(res, 400, { error: '候选人阶段不合法' }); const targetPosition = body.positionId ? state.positions.find(position => position.id === body.positionId) : null; if (body.positionId !== undefined && body.positionId !== null && !targetPosition) return json(res, 400, { error: '关联岗位不存在' }); if (targetPosition?.status === '已关闭') return json(res, 400, { error: '已关闭岗位不能关联候选人' }); if (body.recruiter !== undefined && !ORG_OPTIONS.recruiters.includes(body.recruiter)) return json(res, 400, { error: '请选择有效的招聘负责人' }); const previousStage = candidate.stage; if (body.stage !== undefined) { candidate.stage = body.stage; if (body.nextAction === undefined) candidate.nextAction = STAGE_NEXT_ACTIONS[body.stage]; candidate.hiredAt = body.stage === '已录用' ? (candidate.hiredAt || nowLabel()) : null; } if (body.nextAction !== undefined) candidate.nextAction = String(body.nextAction).trim(); if (body.recruiter !== undefined) candidate.recruiter = body.recruiter; if (body.positionId !== undefined) { candidate.positionId = body.positionId; candidate.role = targetPosition?.title || '待确认岗位'; if (body.recruiter === undefined && targetPosition) candidate.recruiter = targetPosition.recruiter; } candidate.updatedAt = nowLabel(); recordActivity(state, '候选人更新', `${candidate.name} · ${previousStage} → ${candidate.stage}`, '↗'); writeState(state); return json(res, 200, { candidate, state }); }
  const reviewMatch = pathname.match(/^\/api\/reviews\/([^/]+)$/);
  if (reviewMatch && req.method === 'POST') { const body = await parseBody(req); const state = readState(); const index = state.reviewQueue.findIndex(item => item.id === reviewMatch[1]); if (index < 0) return json(res, 404, { error: '待确认记录不存在' }); const review = state.reviewQueue[index]; const input = { ...(review.candidate || {}), ...(body.candidate || {}) }; const selectedCandidateId = String(body.selectedCandidateId || input.selectedCandidateId || '').trim(); const cleanName = cleanResumeName(input.name); const positionId = input.positionId || review.positionId; if (!cleanName || cleanName === '待确认候选人' || !positionId) return json(res, 400, { error: '确认入账前请补全候选人姓名和关联岗位' }); if (input.stage && !CANDIDATE_STAGES.includes(input.stage)) return json(res, 400, { error: '请选择有效的招聘阶段' }); const position = state.positions.find(item => item.id === positionId); if (!position) return json(res, 400, { error: '关联岗位不存在' }); if (position.status === '已关闭') return json(res, 400, { error: '已关闭岗位不能加入候选人' }); const possibleCandidateIds = review.candidate?.possibleCandidateIds || []; const selectedCandidate = selectedCandidateId ? state.candidates.find(item => item.candidateId === selectedCandidateId) : null; const allowedSelectedId = possibleCandidateIds.includes(selectedCandidateId) || (review.existingCandidateId && selectedCandidate?.id === review.existingCandidateId); if (selectedCandidateId && (!selectedCandidate || !allowedSelectedId)) return json(res, 400, { error: '请选择本条待确认记录对应的已有候选人 ID' }); const existing = selectedCandidate || (review.existingCandidateId ? state.candidates.find(item => item.id === review.existingCandidateId) : null); const candidate = upsertCandidate(state, { ...input, id: undefined, candidateId: undefined, selectedCandidateId: undefined, possibleCandidateIds: undefined, name: cleanName, role: position.title, positionId: position.id, stage: CANDIDATE_STAGES.includes(input.stage) ? input.stage : (existing?.stage || '待沟通'), nextAction: String(input.nextAction || STAGE_NEXT_ACTIONS[input.stage] || existing?.nextAction || '联系候选人确认意向').trim(), sourceGroup: input.sourceGroup || review.sourceGroup || '人工确认' }, existing); state.reviewQueue.splice(index, 1); recordActivity(state, '人工确认', `${candidate.name}已确认并写入“${position.title}”候选人台账`, '✓'); writeState(state); return json(res, 200, { candidate, state }); }
  if (reviewMatch && req.method === 'DELETE') { const body = await parseBody(req); const state = readState(); const index = state.reviewQueue.findIndex(item => item.id === reviewMatch[1]); if (index < 0) return json(res, 404, { error: '待确认记录不存在' }); const [review] = state.reviewQueue.splice(index, 1); if (review.sourceMessageId) state.processedMessages = state.processedMessages.filter(item => item !== review.sourceMessageId); const reason = String(body.reason || '').trim(); recordActivity(state, '人工驳回', `${review.candidate?.name || '候选人'}的待确认记录已驳回${reason ? `：${reason}` : ''}`, '×'); writeState(state); return json(res, 200, { state }); }
  if (req.method === 'POST' && pathname === '/api/positions') { const body = await parseBody(req); const title = String(body.title || '').trim(); if (!title) return json(res, 400, { error: '岗位名称不能为空' }); if (!ORG_OPTIONS.departments.includes(body.department)) return json(res, 400, { error: '请选择有效的所属部门' }); if (!ORG_OPTIONS.recruiters.includes(body.recruiter)) return json(res, 400, { error: '请选择有效的招聘负责人' }); const state = readState(); if (state.positions.some(position => position.title === title)) return json(res, 409, { error: '岗位名称已存在' }); const position = { id: `pos-${crypto.randomUUID()}`, title, department: body.department, recruiter: body.recruiter, status: ['招聘中','暂停招聘','已关闭'].includes(body.status) ? body.status : '招聘中', headcount: Math.max(1, Number(body.headcount) || 1), deadline: String(body.deadline || '').trim(), description: String(body.description || '').trim(), updatedAt: nowLabel() }; state.positions.unshift(position); recordActivity(state, '岗位创建', `已创建“${position.title}”岗位`, '＋'); writeState(state); return json(res, 201, { position, state }); }
  const positionMatch = pathname.match(/^\/api\/positions\/([^/]+)$/);
  if (positionMatch && req.method === 'PUT') { const body = await parseBody(req); const state = readState(); const position = state.positions.find(item => item.id === positionMatch[1]); if (!position) return json(res, 404, { error: '岗位不存在' }); const title = String(body.title ?? position.title).trim(); const department = body.department ?? position.department; const recruiter = body.recruiter ?? position.recruiter; if (!title) return json(res, 400, { error: '岗位名称不能为空' }); if (!ORG_OPTIONS.departments.includes(department)) return json(res, 400, { error: '请选择有效的所属部门' }); if (!ORG_OPTIONS.recruiters.includes(recruiter)) return json(res, 400, { error: '请选择有效的招聘负责人' }); if (state.positions.some(item => item.id !== position.id && item.title === title)) return json(res, 409, { error: '岗位名称已存在' }); Object.assign(position, { title, department, recruiter, status: ['招聘中','暂停招聘','已关闭'].includes(body.status) ? body.status : position.status, headcount: Math.max(1, Number(body.headcount) || position.headcount), deadline: String(body.deadline ?? position.deadline).trim(), description: String(body.description ?? position.description).trim(), updatedAt: nowLabel() }); state.candidates.forEach(candidate => { if (candidate.positionId === position.id) { candidate.role = position.title; if (body.recruiter !== undefined) candidate.recruiter = recruiter; } }); recordActivity(state, '岗位更新', `已更新“${position.title}”岗位`, '✎'); writeState(state); return json(res, 200, { position, state }); }
  if (positionMatch && req.method === 'DELETE') { const state = readState(); const index = state.positions.findIndex(item => item.id === positionMatch[1]); if (index < 0) return json(res, 404, { error: '岗位不存在' }); const [position] = state.positions.splice(index, 1); state.candidates.forEach(candidate => { if (candidate.positionId === position.id) { candidate.positionId = null; candidate.role = '待确认岗位'; candidate.updatedAt = nowLabel(); } }); state.reviewQueue = state.reviewQueue.filter(review => review.positionId !== position.id && review.candidate?.positionId !== position.id); recordActivity(state, '岗位删除', `已删除“${position.title}”岗位，关联候选人保留但已解除岗位关联`, '−'); writeState(state); return json(res, 200, { deleted: position, state }); }
  if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, aiConfigured: isModelConfigured(), resumeAiConfigured: isModelConfigured(), mockAi: USE_MOCK_AI, provider: MODEL_PROVIDER, model: MODEL_NAME, port: PORT });
  if (req.method === 'GET' && pathname === '/api/export.csv') { const state = readState(); const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); const scope = url.searchParams.get('scope') || 'active'; if (!['active', 'hired', 'today', 'position', 'filtered', 'all'].includes(scope)) return json(res, 400, { error: '导出范围不合法' }); if (scope === 'position' && !url.searchParams.get('positionId')) return json(res, 400, { error: '指定岗位导出必须提供岗位 ID' }); const candidates = exportCandidates(state, url.searchParams); const rows = [['应聘者 ID','候选人','岗位','招聘负责人','阶段','下一步','来源群','置信度','更新时间'], ...candidates.map(item => [item.candidateId,item.name,item.role,item.recruiter,item.stage,item.nextAction,item.sourceGroup,`${item.confidence}%`,item.updatedAt])]; const csv = '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\n'); const filenames = { active: 'HireFlow-active-candidates.csv', hired: 'HireFlow-hired-candidates.csv', today: 'HireFlow-updated-today.csv', position: 'HireFlow-position-candidates.csv', filtered: 'HireFlow-filtered-candidates.csv', all: 'HireFlow-all-candidates.csv' }; res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filenames[scope]}"` }); return res.end(csv); }
  if (req.method === 'POST' && pathname === '/api/process') { const body = await parseBody(req); const state = readState(); const messages = normalizeMessages(body.text); if (!messages.length) return json(res, 400, { error: '请至少提供一条招聘消息' }); const results = []; for (const message of messages) results.push(await processOne(state, message, body.sourceGroup, body.messageIds?.[results.length] || '')); writeState(state); return json(res, 200, { ...state, results, aiMode: aiModeLabel() }); }
  if (req.method === 'POST' && pathname === '/api/webhook/wecom') { const body = await parseBody(req); const state = readState(); const message = body.text?.content || body.content || ''; if (!message) return json(res, 400, { error: '缺少 text.content 或 content' }); const result = await processOne(state, message, body.groupName || body.sourceGroup || '企业微信招聘群', body.messageId || body.msgid || ''); state.syncedAt = nowLabel(); writeState(state); return json(res, 200, { ok: true, result, state, aiMode: aiModeLabel() }); }
  if (req.method === 'POST' && pathname === '/api/sync') { const body = await parseBody(req); const state = readState(); const messages = body.messages || [
    { text: '@招聘组 赵子昂，数据分析师，已通过初筛，请安排明天下午面试。', sourceGroup: '数据招聘群' },
    { text: '@招聘组 张悦，运营专员，简历已发，候选人确认薪资范围。', sourceGroup: '运营招聘群' },
    { text: '@招聘组 陈嘉，前端开发，技术面试反馈通过，准备推进 Offer。', sourceGroup: '技术招聘群' }
  ]; if (!Array.isArray(messages) || messages.some(item => !item || !String(item.text || '').trim())) return json(res, 400, { error: 'messages 必须是包含 text 的数组' }); const results = []; for (const item of messages) results.push(await processOne(state, item.text, item.sourceGroup, item.messageId || '')); state.syncedAt = nowLabel(); const added = results.filter(result => !result.duplicate).length; recordActivity(state, '群聊同步', `已接收 ${messages.length} 条消息，新增处理 ${added} 条`, '↻'); writeState(state); return json(res, 200, { ...state, results, aiMode: aiModeLabel() }); }
  if (req.method === 'POST' && pathname === '/api/reset') { const state = initialState(); writeState(state); return json(res, 200, state); }
  if (req.method === 'POST' && pathname === '/api/activities/clear') { const state = readState(); state.activities = []; writeState(state); return json(res, 200, state); }
  return json(res, 404, { error: 'Not found' });
}
function serveFile(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  if (requested !== '/index.html' && !requested.startsWith('/assets/')) return json(res, 404, { error: 'Not found' });
  const safePath = path.resolve(ROOT, `.${requested}`);
  const assetRoot = path.join(ROOT, 'assets') + path.sep;
  if (safePath !== path.join(ROOT, 'index.html') && !safePath.startsWith(assetRoot)) return json(res, 404, { error: 'Not found' });
  fs.readFile(safePath, (error, data) => { if (error) return json(res, 404, { error: 'Not found' }); const type = safePath.endsWith('.html') ? 'text/html; charset=utf-8' : safePath.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/plain; charset=utf-8'; res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(data); });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try { if (url.pathname.startsWith('/api/')) await handleApi(req, res, url.pathname); else serveFile(req, res, url.pathname); } catch (error) { json(res, 500, { error: error.message }); }
});
server.listen(PORT, () => console.log(`HireFlow running at http://localhost:${PORT}`));
