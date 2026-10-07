import { EC2Client } from '@aws-sdk/client-ec2';
import { discoverVpcs, quotaFits, quotaIncreaseHints } from '../scripts/aws-network';

/** An EC2 client whose API calls return canned responses by command name. */
function fakeEc2(responses: Record<string, object>): EC2Client {
  const client = new EC2Client({ region: 'us-east-1' });
  client.send = (async (command: object) => responses[command.constructor.name] ?? {}) as EC2Client['send'];
  return client;
}

test('classifies subnets by their effective route table', async () => {
  const ec2 = fakeEc2({
    DescribeVpcsCommand: { Vpcs: [{ VpcId: 'vpc-1', CidrBlock: '10.0.0.0/16', IsDefault: true, Tags: [{ Key: 'Name', Value: 'main' }] }] },
    DescribeRouteTablesCommand: {
      RouteTables: [
        // Main table: default route through a NAT, inherited by unassociated subnets.
        { VpcId: 'vpc-1', Associations: [{ Main: true }], Routes: [{ DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: 'nat-1' }] },
        { VpcId: 'vpc-1', Associations: [{ SubnetId: 'subnet-pub' }], Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-1' }] },
        { VpcId: 'vpc-1', Associations: [{ SubnetId: 'subnet-iso' }], Routes: [{ DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'local' }] },
        {
          VpcId: 'vpc-1',
          Associations: [{ SubnetId: 'subnet-dead' }],
          Routes: [{ DestinationCidrBlock: '0.0.0.0/0', GatewayId: 'igw-old', State: 'blackhole' }],
        },
      ],
    },
    DescribeSubnetsCommand: {
      Subnets: [
        { SubnetId: 'subnet-iso', VpcId: 'vpc-1', AvailabilityZone: 'us-east-1a' },
        { SubnetId: 'subnet-priv', VpcId: 'vpc-1', AvailabilityZone: 'us-east-1a' },
        { SubnetId: 'subnet-pub', VpcId: 'vpc-1', AvailabilityZone: 'us-east-1b' },
        { SubnetId: 'subnet-dead', VpcId: 'vpc-1', AvailabilityZone: 'us-east-1c' },
      ],
    },
  });

  const [vpc] = await discoverVpcs(ec2);
  expect(vpc).toMatchObject({ vpcId: 'vpc-1', name: 'main', isDefault: true });
  expect(vpc.subnets.map((s) => [s.subnetId, s.kind])).toEqual([
    ['subnet-pub', 'public'],
    ['subnet-priv', 'private'],
    ['subnet-iso', 'isolated'],
    ['subnet-dead', 'isolated'],
  ]);
});

test('quota hints list only the quotas that do not fit', () => {
  const checks = [
    { label: 'VPCs', used: 5, limit: 5, needed: 1, source: 'account' as const },
    { label: 'Internet gateways', used: 3, limit: 5, needed: 1, source: 'account' as const },
  ];
  expect(checks.map(quotaFits)).toEqual([false, true]);
  const hints = quotaIncreaseHints(checks, 'sa-east-1');
  expect(hints).toContain('--region sa-east-1 --service-code vpc --quota-code L-F678F1CE --desired-value 10');
  expect(hints).not.toContain('L-A4707A72');
});
