import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface DeepseekHarnessStackProps extends cdk.StackProps {
  /** EC2 instance type. Graviton (t4g/m7g) and x86 are both supported. */
  readonly instanceType: string;
  /** Version of the @deepseek-ai/dsh npm package to install. */
  readonly dshVersion: string;
  /** Node.js major version to install. */
  readonly nodeMajor: number;
  /** Port the Web UI listens on (always bound to 127.0.0.1 on the instance). */
  readonly webPort: number;
  /** Root EBS volume size in GiB (holds the workspace and ~/.dsh). */
  readonly volumeSizeGiB: number;
  /** Put the instance in a private subnet behind a NAT gateway (extra cost). */
  readonly privateSubnet: boolean;
  /** Import this VPC instead of creating one (requires an explicit env). */
  readonly vpcId?: string;
  /** Use an existing Secrets Manager secret that holds DEEPSEEK_API_KEY. */
  readonly existingSecretArn?: string;
  /**
   * Block the agent's OS user from reaching the instance metadata service,
   * so commands the agent runs cannot use the instance role's credentials.
   */
  readonly blockImdsForAgent: boolean;
}

export class DeepseekHarnessStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DeepseekHarnessStackProps) {
    super(scope, id, props);

    const vpc = props.vpcId
      ? ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId })
      : new ec2.Vpc(this, 'Vpc', {
          maxAzs: 2,
          natGateways: props.privateSubnet ? 1 : 0,
          subnetConfiguration: [
            { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
            ...(props.privateSubnet
              ? [{ name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 }]
              : []),
          ],
        });

    // The API key never lives in the template: the placeholder is replaced
    // after deploy with `scripts/set-api-key.sh` (or put-secret-value).
    const apiKeySecret = props.existingSecretArn
      ? secretsmanager.Secret.fromSecretCompleteArn(this, 'ApiKey', props.existingSecretArn)
      : new secretsmanager.Secret(this, 'ApiKey', {
          description: 'DEEPSEEK_API_KEY for DeepSeek Harness',
          secretStringValue: cdk.SecretValue.unsafePlainText('REPLACE_ME'),
        });

    // No ingress at all: the Web UI only listens on loopback and is reached
    // through SSM Session Manager port forwarding.
    const securityGroup = new ec2.SecurityGroup(this, 'InstanceSg', {
      vpc,
      description: 'DeepSeek Harness host - egress only',
      allowAllOutbound: true,
    });

    const instanceType = new ec2.InstanceType(props.instanceType);
    const cpuType =
      instanceType.architecture === ec2.InstanceArchitecture.ARM_64
        ? ec2.AmazonLinuxCpuType.ARM_64
        : ec2.AmazonLinuxCpuType.X86_64;

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      `export SECRET_ARN='${apiKeySecret.secretArn}'`,
      `export DSH_VERSION='${props.dshVersion}'`,
      `export NODE_MAJOR='${props.nodeMajor}'`,
      `export WEB_PORT='${props.webPort}'`,
      `export BLOCK_IMDS='${props.blockImdsForAgent}'`,
      fs.readFileSync(path.join(__dirname, '..', 'assets', 'bootstrap.sh'), 'utf8'),
    );

    const instance = new ec2.Instance(this, 'Host', {
      vpc,
      vpcSubnets: {
        subnetType: props.privateSubnet ? ec2.SubnetType.PRIVATE_WITH_EGRESS : ec2.SubnetType.PUBLIC,
      },
      associatePublicIpAddress: props.privateSubnet ? undefined : true,
      instanceType,
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType }),
      securityGroup,
      userData,
      requireImdsv2: true,
      // Instance tags are not inherited by EBS volumes otherwise, which would
      // leave the disk out of tag-based cost reports and budgets.
      propagateTagsToVolumeOnCreation: true,
      ssmSessionPermissions: true,
      resourceSignalTimeout: cdk.Duration.minutes(20),
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(props.volumeSizeGiB, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    });
    // Install aws-cfn-bootstrap first in bootstrap.sh; this trap reports the
    // script's exit code so `cdk deploy` fails if provisioning fails.
    userData.addSignalOnExitCommand(instance);

    apiKeySecret.grantRead(instance.role);

    // Cost allocation tags (see doc/budgets.md): `app` groups every
    // deployment, `stack` tells apart several deployments in one account.
    cdk.Tags.of(this).add('app', 'deepseek-harness');
    cdk.Tags.of(this).add('stack', this.stackName);

    new cdk.CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new cdk.CfnOutput(this, 'ApiKeySecretArn', { value: apiKeySecret.secretArn });
    new cdk.CfnOutput(this, 'WebPort', { value: String(props.webPort) });
    new cdk.CfnOutput(this, 'PortForwardCommand', {
      value:
        `aws ssm start-session --region ${this.region} --target ${instance.instanceId} ` +
        `--document-name AWS-StartPortForwardingSession ` +
        `--parameters portNumber=${props.webPort},localPortNumber=${props.webPort}`,
    });
  }
}
