import * as fs from 'fs';
import * as path from 'path';
import type { NetworkConfig } from './network';

export type { NetworkConfig };

/** Where the agent's model runs. */
export type LlmProvider = 'bedrock' | 'deepseek-api';
export const LLM_PROVIDERS: readonly LlmProvider[] = ['bedrock', 'deepseek-api'];

/**
 * DeepSeek models on Bedrock that dsh's pi-ai catalog knows. Bedrock caps
 * their output at 8K tokens, while the pi-ai catalog claims 80K, so the
 * values here override the catalog (see assets/bootstrap.sh).
 */
export const BEDROCK_MODELS: Record<string, { name: string; contextWindow: number; maxTokens: number }> = {
  'deepseek.v3.2': { name: 'DeepSeek V3.2', contextWindow: 163840, maxTokens: 8192 },
  'deepseek.v3-v1:0': { name: 'DeepSeek-V3.1', contextWindow: 131072, maxTokens: 8192 },
};

/** Persisted deployment settings, written by `npm run deploy`. */
export interface DeployConfig {
  region: string;
  llmProvider: LlmProvider;
  bedrockModel: string;
  bedrockInferenceProfile: boolean;
  stackName: string;
  instanceType: string;
  volumeSizeGiB: number;
  network: NetworkConfig;
  dshVersion: string;
  nodeMajor: number;
  webPort: number;
  blockImdsForAgent: boolean;
  existingSecretArn?: string;
}

export const CONFIG_FILE = path.join(__dirname, '..', 'deploy.config.json');
export const EXAMPLE_FILE = `${CONFIG_FILE}.example`;

/** Values offered by the menu when there is no previous configuration. */
export const DEFAULTS: Omit<DeployConfig, 'region'> = {
  llmProvider: 'bedrock',
  bedrockModel: 'deepseek.v3.2',
  bedrockInferenceProfile: true,
  stackName: 'DeepseekHarness',
  instanceType: 't4g.large',
  volumeSizeGiB: 50,
  network: { mode: 'new', privateSubnet: false },
  dshVersion: '0.2.0-rc.2',
  nodeMajor: 22,
  webPort: 3080,
  blockImdsForAgent: true,
};

/** One line per field, shown by `npm run show-config` and in the README. */
export const FIELD_HELP: Record<keyof DeployConfig, string> = {
  region: 'Región de AWS donde se despliega el stack',
  llmProvider: 'bedrock | deepseek-api: dónde corre el modelo',
  bedrockModel: 'Modelo de DeepSeek en Bedrock (solo con bedrock)',
  bedrockInferenceProfile: 'Perfil de inferencia con tags para costos (solo con bedrock)',
  stackName: 'Nombre del stack de CloudFormation',
  instanceType: 'Tipo de instancia EC2 (ARM o x86; la AMI se elige sola)',
  volumeSizeGiB: 'Tamaño del disco raíz en GiB',
  network: 'VPC nueva (pública o privada con NAT) o VPC y subred existentes',
  dshVersion: 'Versión de @deepseek-ai/dsh',
  nodeMajor: 'Versión mayor de Node.js',
  webPort: 'Puerto de la Web UI (en loopback y en el túnel local)',
  blockImdsForAgent: 'Bloquea al agente el acceso a las credenciales de la instancia',
  existingSecretArn: '(opcional) Secreto existente con la DEEPSEEK_API_KEY (solo con deepseek-api)',
};

const REQUIRED_TYPES: Record<keyof DeployConfig, 'string' | 'number' | 'boolean' | 'object'> = {
  region: 'string',
  llmProvider: 'string',
  bedrockModel: 'string',
  bedrockInferenceProfile: 'boolean',
  stackName: 'string',
  instanceType: 'string',
  volumeSizeGiB: 'number',
  network: 'object',
  dshVersion: 'string',
  nodeMajor: 'number',
  webPort: 'number',
  blockImdsForAgent: 'boolean',
  existingSecretArn: 'string',
};
const OPTIONAL_FIELDS = new Set<keyof DeployConfig>(['existingSecretArn']);

/** Problems with the `network` object, empty when it is valid. */
function networkErrors(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const net = raw as Record<string, unknown>;
  const expected: Record<string, Record<string, string>> = {
    new: { mode: 'string', privateSubnet: 'boolean' },
    existing: { mode: 'string', vpcId: 'string', subnetId: 'string', availabilityZone: 'string', subnetType: 'string' },
  };
  const fields = expected[net.mode as string];
  if (!fields) return ['"network.mode" debe ser new o existing'];
  const errors: string[] = [];
  for (const [key, type] of Object.entries(fields)) {
    if (net[key] === undefined || net[key] === '') errors.push(`falta "network.${key}"`);
    else if (typeof net[key] !== type) errors.push(`"network.${key}" debe ser ${type}`);
  }
  for (const key of Object.keys(net)) {
    if (!(key in fields)) errors.push(`campo desconocido "network.${key}" (con mode ${net.mode})`);
  }
  if (net.mode === 'existing') {
    if (typeof net.vpcId === 'string' && net.vpcId && !/^vpc-[0-9a-f]+$/.test(net.vpcId)) errors.push('"network.vpcId" no parece un ID de VPC');
    if (typeof net.subnetId === 'string' && net.subnetId && !/^subnet-[0-9a-f]+$/.test(net.subnetId)) {
      errors.push('"network.subnetId" no parece un ID de subred');
    }
    if (typeof net.subnetType === 'string' && net.subnetType && !['public', 'private'].includes(net.subnetType)) {
      errors.push('"network.subnetType" debe ser public o private');
    }
  }
  return errors;
}

/** One-line summary of the network settings. */
export function describeNetwork(net: NetworkConfig): string {
  if (net.mode === 'new') return `VPC nueva, subred ${net.privateSubnet ? 'privada con NAT' : 'pública'}`;
  return `${net.vpcId} / ${net.subnetId} (${net.availabilityZone}, ${net.subnetType === 'public' ? 'pública' : 'privada'})`;
}

/** Validates parsed JSON, listing every problem at once. */
export function parseDeployConfig(raw: unknown, source = CONFIG_FILE): DeployConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${source}: se esperaba un objeto JSON`);
  }
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];
  for (const [key, type] of Object.entries(REQUIRED_TYPES) as [keyof DeployConfig, string][]) {
    const value = obj[key];
    if (value === undefined || value === null || value === '') {
      if (!OPTIONAL_FIELDS.has(key)) errors.push(`falta "${key}"`);
    } else if (typeof value !== type || (type === 'object' && (value === null || Array.isArray(value)))) {
      errors.push(`"${key}" debe ser ${type}`);
    }
  }
  for (const key of Object.keys(obj)) {
    if (!(key in REQUIRED_TYPES)) errors.push(`campo desconocido "${key}"`);
  }
  errors.push(...networkErrors(obj.network));
  if (typeof obj.llmProvider === 'string' && !LLM_PROVIDERS.includes(obj.llmProvider as LlmProvider)) {
    errors.push(`"llmProvider" debe ser ${LLM_PROVIDERS.join(' o ')}`);
  }
  if (obj.llmProvider === 'bedrock' && typeof obj.bedrockModel === 'string' && !(obj.bedrockModel in BEDROCK_MODELS)) {
    errors.push(`"bedrockModel" debe ser uno de: ${Object.keys(BEDROCK_MODELS).join(', ')}`);
  }
  if (errors.length) {
    throw new Error(`${source} no es válido:\n  - ${errors.join('\n  - ')}`);
  }
  const config = obj as unknown as DeployConfig;
  if (!config.existingSecretArn) delete config.existingSecretArn;
  return config;
}

/** Returns the saved configuration, or undefined if it was never created. */
export function loadDeployConfig(file = CONFIG_FILE): DeployConfig | undefined {
  if (!fs.existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: JSON inválido (${(e as Error).message})`);
  }
  return parseDeployConfig(raw, file);
}

export function saveDeployConfig(config: DeployConfig, file = CONFIG_FILE): void {
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

/** One aligned "key  value  description" row per field. */
export function formatConfigRows(config: DeployConfig): string[] {
  const keys = Object.keys(FIELD_HELP) as (keyof DeployConfig)[];
  const width = Math.max(...keys.map((k) => k.length));
  const show = (k: keyof DeployConfig) => (k === 'network' ? describeNetwork(config.network) : String(config[k] ?? '—'));
  const valueWidth = Math.max(...keys.map((k) => show(k).length));
  return keys.map((k) => `  ${k.padEnd(width)}  ${show(k).padEnd(valueWidth)}  ${FIELD_HELP[k]}`);
}

/** Human-readable table of the configuration and where to edit it. */
export function formatDeployConfig(config: DeployConfig, file = CONFIG_FILE): string {
  return [
    `Configuración del deploy (${path.relative(process.cwd(), file) || file}):`,
    '',
    ...formatConfigRows(config),
    '',
    'Para cambiarla, editá el archivo y volvé a ejecutar "npm run deploy"',
    '(el menú propone los valores guardados) o "npx cdk deploy" directamente.',
  ].join('\n');
}
