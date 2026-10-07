import * as fs from 'fs';
import * as path from 'path';

/** Persisted deployment settings, written by `npm run deploy`. */
export interface DeployConfig {
  region: string;
  stackName: string;
  instanceType: string;
  volumeSizeGiB: number;
  privateSubnet: boolean;
  dshVersion: string;
  nodeMajor: number;
  webPort: number;
  blockImdsForAgent: boolean;
  vpcId?: string;
  existingSecretArn?: string;
}

export const CONFIG_FILE = path.join(__dirname, '..', 'deploy.config.json');
export const EXAMPLE_FILE = `${CONFIG_FILE}.example`;

/** Values offered by the menu when there is no previous configuration. */
export const DEFAULTS: Omit<DeployConfig, 'region'> = {
  stackName: 'DeepseekHarness',
  instanceType: 't4g.large',
  volumeSizeGiB: 50,
  privateSubnet: false,
  dshVersion: '0.2.0-rc.2',
  nodeMajor: 22,
  webPort: 3080,
  blockImdsForAgent: true,
};

/** One line per field, shown by `npm run show-config` and in the README. */
export const FIELD_HELP: Record<keyof DeployConfig, string> = {
  region: 'Región de AWS donde se despliega el stack',
  stackName: 'Nombre del stack de CloudFormation',
  instanceType: 'Tipo de instancia EC2 (ARM o x86; la AMI se elige sola)',
  volumeSizeGiB: 'Tamaño del disco raíz en GiB',
  privateSubnet: 'true: subred privada + NAT Gateway (costo extra)',
  dshVersion: 'Versión de @deepseek-ai/dsh',
  nodeMajor: 'Versión mayor de Node.js',
  webPort: 'Puerto de la Web UI (en loopback y en el túnel local)',
  blockImdsForAgent: 'Bloquea al agente el acceso a las credenciales de la instancia',
  vpcId: '(opcional) VPC existente en lugar de crear una',
  existingSecretArn: '(opcional) Secreto existente con la DEEPSEEK_API_KEY',
};

const REQUIRED_TYPES: Record<keyof DeployConfig, 'string' | 'number' | 'boolean'> = {
  region: 'string',
  stackName: 'string',
  instanceType: 'string',
  volumeSizeGiB: 'number',
  privateSubnet: 'boolean',
  dshVersion: 'string',
  nodeMajor: 'number',
  webPort: 'number',
  blockImdsForAgent: 'boolean',
  vpcId: 'string',
  existingSecretArn: 'string',
};
const OPTIONAL_FIELDS = new Set<keyof DeployConfig>(['vpcId', 'existingSecretArn']);

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
    } else if (typeof value !== type) {
      errors.push(`"${key}" debe ser ${type}`);
    }
  }
  for (const key of Object.keys(obj)) {
    if (!(key in REQUIRED_TYPES)) errors.push(`campo desconocido "${key}"`);
  }
  if (errors.length) {
    throw new Error(`${source} no es válido:\n  - ${errors.join('\n  - ')}`);
  }
  const config = obj as unknown as DeployConfig;
  if (!config.vpcId) delete config.vpcId;
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
  const valueWidth = Math.max(...keys.map((k) => String(config[k] ?? '—').length));
  return keys.map((k) => `  ${k.padEnd(width)}  ${String(config[k] ?? '—').padEnd(valueWidth)}  ${FIELD_HELP[k]}`);
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
