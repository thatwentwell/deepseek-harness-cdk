// Network discovery and quota checks used by the deploy menu.
import {
  DescribeAddressesCommand,
  EC2Client,
  RouteTable,
  Tag,
  paginateDescribeInternetGateways,
  paginateDescribeRouteTables,
  paginateDescribeSubnets,
  paginateDescribeVpcs,
} from '@aws-sdk/client-ec2';
import { GetAWSDefaultServiceQuotaCommand, GetServiceQuotaCommand, ServiceQuotasClient } from '@aws-sdk/client-service-quotas';

/** `public`: default route to an internet gateway; `private`: to a NAT or another egress hop; `isolated`: none. */
export type SubnetKind = 'public' | 'private' | 'isolated';

export interface SubnetInfo {
  subnetId: string;
  vpcId: string;
  availabilityZone: string;
  cidr: string;
  name?: string;
  kind: SubnetKind;
}

export interface VpcInfo {
  vpcId: string;
  name?: string;
  cidr: string;
  isDefault: boolean;
  subnets: SubnetInfo[];
}

const nameTag = (tags?: Tag[]) => tags?.find((t) => t.Key === 'Name')?.Value;

/** Lists the region's VPCs with every subnet classified by its effective route table. */
export async function discoverVpcs(ec2: EC2Client): Promise<VpcInfo[]> {
  const vpcs: VpcInfo[] = [];
  for await (const page of paginateDescribeVpcs({ client: ec2 }, {})) {
    for (const v of page.Vpcs ?? []) {
      vpcs.push({ vpcId: v.VpcId!, name: nameTag(v.Tags), cidr: v.CidrBlock ?? '', isDefault: !!v.IsDefault, subnets: [] });
    }
  }

  // A subnet uses its explicitly associated route table, or else its VPC's main one.
  const explicit = new Map<string, RouteTable>();
  const main = new Map<string, RouteTable>();
  for await (const page of paginateDescribeRouteTables({ client: ec2 }, {})) {
    for (const rt of page.RouteTables ?? []) {
      for (const a of rt.Associations ?? []) {
        if (a.Main) main.set(rt.VpcId!, rt);
        if (a.SubnetId) explicit.set(a.SubnetId, rt);
      }
    }
  }

  const byVpc = new Map(vpcs.map((v) => [v.vpcId, v]));
  for await (const page of paginateDescribeSubnets({ client: ec2 }, {})) {
    for (const s of page.Subnets ?? []) {
      const vpc = byVpc.get(s.VpcId!);
      if (!vpc) continue;
      vpc.subnets.push({
        subnetId: s.SubnetId!,
        vpcId: s.VpcId!,
        availabilityZone: s.AvailabilityZone!,
        cidr: s.CidrBlock ?? '',
        name: nameTag(s.Tags),
        kind: classify(explicit.get(s.SubnetId!) ?? main.get(s.VpcId!)),
      });
    }
  }
  for (const v of vpcs) v.subnets.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.availabilityZone.localeCompare(b.availabilityZone));
  return vpcs.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.vpcId.localeCompare(b.vpcId));
}

function classify(rt?: RouteTable): SubnetKind {
  const route = rt?.Routes?.find((r) => r.DestinationCidrBlock === '0.0.0.0/0' && r.State !== 'blackhole');
  if (!route) return 'isolated';
  if (route.GatewayId?.startsWith('igw-')) return 'public';
  if (route.NatGatewayId || route.TransitGatewayId || route.NetworkInterfaceId || route.InstanceId) return 'private';
  return 'isolated';
}

const kindOrder = (k: SubnetKind) => ({ public: 0, private: 1, isolated: 2 })[k];

export interface QuotaCheck {
  label: string;
  used: number;
  limit: number;
  /** How many more this deployment needs. */
  needed: number;
  /** `account`: the applied quota; `default`: AWS default (applied value unavailable). */
  source: 'account' | 'default';
}

export const quotaFits = (q: QuotaCheck) => q.used + q.needed <= q.limit;

/** Usage versus quota for what a new VPC needs (plus a NAT's Elastic IP when private). */
export async function checkNewVpcQuotas(region: string, privateSubnet: boolean): Promise<QuotaCheck[]> {
  const ec2 = new EC2Client({ region });
  const sq = new ServiceQuotasClient({ region });

  let vpcs = 0;
  for await (const page of paginateDescribeVpcs({ client: ec2 }, {})) vpcs += page.Vpcs?.length ?? 0;
  let igws = 0;
  for await (const page of paginateDescribeInternetGateways({ client: ec2 }, {})) igws += page.InternetGateways?.length ?? 0;

  const checks: QuotaCheck[] = [
    { label: 'VPCs', used: vpcs, needed: 1, ...(await quota(sq, 'vpc', 'L-F678F1CE', 5)) },
    { label: 'Internet gateways', used: igws, needed: 1, ...(await quota(sq, 'vpc', 'L-A4707A72', 5)) },
  ];
  if (privateSubnet) {
    const eips = (await ec2.send(new DescribeAddressesCommand({}))).Addresses?.length ?? 0;
    checks.push({ label: 'IPs elásticas (NAT)', used: eips, needed: 1, ...(await quota(sq, 'ec2', 'L-0263D0A3', 5)) });
  }
  return checks;
}

async function quota(
  sq: ServiceQuotasClient,
  serviceCode: string,
  quotaCode: string,
  fallback: number,
): Promise<Pick<QuotaCheck, 'limit' | 'source'>> {
  try {
    const res = await sq.send(new GetServiceQuotaCommand({ ServiceCode: serviceCode, QuotaCode: quotaCode }));
    if (res.Quota?.Value !== undefined) return { limit: res.Quota.Value, source: 'account' };
  } catch {
    // Not applied in this account (or no permission): fall back to the default.
  }
  try {
    const res = await sq.send(new GetAWSDefaultServiceQuotaCommand({ ServiceCode: serviceCode, QuotaCode: quotaCode }));
    if (res.Quota?.Value !== undefined) return { limit: res.Quota.Value, source: 'default' };
  } catch {
    // No Service Quotas access at all.
  }
  return { limit: fallback, source: 'default' };
}

export function formatQuotas(checks: QuotaCheck[]): string {
  return checks
    .map((q) => {
      const mark = quotaFits(q) ? '✔' : '✖';
      const note = q.source === 'default' ? ' (cuota por defecto de AWS)' : '';
      return `  ${mark} ${q.label}: ${q.used}/${q.limit} usadas, hace falta ${q.needed}${note}`;
    })
    .join('\n');
}

/** CLI commands to raise the quotas that do not fit. */
export function quotaIncreaseHints(checks: QuotaCheck[], region: string): string {
  const codes: Record<string, [string, string]> = {
    VPCs: ['vpc', 'L-F678F1CE'],
    'Internet gateways': ['vpc', 'L-A4707A72'],
    'IPs elásticas (NAT)': ['ec2', 'L-0263D0A3'],
  };
  return checks
    .filter((q) => !quotaFits(q))
    .map((q) => {
      const [service, code] = codes[q.label];
      return `  aws service-quotas request-service-quota-increase --region ${region} --service-code ${service} --quota-code ${code} --desired-value ${q.limit + 5}`;
    })
    .join('\n');
}
