import { Annotations } from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/** Where the host lives: a VPC this stack creates, or one that already exists. */
export type NetworkConfig =
  | {
      mode: 'new';
      /** Private subnet behind a NAT gateway (extra cost) instead of a public one. */
      privateSubnet: boolean;
    }
  | {
      mode: 'existing';
      vpcId: string;
      subnetId: string;
      availabilityZone: string;
      /** `public`: routes 0.0.0.0/0 to an internet gateway; `private`: to a NAT. */
      subnetType: 'public' | 'private';
    };

/**
 * The host's network. Everything else in the stack only needs `vpc` and
 * `subnets`, so swapping a created VPC for an imported one changes nothing
 * outside this construct.
 */
export class HarnessNetwork extends Construct {
  readonly vpc: ec2.IVpc;
  readonly subnets: ec2.SubnetSelection;
  /** Whether the host needs a public IP to reach the internet. */
  readonly publicIp: boolean;

  constructor(scope: Construct, id: string, config: NetworkConfig) {
    super(scope, id);

    if (config.mode === 'existing') {
      // Imported from attributes rather than looked up, so synthesis needs no
      // AWS calls and writes no account data to cdk.context.json. The deploy
      // menu resolves (and validates) these values.
      const publicSubnet = config.subnetType === 'public';
      this.vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
        vpcId: config.vpcId,
        availabilityZones: [config.availabilityZone],
        ...(publicSubnet ? { publicSubnetIds: [config.subnetId] } : { privateSubnetIds: [config.subnetId] }),
      });
      // Nothing here reads the subnet's route table, so its ID is not needed.
      Annotations.of(this).acknowledgeWarning(
        '@aws-cdk/aws-ec2:noSubnetRouteTableId',
        'The host only needs the subnet; route tables are not referenced',
      );
      // The imported VPC holds only the chosen subnet, so selecting by type
      // picks exactly that one (and lets ec2.Instance assign a public IP).
      this.subnets = { subnetType: publicSubnet ? ec2.SubnetType.PUBLIC : ec2.SubnetType.PRIVATE_WITH_EGRESS };
      this.publicIp = publicSubnet;
      return;
    }

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: config.privateSubnet ? 1 : 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        ...(config.privateSubnet
          ? [{ name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 }]
          : []),
      ],
    });
    this.subnets = {
      subnetType: config.privateSubnet ? ec2.SubnetType.PRIVATE_WITH_EGRESS : ec2.SubnetType.PUBLIC,
    };
    this.publicIp = !config.privateSubnet;
  }
}
