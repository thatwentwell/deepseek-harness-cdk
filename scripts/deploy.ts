// Interactive deploy: `npm run deploy`.
// Asks for the model provider, region, model and instance type (plus
// optional advanced settings), checks
// the target account/region, writes deploy.config.json and runs `cdk deploy`.
// The config file is only written after the summary is confirmed.
import { spawnSync } from 'child_process';
import { confirm, input, number, search, select } from '@inquirer/prompts';
import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock';
import {
  CloudFormationClient,
  DescribeStacksCommand,
  Output,
} from '@aws-sdk/client-cloudformation';
import {
  DescribeInstanceTypesCommand,
  DescribeRegionsCommand,
  EC2Client,
  InstanceTypeInfo,
  paginateDescribeInstanceTypeOfferings,
} from '@aws-sdk/client-ec2';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import {
  VpcInfo,
  checkNewVpcQuotas,
  discoverVpcs,
  formatQuotas,
  quotaFits,
  quotaIncreaseHints,
} from './aws-network';
import {
  BEDROCK_MODELS,
  CONFIG_FILE,
  DEFAULTS,
  DeployConfig,
  LlmProvider,
  NetworkConfig,
  describeNetwork,
  formatConfigRows,
  formatDeployConfig,
  loadDeployConfig,
  saveDeployConfig,
} from '../lib/deploy-config';

const RECOMMENDED_TYPES = ['t4g.large', 't4g.xlarge', 'm7g.large', 'm7g.xlarge', 't3.large', 't3.xlarge', 'm7i.large'];
const OTHER = '__other__';

const REGION_NAMES: Record<string, string> = {
  'us-east-1': 'Norte de Virginia',
  'us-east-2': 'Ohio',
  'us-west-1': 'Norte de California',
  'us-west-2': 'Oregón',
  'ca-central-1': 'Canadá Central',
  'ca-west-1': 'Calgary',
  'mx-central-1': 'México',
  'sa-east-1': 'São Paulo',
  'eu-west-1': 'Irlanda',
  'eu-west-2': 'Londres',
  'eu-west-3': 'París',
  'eu-central-1': 'Fráncfort',
  'eu-central-2': 'Zúrich',
  'eu-north-1': 'Estocolmo',
  'eu-south-1': 'Milán',
  'eu-south-2': 'España',
  'ap-south-1': 'Bombay',
  'ap-south-2': 'Hyderabad',
  'ap-northeast-1': 'Tokio',
  'ap-northeast-2': 'Seúl',
  'ap-northeast-3': 'Osaka',
  'ap-southeast-1': 'Singapur',
  'ap-southeast-2': 'Sídney',
  'ap-southeast-3': 'Yakarta',
  'ap-southeast-4': 'Melbourne',
  'ap-east-1': 'Hong Kong',
  'me-central-1': 'EAU',
  'me-south-1': 'Baréin',
  'il-central-1': 'Tel Aviv',
  'af-south-1': 'Ciudad del Cabo',
};

async function main(): Promise<void> {
  console.log('\nDeepSeek Harness · deploy\n');

  const previous = loadDeployConfig();
  if (previous) console.log(`Usando ${CONFIG_FILE} como valores por defecto.\n`);

  const homeRegion = await new EC2Client({}).config.region().catch(() => undefined);
  const account = await getAccount(homeRegion ?? 'us-east-1');
  console.log(`Cuenta de AWS: ${account}\n`);

  // --- Stack name -------------------------------------------------------------
  // It identifies the environment: a new name deploys a separate one.
  const stackName = await input({
    message: 'Nombre del stack (identifica el entorno)',
    default: previous?.stackName ?? DEFAULTS.stackName,
    validate: (v) => /^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(v) || 'Letras, números y guiones; debe empezar con letra',
  });

  // --- Model provider -------------------------------------------------------
  let llmProvider = await select<LlmProvider>({
    message: 'Proveedor del modelo',
    choices: [
      { value: 'bedrock', name: 'Amazon Bedrock (DeepSeek en tu cuenta de AWS, sin API key)' },
      { value: 'deepseek-api', name: 'API de DeepSeek (requiere DEEPSEEK_API_KEY)' },
    ],
    default: previous?.llmProvider ?? DEFAULTS.llmProvider,
  });

  // --- Region (and Bedrock model, which must exist in that region) ----------
  const regions = await listRegions(homeRegion ?? 'us-east-1');
  let region = previous?.region ?? homeRegion ?? 'us-east-1';
  let bedrockModel = previous?.bedrockModel ?? DEFAULTS.bedrockModel;
  for (;;) {
    region = await select({
      message: 'Región de destino',
      choices: regions.map((r) => ({ value: r, name: REGION_NAMES[r] ? `${r}  (${REGION_NAMES[r]})` : r })),
      default: region,
      pageSize: 15,
    });
    if (llmProvider !== 'bedrock') break;

    process.stdout.write('Consultando modelos DeepSeek en Bedrock... ');
    const available = await listBedrockModels(region);
    console.log(available.length ? `${available.length} disponibles.` : 'ninguno.');
    if (available.length) {
      bedrockModel = await select({
        message: 'Modelo',
        choices: available.map((id) => ({ value: id, name: `${BEDROCK_MODELS[id].name.padEnd(14)} ${id}` })),
        default: available.includes(bedrockModel) ? bedrockModel : available[0],
      });
      break;
    }
    console.log(
      `\n⚠ ${region} no ofrece ${Object.keys(BEDROCK_MODELS).join(' ni ')} on-demand en Bedrock.\n` +
        '  La instancia y el modelo tienen que estar en la misma región (por ejemplo us-east-1,\n' +
        '  us-east-2, us-west-2, sa-east-1, eu-west-2, eu-north-1 o ap-northeast-1).',
    );
    const next = await select({
      message: '¿Qué hacemos?',
      choices: [
        { value: 'region', name: 'Elegir otra región' },
        { value: 'api', name: 'Usar la API de DeepSeek en esta región' },
      ],
    });
    if (next === 'api') {
      llmProvider = 'deepseek-api';
      break;
    }
  }

  // --- Network --------------------------------------------------------------
  const ec2 = new EC2Client({ region });
  // The saved settings describe this environment only if region and name match.
  const sameEnv = previous?.region === region && previous.stackName === stackName;
  const stackExisted = sameEnv && !!(await findStack(new CloudFormationClient({ region }), stackName));
  const network = await chooseNetwork(ec2, region, sameEnv ? previous.network : undefined, stackExisted);
  if (!network) return cancel('No hay red disponible para desplegar.');

  // --- Instance type --------------------------------------------------------
  // An existing subnet pins the availability zone, and not every type is in every zone.
  const az = network.mode === 'existing' ? network.availabilityZone : undefined;
  process.stdout.write('Consultando tipos de instancia disponibles... ');
  const offered = await listOfferedTypes(ec2, az);
  console.log(`${offered.size} disponibles en ${az ?? region}.`);

  const currentType = previous?.instanceType ?? DEFAULTS.instanceType;
  const shortlist = [...new Set([currentType, ...RECOMMENDED_TYPES])].filter((t) => offered.has(t));
  const details = await describeTypes(ec2, shortlist);
  let instanceType = await select({
    message: 'Tipo de instancia',
    choices: [
      ...shortlist.map((t) => ({ value: t, name: describeType(t, details.get(t)) })),
      { value: OTHER, name: 'Otro… (buscar entre todos)' },
    ],
    default: shortlist.includes(currentType) ? currentType : shortlist[0],
  });
  if (instanceType === OTHER) {
    const all = [...offered].filter((t) => !t.startsWith('mac')).sort();
    instanceType = await search({
      message: 'Buscar tipo de instancia (ej. "m7g", "c7i.2x")',
      source: (term) =>
        all.filter((t) => !term || t.includes(term.trim().toLowerCase())).slice(0, 50).map((t) => ({ value: t })),
      pageSize: 12,
    });
    const info = (await describeTypes(ec2, [instanceType])).get(instanceType);
    console.log(`  ${describeType(instanceType, info)}`);
  }

  // --- Advanced options -----------------------------------------------------
  const base: Omit<DeployConfig, 'region'> = { ...DEFAULTS, ...previous };
  const config: DeployConfig = { ...base, region, stackName, instanceType, llmProvider, bedrockModel, network };

  if (await confirm({ message: `¿Modificar opciones avanzadas (disco: ${base.volumeSizeGiB} GiB)?`, default: false })) {
    config.volumeSizeGiB =
      (await number({ message: 'Tamaño del disco (GiB)', default: base.volumeSizeGiB, min: 20, max: 16384, required: true })) ??
      base.volumeSizeGiB;
  }

  // --- Preflight ------------------------------------------------------------
  console.log('\nVerificando el destino...');
  const cfn = new CloudFormationClient({ region });
  const existing = await findStack(cfn, config.stackName);

  if (previous && !sameEnv) {
    const oldStack = await findStack(new CloudFormationClient({ region: previous.region }), previous.stackName);
    if (oldStack) {
      console.log(
        `\n⚠ El stack "${previous.stackName}" sigue desplegado en ${previous.region}. Desplegar "${stackName}" en\n` +
          `  ${region} crea un entorno nuevo; el anterior sigue corriendo (y generando costos) hasta que lo borres.\n` +
          '  Los scripts del proyecto (connect, test-model, set-api-key) pasarán a apuntar al nuevo.',
      );
      if (!(await confirm({ message: '¿Continuar igualmente?', default: false }))) return cancel();
    }
  }
  if (existing && !sameEnv) {
    console.log(
      `\n⚠ Ya existe un stack "${stackName}" en ${region} que no corresponde a la configuración guardada.\n` +
        '  Desplegar lo va a modificar con esta configuración (puede reemplazar su instancia y su red).',
    );
    if (!(await confirm({ message: '¿Actualizar ese stack?', default: false }))) return cancel();
  }
  // Quotas only matter when this deploy creates the VPC; re-checked here
  // because usage may have changed while the menu was open.
  if (network.mode === 'new' && !existing) {
    const quotas = await checkNewVpcQuotas(region, network.privateSubnet);
    console.log(`\nCuotas para una VPC nueva en ${region}:\n${formatQuotas(quotas)}`);
    if (!quotas.every(quotaFits)) {
      return cancel(`No hay cupo para crear la VPC. Elegí una VPC existente, o pedí más cupo:\n${quotaIncreaseHints(quotas, region)}\n`);
    }
  }
  const networkChanged = previous && JSON.stringify(previous.network) !== JSON.stringify(network);
  if (existing && sameEnv && networkChanged) {
    console.log(
      `\n⚠ La red cambia (${describeNetwork(previous.network)} → ${describeNetwork(network)}).\n` +
        '  CloudFormation va a reemplazar la instancia: se pierde el workspace (hacé un snapshot del disco antes).',
    );
    if (!(await confirm({ message: '¿Desplegar igualmente?', default: false }))) return cancel();
  }
  if (existing && previous?.instanceType && previous.instanceType !== instanceType && sameEnv) {
    console.log(`\n⚠ Cambiar ${previous.instanceType} → ${instanceType} detiene y reinicia la instancia (el disco se conserva).`);
  }
  // The host is configured once, at creation: user data changes do not
  // replace the instance (that would wipe the workspace).
  const llmChanged =
    previous &&
    (previous.llmProvider !== config.llmProvider ||
      (config.llmProvider === 'bedrock' &&
        (previous.bedrockModel !== config.bedrockModel ||
          previous.bedrockInferenceProfile !== config.bedrockInferenceProfile)));
  if (existing && sameEnv && llmChanged) {
    console.log(
      '\n⚠ El proveedor o el modelo cambiaron, pero la instancia existente se configuró al crearse y no\n' +
        '  se va a reconfigurar sola. Para aplicarlo hay que recrearla: "npx cdk destroy" y volver a\n' +
        '  desplegar (se pierde el workspace; hacé un snapshot del disco antes).',
    );
    if (!(await confirm({ message: '¿Desplegar igualmente?', default: false }))) return cancel();
  }

  const needsBootstrap = !(await findStack(cfn, 'CDKToolkit'));
  if (needsBootstrap) {
    console.log(`\nLa región ${region} no tiene el bootstrap de CDK (stack CDKToolkit).`);
    if (!(await confirm({ message: `¿Ejecutar "cdk bootstrap aws://${account}/${region}"?`, default: true }))) {
      return cancel('Sin bootstrap no se puede desplegar.');
    }
  }

  // --- Summary and deploy ---------------------------------------------------
  console.log(`\n${existing ? 'Actualizando' : 'Creando'} el stack "${config.stackName}" en ${region}, cuenta ${account}:\n`);
  console.log(formatConfigRows(config).join('\n'));
  if (!(await confirm({ message: '¿Guardar la configuración y desplegar?', default: true }))) return cancel();

  saveDeployConfig(config);
  console.log(`\nConfiguración guardada en ${CONFIG_FILE}\n`);

  const env = { ...process.env, AWS_REGION: region, AWS_DEFAULT_REGION: region };
  if (needsBootstrap) run(['cdk', 'bootstrap', `aws://${account}/${region}`], env);
  run(['cdk', 'deploy', config.stackName], env);

  // --- After deploy ---------------------------------------------------------
  const outputs = (await findStack(cfn, config.stackName))?.Outputs ?? [];
  console.log(`\n✔ Deploy completado.\n\n${formatDeployConfig(config)}\n`);
  printOutputs(outputs);
  console.log(
    '\nPróximos pasos:\n' +
      (config.llmProvider === 'deepseek-api'
        ? '  scripts/set-api-key.sh   guardar la DEEPSEEK_API_KEY y reiniciar el servicio\n'
        : '') +
      '  scripts/test-model.sh    probar el modelo desde la instancia\n' +
      '  scripts/connect.sh       abrir el túnel y obtener la URL de la Web UI\n' +
      '  npm run show-config      volver a ver esta configuración',
  );
}

async function getAccount(region: string): Promise<string> {
  try {
    const id = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
    return id.Account!;
  } catch (e) {
    throw new Error(`No se pudieron validar las credenciales de AWS: ${(e as Error).message}\nConfigurá la AWS CLI (aws configure / aws sso login) y reintentá.`);
  }
}

async function listRegions(region: string): Promise<string[]> {
  const res = await new EC2Client({ region }).send(new DescribeRegionsCommand({}));
  return (res.Regions ?? []).map((r) => r.RegionName!).sort();
}

/** Supported DeepSeek models that Bedrock serves on demand in the region. */
async function listBedrockModels(region: string): Promise<string[]> {
  try {
    const res = await new BedrockClient({ region }).send(new ListFoundationModelsCommand({ byProvider: 'DeepSeek' }));
    const ids = new Set(
      (res.modelSummaries ?? [])
        .filter((m) => m.inferenceTypesSupported?.includes('ON_DEMAND'))
        .map((m) => m.modelId!),
    );
    return Object.keys(BEDROCK_MODELS).filter((id) => ids.has(id));
  } catch (e) {
    // Missing permissions must not look like "no models here".
    if ((e as Error).name === 'AccessDeniedException') {
      throw new Error(`Sin permiso para listar modelos de Bedrock (bedrock:ListFoundationModels): ${(e as Error).message}`);
    }
    // Bedrock is not offered at all in some regions.
    return [];
  }
}

/**
 * Asks where to deploy: a new VPC (only offered when the quotas allow it) or
 * an existing VPC and one of its subnets with internet egress. Returns
 * undefined when no option is usable.
 */
async function chooseNetwork(
  ec2: EC2Client,
  region: string,
  previous: NetworkConfig | undefined,
  stackExisted: boolean,
): Promise<NetworkConfig | undefined> {
  process.stdout.write('Consultando VPCs y cuotas... ');
  const vpcs = await discoverVpcs(ec2);
  // An already deployed stack reuses the VPC it created: nothing new to fit.
  const reusesOwnVpc = stackExisted && previous?.mode === 'new';
  const quotas = {
    public: reusesOwnVpc ? [] : await checkNewVpcQuotas(region, false),
    private: reusesOwnVpc ? [] : await checkNewVpcQuotas(region, true),
  };
  console.log(`${vpcs.length} VPCs en ${region}.`);

  const usable = (v: VpcInfo) => v.subnets.filter((s) => s.kind !== 'isolated');
  const canCreate = quotas.public.every(quotaFits);
  const vpcChoices = vpcs.map((v) => {
    const pub = v.subnets.filter((s) => s.kind === 'public').length;
    const priv = v.subnets.filter((s) => s.kind === 'private').length;
    const label = [v.vpcId, v.name && `"${v.name}"`, v.isDefault && '(default)', v.cidr].filter(Boolean).join(' ');
    return {
      value: v.vpcId,
      name: `${label} · ${pub} públicas, ${priv} privadas`,
      disabled: usable(v).length ? false : 'sin subredes con salida a internet',
    };
  });

  if (!canCreate) console.log(`\nNo hay cupo para una VPC nueva:\n${formatQuotas(quotas.public)}\n`);
  if (!canCreate && !vpcChoices.some((c) => !c.disabled)) {
    console.log(
      'Tampoco hay VPCs existentes con salida a internet. Pedí más cupo o usá otra región:\n' +
        quotaIncreaseHints(quotas.public, region),
    );
    return undefined;
  }

  const enabled = new Set([...(canCreate ? ['new'] : []), ...vpcChoices.filter((c) => !c.disabled).map((c) => c.value)]);
  const defaultVpc = vpcs.find((v) => v.isDefault && usable(v).length)?.vpcId;
  const preferred = previous?.mode === 'existing' ? previous.vpcId : previous?.mode === 'new' ? 'new' : canCreate ? 'new' : defaultVpc;
  const choice = await select({
    message: 'Red',
    choices: [
      {
        value: 'new',
        name: 'Crear una VPC nueva para este entorno',
        disabled: canCreate ? false : 'sin cupo de VPCs o internet gateways',
      },
      ...vpcChoices,
    ],
    default: preferred && enabled.has(preferred) ? preferred : [...enabled][0],
    pageSize: 12,
  });

  if (choice === 'new') {
    for (;;) {
      const privateSubnet = await confirm({
        message: '¿Subred privada con NAT Gateway? (~32 USD/mes extra)',
        default: previous?.mode === 'new' ? previous.privateSubnet : false,
      });
      if (!privateSubnet || quotas.private.every(quotaFits)) return { mode: 'new', privateSubnet };
      console.log(`\nNo hay cupo para el NAT Gateway:\n${formatQuotas(quotas.private)}\n`);
    }
  }

  const vpc = vpcs.find((v) => v.vpcId === choice)!;
  const subnets = usable(vpc);
  const subnetId = await select({
    message: 'Subred',
    choices: subnets.map((s) => ({
      value: s.subnetId,
      name: [s.subnetId, s.availabilityZone, s.kind === 'public' ? 'pública' : 'privada', s.cidr, s.name && `"${s.name}"`]
        .filter(Boolean)
        .join('  '),
    })),
    default: previous?.mode === 'existing' && subnets.some((s) => s.subnetId === previous.subnetId) ? previous.subnetId : undefined,
  });
  const subnet = subnets.find((s) => s.subnetId === subnetId)!;
  return {
    mode: 'existing',
    vpcId: vpc.vpcId,
    subnetId,
    availabilityZone: subnet.availabilityZone,
    subnetType: subnet.kind as 'public' | 'private',
  };
}

async function listOfferedTypes(ec2: EC2Client, availabilityZone?: string): Promise<Set<string>> {
  const types = new Set<string>();
  const query = availabilityZone
    ? { LocationType: 'availability-zone' as const, Filters: [{ Name: 'location', Values: [availabilityZone] }] }
    : { LocationType: 'region' as const };
  for await (const page of paginateDescribeInstanceTypeOfferings({ client: ec2 }, query)) {
    for (const o of page.InstanceTypeOfferings ?? []) types.add(o.InstanceType!);
  }
  return types;
}

async function describeTypes(ec2: EC2Client, types: string[]): Promise<Map<string, InstanceTypeInfo>> {
  if (!types.length) return new Map();
  const res = await ec2.send(new DescribeInstanceTypesCommand({ InstanceTypes: types as never }));
  return new Map((res.InstanceTypes ?? []).map((t) => [t.InstanceType as string, t]));
}

function describeType(type: string, info?: InstanceTypeInfo): string {
  if (!info) return type;
  const vcpu = info.VCpuInfo?.DefaultVCpus;
  const mem = (info.MemoryInfo?.SizeInMiB ?? 0) / 1024;
  const arch = info.ProcessorInfo?.SupportedArchitectures?.includes('arm64') ? 'ARM/Graviton' : 'x86';
  return `${type.padEnd(12)} ${vcpu} vCPU · ${mem} GiB · ${arch}`;
}

async function findStack(cfn: CloudFormationClient, stackName: string) {
  try {
    const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = res.Stacks?.[0];
    // A stack whose creation failed and rolled back holds no resources, and
    // `cdk deploy` deletes it before creating it again: treat it as absent.
    const gone = ['DELETE_COMPLETE', 'ROLLBACK_COMPLETE'];
    return stack && !gone.includes(stack.StackStatus!) ? stack : undefined;
  } catch (e) {
    if ((e as Error).message?.includes('does not exist')) return undefined;
    throw e;
  }
}

function printOutputs(outputs: Output[]): void {
  if (!outputs.length) return;
  console.log('Outputs del stack:');
  for (const o of outputs) console.log(`  ${o.OutputKey}: ${o.OutputValue}`);
}

function run(args: string[], env: NodeJS.ProcessEnv): void {
  console.log(`$ npx ${args.join(' ')}`);
  const res = spawnSync('npx', args, { stdio: 'inherit', env });
  if (res.status !== 0) {
    throw new Error(`"npx ${args.join(' ')}" falló (código ${res.status}). La configuración quedó guardada; corregí y reintentá con "npm run deploy".`);
  }
}

function cancel(reason = 'Cancelado.'): void {
  console.log(`\n${reason} No se guardó ni desplegó nada.`);
  process.exitCode = 1;
}

main().catch((e: Error) => {
  if (e.name === 'ExitPromptError') return cancel();
  console.error(`\n✖ ${e.message}`);
  process.exitCode = 1;
});
