/**
 * 消融实验的运行环境。
 *
 * 设计口径（和 cf-coach 主程序"保留 api 接口"这条要求对齐）：
 *  - 模型服务直接读 cf-coach 的 `data/config.json`（同一个 providers 数组、同一套
 *    baseUrl/apiKey/type），所以 L0/L1 用的是**和 L2 完全相同的模型接口与参数**；
 *  - 也支持命令行覆盖（--base-url / --api-key / --provider-type），这样既能跑真模型，
 *    也能对着 `scripts/mock-llm.js` 做零 token 的自测（见 ablation/selftest.js）；
 *  - 三个档位拿到的题面文本是**同一份文件**（problems.json 里的 statement 路径），
 *    信息预算由此对齐（评审最容易质疑的就是"给 L1 的题面和给 L2 的不一样"）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');

/**
 * 应用数据目录的解析顺序（**工作台必须看应用真正在用的那个目录**）：
 *   1. `CHATBOX_DATA_DIR` / `CFCOACH_APP_DATA`（显式覆盖，探针与自测靠它隔离）；
 *   2. 仓库里的 `data/`（开发态跑应用时用的就是它）；
 *   3. 打包产物 `dist/<...>/data/`（**用户跑的是打包版 exe，配置与题面缓存都在这里**）。
 * 2 与 3 里挑"有 providers 配置"的那个 —— 模型服务、题面缓存、工作区都从同一个目录来，
 * 否则会出现"模型配置来自 A、题面缓存却去 B 找"这种自相矛盾的状态。
 */
function hasProviders(dir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    return Array.isArray(cfg.providers) && cfg.providers.length > 0;
  } catch {
    return false;
  }
}

function packedDataDirs() {
  const out = [];
  try {
    for (const name of fs.readdirSync(path.join(ROOT, 'dist'))) {
      if (/^(CFCoach|cfcoach)/i.test(name)) out.push(path.join(ROOT, 'dist', name, 'data'));
    }
  } catch { /* 没打过包 */ }
  return out;
}

/** 候选目录（按优先级），供报错信息与探针使用 */
function dataDirCandidates() {
  const env = process.env.CHATBOX_DATA_DIR || process.env.CFCOACH_APP_DATA;
  if (env) return [path.resolve(env)];
  return [path.join(ROOT, 'data')].concat(packedDataDirs());
}

/** 从候选里挑一个：优先"有 providers 配置"的，其次第一个存在的，兜底最后一个 */
function pickDataDir(cands) {
  const list = Array.isArray(cands) ? cands.filter(Boolean) : [];
  if (!list.length) return path.join(ROOT, 'data');
  const withProviders = list.find((d) => hasProviders(d));
  if (withProviders) return withProviders;
  return list.find((d) => fs.existsSync(d)) || list[list.length - 1];
}

function dataDir() {
  return pickDataDir(dataDirCandidates());
}

function loadAppConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** 极简 argv 解析：`--k v` / `--k=v` / 裸 `--flag`；同名多次出现合并成数组 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    let key = a.slice(2);
    let val = true;
    const eq = key.indexOf('=');
    if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { val = argv[++i]; }
    key = key.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
    if (out[key] === undefined) out[key] = val;
    else if (Array.isArray(out[key])) out[key].push(val);
    else out[key] = [out[key], val];
  }
  return out;
}

/** 'a,b' / ['a','b'] / 'a' → ['a','b']（去空、去重、保序） */
function listOf(v) {
  const raw = Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]);
  const out = [];
  for (const item of raw) {
    for (const piece of String(item).split(',')) {
      const s = piece.trim();
      if (s && out.indexOf(s) < 0) out.push(s);
    }
  }
  return out;
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function bool(v, dflt) {
  if (v === undefined || v === null || v === '') return !!dflt;
  return !/^(0|false|no|off)$/i.test(String(v));
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 解析出要跑的"模型目标"列表。
 * @returns {{provider:object, providerId:string, model:string}[]}
 */
function resolveTargets(args) {
  const cfg = loadAppConfig();
  const providers = Array.isArray(cfg.providers) ? cfg.providers : [];
  let provider;
  if (args.baseUrl) {
    provider = {
      id: 'cli',
      name: 'cli',
      type: String(args.providerType || 'openai') === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: String(args.baseUrl),
      apiKey: String(args.apiKey || 'cli'),
      stream: true
    };
  } else {
    const wantId = String(args.providerId || cfg.defaultProviderId || '');
    provider = providers.find((p) => p.id === wantId)
      || providers.find((p) => p.apiKey)
      || providers[0];
    if (!provider) {
      throw new Error('没有可用模型服务：' + dataDirCandidates().join(' / ')
        + ' 里都没有 config.json 的 providers。两种修法：① 在应用里配一个服务商（配置就写在应用的数据目录里）；'
        + '② 直接给命令行参数，例如 --base-url https://api.deepseek.com --api-key sk-… --model deepseek-flash');
    }
  }
  const models = listOf(args.model);
  if (!models.length) {
    const fromCfg = cfg.defaultModel;
    const fromProvider = provider.models && provider.models.length
      ? (typeof provider.models[0] === 'string' ? provider.models[0] : provider.models[0].id)
      : '';
    models.push(String(fromCfg || fromProvider || 'deepseek-chat'));
  }
  return models.map((model) => ({ provider, providerId: String(provider.id || 'cli'), model }));
}

/** 生成参数：默认沿用 cf-coach 的 defaultParams（保证和 L2 同参） */
function resolveParams(args) {
  const cfg = loadAppConfig();
  const d = cfg.defaultParams || {};
  return {
    temperature: args.temperature !== undefined ? num(args.temperature, 0.6) : num(d.temperature, 0.6),
    topP: args.topP !== undefined ? num(args.topP, 1) : num(d.topP, 1),
    maxTokens: args.maxTokens !== undefined ? num(args.maxTokens, 0) : num(d.maxTokens, 0)
  };
}

module.exports = {
  ROOT,
  dataDir,
  dataDirCandidates,
  pickDataDir,
  hasProviders,
  loadAppConfig,
  parseArgs,
  listOf,
  num,
  bool,
  sha256,
  resolveTargets,
  resolveParams
};
