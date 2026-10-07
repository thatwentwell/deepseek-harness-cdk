// Interactive deploy: `npm run deploy`.
// Asks for region and instance type (plus optional advanced settings), checks
// the target account/region, writes deploy.config.json and runs `cdk deploy`.
// The config file is only written after the summary is confirmed.
import { spawnSync } from 'child_process';
import { confirm, input, number, search, select } from '@inquirer/prompts';
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
  CONFIG_FILE,
  DEFAULTS,
  DeployConfig,
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

  // --- Region ---------------------------------------------------------------
  const regions = await listRegions(homeRegion ?? 'us-east-1');
  const region = await select({
    message: 'Región de destino',
    choices: regions.map((r) => ({ value: r, name: REGION_NAMES[r] ? `${r}  (${REGION_NAMES[r]})` : r })),
    default: previous?.region ?? homeRegion ?? 'us-east-1',
    pageSize: 15,
  });

  // --- Instance type --------------------------------------------------------
  process.stdout.write('Consultando tipos de instancia disponibles... ');
  const ec2 = new EC2Client({ region });
  const offered = await listOfferedTypes(ec2);
  console.log(`${offered.size} disponibles en ${region}.`);

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
  const config: DeployConfig = { ...base, region, instanceType };

  if (await confirm({ message: '¿Modificar opciones avanzadas (nombre del stack, disco, subred privada)?', default: false })) {
    config.stackName = await input({
      message: 'Nombre del stack',
      default: base.stackName,
      validate: (v) => /^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(v) || 'Letras, números y guiones; debe empezar con letra',
    });
    config.volumeSizeGiB =
      (await number({ message: 'Tamaño del disco (GiB)', default: base.volumeSizeGiB, min: 20, max: 16384, required: true })) ??
      base.volumeSizeGiB;
    config.privateSubnet = await confirm({
      message: '¿Subred privada con NAT Gateway? (~32 USD/mes extra)',
      default: base.privateSubnet,
    });
  }

  // --- Preflight ------------------------------------------------------------
  console.log('\nVerificando el destino...');
  const cfn = new CloudFormationClient({ region });
  const existing = await findStack(cfn, config.stackName);

  if (previous && previous.region !== region) {
    const oldStack = await findStack(new CloudFormationClient({ region: previous.region }), previous.stackName);
    if (oldStack) {
      console.log(
        `\n⚠ El stack "${previous.stackName}" ya existe en ${previous.region}. Desplegar en ${region} crea un\n` +
          '  entorno nuevo; el anterior sigue corriendo (y generando costos) hasta que lo borres.\n' +
          '  Los scripts set-api-key/connect pasarán a apuntar al nuevo.',
      );
      if (!(await confirm({ message: '¿Continuar igualmente?', default: false }))) return cancel();
    }
  }
  if (existing && previous?.instanceType && previous.instanceType !== instanceType && previous.region === region) {
    console.log(`\n⚠ Cambiar ${previous.instanceType} → ${instanceType} detiene y reinicia la instancia (el disco se conserva).`);
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
      '  scripts/set-api-key.sh   guardar la DEEPSEEK_API_KEY y reiniciar el servicio\n' +
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

async function listOfferedTypes(ec2: EC2Client): Promise<Set<string>> {
  const types = new Set<string>();
  for await (const page of paginateDescribeInstanceTypeOfferings({ client: ec2 }, { LocationType: 'region' })) {
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
    return stack && stack.StackStatus !== 'DELETE_COMPLETE' ? stack : undefined;
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
